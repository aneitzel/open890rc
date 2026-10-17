// Package spe talks to an SPE Expert HF power amplifier (1.3K/1.5K/2K-FA)
// over its serial port. Protocol details are taken from
// github.com/vu2cpl/macexpert-spe (SPEProtocol.swift, SerialConnection.swift),
// not from the official SPE programmer's guide, and have not yet been
// verified against real hardware by us.
//
// Wire format, host -> amp: 0x55 0x55 0x55 <count> <data...> <checksum>, for
// the single-byte commands used here count=1 and checksum=the command byte.
// Amp -> host status frame: 0xAA 0xAA 0xAA 0x43 followed by a 67-byte ASCII
// CSV record.
package spe

import (
	"bytes"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.bug.st/serial"
)

const (
	DefaultBaud = 115200

	cmdPowerOff = 0x0A
	cmdPowerLvl = 0x0B // cycles LOW -> MID -> HIGH
	cmdTune     = 0x09 // ATU tune
	cmdRCUOn    = 0x80 // remote-control-unit mode: amp streams its LCD frames
	cmdRCUOff   = 0x81
	cmdOperate  = 0x0D // toggles STANDBY <-> OPERATE
	cmdStatus   = 0x90

	statusLen    = 0x43
	pollInterval = 200 * time.Millisecond // tick; idle polls only every idlePoll
	idlePoll     = time.Second
	// An amp that is switched off never answers, so "on" means "a status
	// frame arrived recently".
	aliveTimeout = 3 * time.Second
)

// Status is the subset of the amp's CSV status record the UI uses.
type Status struct {
	On      bool    // amp is powered and answering
	Operate bool    // true = OPERATE, false = STANDBY
	TX      bool    // amp is keyed
	Level   string  // "L", "M" or "H"
	Model   string  // CSV model id, e.g. "13K", "15K", "20K"
	PowerW  float64 // output power in watts
	SWR     float64 // SWR at the ATU (the amp's own tuner input)
	Warning string  // decoded warning text, "" if none
	Alarm   string  // decoded alarm text, "" if none
}

// Code tables from MacExpert's SPEProtocol.swift (CSV warning/alarm fields);
// "N" means nothing active.
var warningTexts = map[string]string{
	"M": "ALARM AMPLIFIER",
	"A": "NO SELECTED ANTENNA",
	"S": "SWR ANTENNA",
	"B": "NO VALID BAND",
	"P": "POWER LIMIT EXCEEDED",
	"O": "OVERHEATING",
	"Y": "ATU NOT AVAILABLE",
	"W": "TUNING WITH NO POWER",
	"K": "ATU BYPASSED",
	"R": "POWER SWITCH HELD BY REMOTE",
	"T": "COMBINER OVERHEATING",
	"C": "COMBINER FAULT",
}

var alarmTexts = map[string]string{
	"S": "SWR EXCEEDING LIMITS",
	"A": "AMPLIFIER PROTECTION",
	"D": "INPUT OVERDRIVING",
	"H": "EXCESS OVERHEATING",
	"C": "COMBINER FAULT",
}

// Amp is an open serial connection to the amplifier.
type Amp struct {
	port     serial.Port
	onChange func(Status)

	wmu sync.Mutex // serializes writes (poll ticker vs. browser command)

	mu       sync.Mutex
	status   Status
	lastSeen time.Time

	paused   atomic.Bool  // status polling switched off (radio off): the amp then counts as silent
	rcuMode  atomic.Bool  // status polling paused, LCD frames expected
	tuneLED  atomic.Bool  // last RCU frame said the front-panel TUNE LED is on
	rcuFrame atomic.Int64 // unix ms of the last RCU frame

	done chan struct{}
	once sync.Once
}

// Open opens the serial port and starts polling. onChange is called whenever
// the visible status changes (including the amp going silent).
func Open(path string, baud int, onChange func(Status)) (*Amp, error) {
	p, err := serial.Open(path, &serial.Mode{
		BaudRate: baud,
		DataBits: 8,
		Parity:   serial.NoParity,
		StopBits: serial.OneStopBit,
	})
	if err != nil {
		return nil, err
	}
	a := &Amp{port: p, onChange: onChange, done: make(chan struct{})}
	go a.readLoop()
	go a.pollLoop()
	return a, nil
}

// Close stops polling and releases the port.
func (a *Amp) Close() {
	a.once.Do(func() {
		close(a.done)
		a.port.Close()
	})
}

func packet(cmd byte) []byte {
	return []byte{0x55, 0x55, 0x55, 0x01, cmd, cmd}
}

func (a *Amp) send(cmd byte) error {
	a.wmu.Lock()
	defer a.wmu.Unlock()
	_, err := a.port.Write(packet(cmd))
	return err
}

// Tune starts an ATU tuning cycle on the amp.
func (a *Amp) Tune() error { return a.send(cmdTune) }

// StartRCU switches the amp into RCU mode, in which it streams its LCD frames
// (the only place the TUNE LED state is visible). Status polling pauses until
// StopRCU.
func (a *Amp) StartRCU() error {
	a.rcuMode.Store(true)
	a.tuneLED.Store(false)
	a.rcuFrame.Store(0)
	return a.send(cmdRCUOn)
}

// RCUHeartbeat re-requests a fresh LCD frame (RCU off, short gap, on), as
// MacExpert does every 0.4s.
func (a *Amp) RCUHeartbeat() error {
	if err := a.send(cmdRCUOff); err != nil {
		return err
	}
	time.Sleep(60 * time.Millisecond)
	return a.send(cmdRCUOn)
}

// StopRCU leaves RCU mode and resumes status polling.
func (a *Amp) StopRCU() error {
	a.rcuMode.Store(false)
	return a.send(cmdRCUOff)
}

// TuneLED reports whether the TUNE LED is lit according to the newest RCU
// frame, and whether any RCU frame has arrived at all since StartRCU.
func (a *Amp) TuneLED() (on, seen bool) {
	return a.tuneLED.Load(), a.rcuFrame.Load() != 0
}

// ToggleOperate switches between STANDBY and OPERATE.
func (a *Amp) ToggleOperate() error { return a.send(cmdOperate) }

// CyclePowerLevel advances LOW -> MID -> HIGH -> LOW.
func (a *Amp) CyclePowerLevel() error { return a.send(cmdPowerLvl) }

// PowerOff switches the amp off.
func (a *Amp) PowerOff() error { return a.send(cmdPowerOff) }

// PowerOn wakes a switched-off amp by pulsing the serial control lines
// (sequence from MacExpert: DTR=1, DTR=0, RTS=1, 1s, DTR=1, RTS=0). The amp
// needs a few seconds afterwards before it answers status requests.
func (a *Amp) PowerOn() error {
	a.wmu.Lock()
	defer a.wmu.Unlock()
	steps := []func() error{
		func() error { return a.port.SetDTR(true) },
		func() error { return a.port.SetDTR(false) },
		func() error { return a.port.SetRTS(true) },
		func() error { time.Sleep(time.Second); return nil },
		func() error { return a.port.SetDTR(true) },
		func() error { return a.port.SetRTS(false) },
	}
	for _, step := range steps {
		if err := step(); err != nil {
			return fmt.Errorf("power-on sequence: %w", err)
		}
	}
	return nil
}

// SetPaused switches the status polling off (true) or on again. While paused
// the amp is not asked anything and, after the usual silence timeout, is
// reported as off.
func (a *Amp) SetPaused(p bool) { a.paused.Store(p) }

func (a *Amp) pollLoop() {
	t := time.NewTicker(pollInterval)
	defer t.Stop()
	var lastPoll time.Time
	for {
		select {
		case <-a.done:
			return
		case <-t.C:
			// Poll fast (every tick) while transmitting so the power/SWR bars
			// move, slowly otherwise.
			if a.rcuMode.Load() || a.paused.Load() {
				a.checkAlive()
				continue
			}
			a.mu.Lock()
			tx := a.status.TX
			a.mu.Unlock()
			if !tx && time.Since(lastPoll) < idlePoll {
				continue
			}
			lastPoll = time.Now()
			if err := a.send(cmdStatus); err != nil {
				select {
				case <-a.done:
				default:
					log.Printf("spe: status request failed: %v", err)
				}
			}
			a.checkAlive()
		}
	}
}

// checkAlive marks the amp as off once it has been silent too long.
func (a *Amp) checkAlive() {
	a.mu.Lock()
	changed := false
	if a.status.On && time.Since(a.lastSeen) > aliveTimeout {
		a.status = Status{}
		changed = true
	}
	st := a.status
	a.mu.Unlock()
	if changed {
		a.onChange(st)
	}
}

func (a *Amp) readLoop() {
	var buf []byte
	chunk := make([]byte, 256)
	for {
		n, err := a.port.Read(chunk)
		if err != nil {
			select {
			case <-a.done:
			default:
				log.Printf("spe: serial read failed: %v", err)
			}
			return
		}
		if n == 0 {
			continue
		}
		buf = append(buf, chunk[:n]...)
		var frames []frame
		frames, buf = extractFrames(buf)
		for _, f := range frames {
			if f.rcu {
				swr, swrOK := lcdSWR(f.payload)
				pwr, pwrOK := lcdPower(f.payload)
				if swrOK || pwrOK {
					a.mu.Lock()
					before := a.status
					if swrOK {
						a.status.SWR = swr
					}
					if pwrOK {
						a.status.PowerW = pwr
					}
					changed := a.status != before && a.status.On
					st := a.status
					a.mu.Unlock()
					if changed {
						a.onChange(st)
					}
				}
				if on, ok := tuneLEDOn(f.payload); ok {
					a.tuneLED.Store(on)
					a.rcuFrame.Store(time.Now().UnixMilli())
					a.mu.Lock()
					a.lastSeen = time.Now() // amp is clearly alive
					a.mu.Unlock()
				}
				continue
			}
			st, ok := parseStatus(f.payload)
			if !ok {
				continue
			}
			a.mu.Lock()
			changed := st != a.status
			a.status = st
			a.lastSeen = time.Now()
			a.mu.Unlock()
			if changed {
				a.onChange(st)
			}
		}
	}
}

var syncBytes = []byte{0xAA, 0xAA, 0xAA}

// frame is one frame cut from the serial stream.
type frame struct {
	rcu     bool   // LCD frame (type 0x6A) rather than CSV status
	payload []byte // CSV for status frames, bytes after the 0x6A marker for RCU
}

const maxBuffered = 4096

// extractFrames pulls every complete frame out of buf and returns the
// unconsumed remainder. Status frames are 0xAA 0xAA 0xAA 0x43 + 67 bytes. RCU
// frames are 0xAA 0xAA 0xAA 0x6A + payload up to the next sync (the 0x6A is a
// type marker, not a length — per MacExpert's RCUDisplayPacket).
func extractFrames(buf []byte) (frames []frame, rest []byte) {
	for {
		i := bytes.Index(buf, syncBytes)
		if i < 0 {
			// Keep a possible partial sync at the tail.
			if len(buf) > 2 {
				buf = buf[len(buf)-2:]
			}
			return frames, buf
		}
		buf = buf[i:]
		if len(buf) < 4 {
			return frames, buf
		}
		switch buf[3] {
		case statusLen:
			if len(buf) < 4+statusLen {
				return frames, buf
			}
			frames = append(frames, frame{payload: buf[4 : 4+statusLen]})
			buf = buf[4+statusLen:]
		case 0x6A:
			next := bytes.Index(buf[4:], syncBytes)
			if next < 0 {
				if len(buf) > maxBuffered {
					buf = buf[3:] // runaway, resync
					continue
				}
				return frames, buf
			}
			frames = append(frames, frame{rcu: true, payload: buf[4 : 4+next]})
			buf = buf[4+next:]
		default:
			buf = buf[3:] // unknown type, look for the next sync
		}
	}
}

// tuneLEDOn reads the TUNE LED from an RCU frame payload: byte 4 bit 6 is
// CLEARED while the LED is lit ("waiting for carrier" and "ATU sweeping").
// Layout from MacExpert's RCUFrame.swift; not verified by us on hardware.
func tuneLEDOn(payload []byte) (on, ok bool) {
	if len(payload) < 5 {
		return false, false
	}
	return payload[4]&0x40 == 0, true
}

// parseStatus reads the CSV record. Fields are located relative to the model
// field (e.g. "13K"/"15K"/"20K") rather than by absolute index, so a leading
// prefix field doesn't shift the result: model, operate(O/S), tx(T/R), bank,
// input, band, ant, rx-ant, level(L/M/H).
func parseStatus(payload []byte) (Status, bool) {
	fields := strings.Split(string(payload), ",")
	for i, f := range fields {
		f = strings.TrimSpace(f)
		if len(f) < 2 || f[len(f)-1] != 'K' || strings.Trim(f[:len(f)-1], "0123456789") != "" {
			continue
		}
		if i+8 >= len(fields) {
			return Status{}, false
		}
		level := strings.TrimSpace(fields[i+8])
		st := Status{
			On:      true,
			Operate: strings.TrimSpace(fields[i+1]) == "O",
			TX:      strings.TrimSpace(fields[i+2]) == "T",
			Level:   level,
		}
		st.Model = strings.TrimSpace(fields[i])
		// Output power (watts) at +9 and the SWR at the ATU (amp side of the
		// tuner) at +10; +11 would be the SWR at the antenna itself.
		if i+11 < len(fields) {
			if w, err := strconv.ParseFloat(strings.TrimSpace(fields[i+9]), 64); err == nil {
				st.PowerW = w
			}
			if v, err := strconv.ParseFloat(strings.TrimSpace(fields[i+10]), 64); err == nil {
				st.SWR = v
			}
		}
		// Warning and alarm codes sit at +17 and +18 from the model field.
		if i+18 < len(fields) {
			code := func(f string) string { return strings.TrimSpace(f) }
			if w := code(fields[i+17]); w != "" {
				st.Warning = warningTexts[w]
			}
			if a := code(fields[i+18]); a != "" {
				st.Alarm = alarmTexts[a]
			}
		}
		return st, true
	}
	return Status{}, false
}

// lcdSWR reads the SWR value the amp prints on its main screen (what its own
// display shows at the tuner) out of an RCU frame. Found from a captured
// frame: bytes 314-319 hold the glyphs of e.g. "1.05" — digits are 0x10-0x19,
// '.' is 0x0E, '-' is 0x0D (shown as "--.--" while idle), 0x00 is blank and
// 0x8F ends the field. ok is false for idle/blank/garbled values.
func lcdSWR(payload []byte) (swr float64, ok bool) {
	if len(payload) < 320 {
		return 0, false
	}
	var text []byte
	for _, b := range payload[314:319] {
		switch {
		case b >= 0x10 && b <= 0x19:
			text = append(text, '0'+b-0x10)
		case b == 0x0E:
			text = append(text, '.')
		case b == 0x00:
		default:
			return 0, false
		}
	}
	v, err := strconv.ParseFloat(string(text), 64)
	if err != nil || v < 1 {
		return 0, false
	}
	return v, true
}

// lcdGlyphs converts LCD number glyphs (digits 0x10-0x19, '.' 0x0E) to text;
// 0x00 is blank. ok is false on any other byte.
func lcdGlyphs(b []byte) (string, bool) {
	var text []byte
	for _, c := range b {
		switch {
		case c >= 0x10 && c <= 0x19:
			text = append(text, '0'+c-0x10)
		case c == 0x0E:
			text = append(text, '.')
		case c == 0x00:
		default:
			return "", false
		}
	}
	return string(text), true
}

// lcdPower reads the watt value on the amp's main screen (e.g. "9.6 W",
// bytes 112-117, 'W' follows) out of an RCU frame. During a tune this is the
// carrier the radio feeds it.
func lcdPower(payload []byte) (float64, bool) {
	if len(payload) < 120 {
		return 0, false
	}
	text, ok := lcdGlyphs(payload[112:118])
	if !ok || text == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}
