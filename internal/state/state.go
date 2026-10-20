// Package state holds the subset of TS-890 radio state the web UI cares
// about, kept up to date from raw CAT messages and safe for concurrent use.
package state

import (
	"slices"
	"sync"

	"open890rc/internal/cat"
)

// State is the in-memory radio state, updated by the radio connection and
// read by the web server to answer new clients and build broadcasts.
type State struct {
	mu sync.RWMutex

	radioHost     string
	radioPort     int
	radioVoipPort int
	radioUser     string
	radioAdmin    bool
	connected     bool
	// radioStandby: the radio answered PS with 0 (off/standby) or 2 (shutting
	// down) while the KNS session is still up.
	radioStandby bool

	vfoAHz             int
	vfoBHz             int
	mode               string
	activeReceiver     cat.VFO
	sMeter             int
	swrMeter           int
	alcMeter           int
	idMeter            int
	agc                string
	nr                 int
	nb1                bool
	nb2                bool
	rfGain             int
	squelch            int
	busy               bool
	tx                 bool
	bc                 int
	nr1Level           int
	nr2Tc              int
	nb1Level           int
	nb2Level           int
	nb2TypeB           bool
	nb2Depth           int
	nb2Width           int
	txEq               bool
	txEqEffect         int
	rxEq               bool
	rxEqEffect         int
	txEqBands          []int
	rxEqBands          []int
	txMonitor          bool
	txMonitorLevel     int
	proc               bool
	procType           bool // true = Hard, false = Soft (cat.ParseProcType, "PR1")
	procTypeKnown      bool
	antenna            cat.Antenna
	power              int
	micGain            int
	procLevels         cat.ProcLevels
	ifFilter           string
	filterWidthHz      map[string]int
	audioWidthByFilter map[string]int
	tuner              cat.TunerState
	ssbFilterMode      cat.FilterMode
	ssbDataFilterMode  cat.FilterMode
	loPassbandID       int
	hiPassbandID       int
	scopeSpanHz        int
	scopeRate          string
	rxAudioLost        uint64
	att                int
	pre                int
	ritOn              bool
	ritOffsetHz        int
	xitOn              bool

	// SPE Expert PA (internal/spe), optional.
	ampSavedPort    string // last port used (for prefilling the UI)
	ampAuto         bool
	knsAuto         bool
	knsMac          string
	voipAutoSync    bool // server resets the radio's VoIP stream every voipAutoSyncMin minutes
	voipAutoSyncMin int
	ampTxTimeout    int
	ampMaxPowerW    int    // transceiver PWR cap while the PA is on (0 before the first SetAmpMaxPower call)
	ampPort         string // serial port currently open, "" if none
	ampOn           bool
	ampOperate      bool
	ampTX           bool
	ampLevel        string
	ampWarning      string
	ampAlarm        string
	jitterMs        int
	voipInLevel     int
	voipOutLevel    int
	pitchHz         int
	apfOn           bool
	apfBwKnown      bool
	apfBw           int
	apfGainKnown    bool
	apfGain         int
	apfKnown        bool
	apfShiftHz      int
	msgID           [2]int // last pop-up message ID per source (ME0, ME1)
	ampTuning       bool
	ampModel        string
	ampPowerW       float64
	ampSWR          float64
}

// New creates a State with no radio connected yet; the browser's setup
// dialog supplies a target later via Controls.Connect.
func New() *State {
	return &State{filterWidthHz: make(map[string]int), audioWidthByFilter: make(map[string]int), scopeRate: "high"}
}

// SetRadioConnection records which radio a connection attempt targets,
// included in every Snapshot so the setup overlay can prefill itself with the
// server's currently active connection (e.g. from CLI flags) instead of
// showing blank fields on a browser that never saved its own config yet.
// Deliberately excludes the password — unlike host/port/voipPort/user/admin,
// that would otherwise get broadcast to every connected client just for
// having the page open, not only one that actually opens the setup overlay.
func (s *State) SetRadioConnection(host string, port int, voipPort int, user string, admin bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.radioHost = host
	s.radioPort = port
	s.radioVoipPort = voipPort
	s.radioUser = user
	s.radioAdmin = admin
}

// SetConnected records whether the KNS connection to the radio is currently
// up, so the UI can tell "never configured" and "configured but the radio
// dropped" apart from a healthy connection.
func (s *State) SetConnected(connected bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.connected = connected
	s.radioStandby = false
	s.msgID = [2]int{}
	s.jitterMs = 0
	s.voipInLevel, s.voipOutLevel = 0, 0
	s.pitchHz = 0
	s.apfKnown, s.apfShiftHz, s.apfOn = false, 0, false
	s.apfBwKnown, s.apfBw, s.apfGainKnown, s.apfGain = false, 0, false, 0
}

// radioMessage is the text for the current pop-up message; ME1 has priority
// over ME0. Caller holds s.mu.
func (s *State) radioMessage() string {
	if s.msgID[1] != 0 {
		return cat.MessageText(s.msgID[1])
	}
	return cat.MessageText(s.msgID[0])
}

// SetScopeRate records the band scope rate last sent to the radio ("high",
// "medium", "low"). The radio has no readback for it, so this is what lets a
// freshly opened browser show the rate that is really running.
func (s *State) SetScopeRate(rate string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.scopeRate = rate
}

// SetRxAudioLost records the current count of RTP sequence gaps seen on the
// RX audio UDP stream (internal/audio's Receiver.LostPackets) — a genuine
// network/radio-side loss signal, exposed so the UI can tell that apart from
// purely client-side audio artifacts (e.g. the playback ring buffer's own
// jitter trimming, see pcm-player-processor.js).
func (s *State) SetRxAudioLost(n uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rxAudioLost = n
}

// SetAmpPort records which serial port the PA is opened on ("" = none) and
// clears its status, since nothing is known about the amp any more.
func (s *State) SetAmpPort(port string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ampPort = port
	s.ampOn, s.ampOperate, s.ampTX, s.ampLevel = false, false, false, ""
	s.ampWarning, s.ampAlarm = "", ""
	s.ampModel, s.ampPowerW, s.ampSWR = "", 0, 0
}

// PowerAndAmp returns the radio's reported TX power setting (0 = not yet
// known) and whether the PA is currently on.
func (s *State) PowerAndAmp() (power int, ampOn bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.power, s.ampOn
}

// SetAmpTuning records that a PA tune sequence (carrier from the radio) is
// running, so browsers don't treat the radio's TX as a mic PTT.
func (s *State) SetAmpTuning(v bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ampTuning = v
}

// Mode returns the main receiver's current mode name.
func (s *State) Mode() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.mode
}

// TXFlags returns whether the radio is transmitting, whether the PA is on,
// and whether the PA reports itself keyed.
func (s *State) TXFlags() (radioTX, ampOn, ampTX bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.tx, s.ampOn, s.ampTX
}

// AmpOperate reports whether the PA is on and in OPERATE (not STANDBY).
func (s *State) AmpOperate() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.ampOn && s.ampOperate
}

// Connected reports whether the radio connection is currently up.
func (s *State) Connected() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.connected
}

// SetKnsMac records the radio's MAC address used for Wake-on-LAN.
func (s *State) SetKnsMac(mac string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.knsMac = mac
}

// SetKnsAuto records the "KNS auto connect" flag.
func (s *State) SetKnsAuto(auto bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.knsAuto = auto
}

// SetAmpConfig records the remembered PA port and auto-connect flag.
func (s *State) SetAmpConfig(savedPort string, auto bool, txTimeout int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ampSavedPort, s.ampAuto, s.ampTxTimeout = savedPort, auto, txTimeout
}

// SetVoipAutoSync records the periodic VoIP stream reset setting.
func (s *State) SetVoipAutoSync(enabled bool, minutes int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.voipAutoSync, s.voipAutoSyncMin = enabled, minutes
}

// SetAmpMaxPower records the configured transceiver PWR cap while the PA is on.
func (s *State) SetAmpMaxPower(watts int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ampMaxPowerW = watts
}

// SetAmpStatus records the PA's latest reported status.
func (s *State) SetAmpStatus(on, operate, tx bool, level, warning, alarm, model string, powerW float64, swr float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ampOn, s.ampOperate, s.ampTX, s.ampLevel = on, operate, tx, level
	s.ampWarning, s.ampAlarm = warning, alarm
	s.ampModel, s.ampPowerW, s.ampSWR = model, powerW, swr
}

// Snapshot is the JSON shape sent to browser clients.
type Snapshot struct {
	RadioHost            string         `json:"radioHost"`
	RadioPort            int            `json:"radioPort"`
	RadioVoipPort        int            `json:"radioVoipPort"`
	RadioUser            string         `json:"radioUser"`
	RadioAdmin           bool           `json:"radioAdmin"`
	Connected            bool           `json:"connected"`
	RadioStandby         bool           `json:"radioStandby"`
	VFOAHz               int            `json:"vfoAHz"`
	VFOBHz               int            `json:"vfoBHz"`
	Mode                 string         `json:"mode"`
	ActiveReceiver       string         `json:"activeReceiver"`
	SMeter               int            `json:"sMeter"`
	SWRMeter             int            `json:"swrMeter"`
	ALCMeter             int            `json:"alcMeter"`
	IDMeter              int            `json:"idMeter"`
	AGC                  string         `json:"agc"`
	NR                   int            `json:"nr"`
	NB1                  bool           `json:"nb1"`
	NB2                  bool           `json:"nb2"`
	RFGain               int            `json:"rfGain"`
	Squelch              int            `json:"squelch"`
	Band                 string         `json:"band"`
	Busy                 bool           `json:"busy"`
	TX                   bool           `json:"tx"`
	BC                   int            `json:"bc"`
	NR1Level             int            `json:"nr1Level"`
	NR2Tc                int            `json:"nr2Tc"`
	NB1Level             int            `json:"nb1Level"`
	NB2Level             int            `json:"nb2Level"`
	NB2TypeB             bool           `json:"nb2TypeB"`
	NB2Depth             int            `json:"nb2Depth"`
	NB2Width             int            `json:"nb2Width"`
	TXEq                 bool           `json:"txEq"`
	TXEqEffect           int            `json:"txEqEffect"`
	RXEq                 bool           `json:"rxEq"`
	RXEqEffect           int            `json:"rxEqEffect"`
	TXEqBands            []int          `json:"txEqBands"`
	RXEqBands            []int          `json:"rxEqBands"`
	TXMonitor            bool           `json:"txMonitor"`
	TXMonitorLevel       int            `json:"txMonitorLevel"`
	Proc                 bool           `json:"proc"`
	ProcTypeHard         bool           `json:"procTypeHard"`
	ProcTypeKnown        bool           `json:"procTypeKnown"`
	Ant                  string         `json:"ant"`
	Power                int            `json:"power"`
	MicGain              int            `json:"micGain"`
	ProcLevelIn          int            `json:"procLevelIn"`
	ProcLevelOut         int            `json:"procLevelOut"`
	IFFilter             string         `json:"ifFilter"`
	FilterWidthHz        map[string]int `json:"filterWidthHz"`
	AudioWidthByFilterHz map[string]int `json:"audioWidthByFilterHz"`
	TunerOn              bool           `json:"tunerOn"`
	Tuning               bool           `json:"tuning"`
	AudioWidthHz         int            `json:"audioWidthHz"`
	AudioShiftHz         int            `json:"audioShiftHz"`
	AudioHasShift        bool           `json:"audioHasShift"`
	AudioWidthSet        bool           `json:"audioWidthSettable"`
	AudioWidthMin        int            `json:"audioWidthMinHz"`
	AudioWidthMax        int            `json:"audioWidthMaxHz"`
	AudioShiftMin        int            `json:"audioShiftMinHz"`
	AudioShiftMax        int            `json:"audioShiftMaxHz"`
	AudioHasLoHiCut      bool           `json:"audioHasLoHiCut"`
	SSBFilterMode        string         `json:"ssbFilterMode"` // "hiLoCut" / "shiftWidth" in SSB modes, else ""
	AudioLoCutHz         int            `json:"audioLoCutHz"`
	AudioHiCutHz         int            `json:"audioHiCutHz"`
	AudioLoCutMin        int            `json:"audioLoCutMinHz"`
	AudioLoCutMax        int            `json:"audioLoCutMaxHz"`
	AudioHiCutMin        int            `json:"audioHiCutMinHz"`
	AudioHiCutMax        int            `json:"audioHiCutMaxHz"`
	AudioLoCutSteps      []int          `json:"audioLoCutSteps"`
	AudioHiCutSteps      []int          `json:"audioHiCutSteps"`
	ScopeSpanHz          int            `json:"scopeSpanHz"`
	ScopeRate            string         `json:"scopeRate"` // "high"/"medium"/"low", as last chosen via the tool
	RxAudioLost          uint64         `json:"rxAudioLost"`
	RadioMessage         string         `json:"radioMessage"`
	JitterBufferMs       int            `json:"jitterBufferMs"`
	VoipInLevel          int            `json:"voipInLevel"`
	VoipOutLevel         int            `json:"voipOutLevel"`
	CWPitchHz            int            `json:"cwPitchHz"`
	APFOn                bool           `json:"apfOn"`
	APFBwKnown           bool           `json:"apfBwKnown"`
	APFBw                int            `json:"apfBw"`
	APFGainKnown         bool           `json:"apfGainKnown"`
	APFGain              int            `json:"apfGain"`
	APFKnown             bool           `json:"apfKnown"`
	APFShiftHz           int            `json:"apfShiftHz"`
	ATT                  int            `json:"att"`
	PRE                  int            `json:"pre"`
	RITOn                bool           `json:"ritOn"`
	RITOffsetHz          int            `json:"ritOffsetHz"`
	XITOn                bool           `json:"xitOn"`
	AmpPort              string         `json:"ampPort"`
	AmpSavedPort         string         `json:"ampSavedPort"`
	AmpAuto              bool           `json:"ampAuto"`
	KnsAuto              bool           `json:"knsAuto"`
	KnsMac               string         `json:"knsMac"`
	VoipAutoSync         bool           `json:"voipAutoSync"`
	VoipAutoSyncMin      int            `json:"voipAutoSyncMin"`
	AmpTxTimeout         int            `json:"ampTxTimeout"`
	AmpMaxPowerW         int            `json:"ampMaxPowerW"`
	AmpOn                bool           `json:"ampOn"`
	AmpOperate           bool           `json:"ampOperate"`
	AmpTX                bool           `json:"ampTX"`
	AmpLevel             string         `json:"ampLevel"`
	AmpWarning           string         `json:"ampWarning"`
	AmpAlarm             string         `json:"ampAlarm"`
	AmpTuning            bool           `json:"ampTuning"`
	AmpModel             string         `json:"ampModel"`
	AmpPowerW            float64        `json:"ampPowerW"`
	AmpSWR               float64        `json:"ampSWR"`
}

// Update applies a raw CAT message to the state. It reports whether the
// message changed anything worth broadcasting.
func (s *State) Update(msg string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	// PS0/PS2 = off or shutting down, PS1/PS3 = on or powering up. The
	// keepalive asks every 5s, so a front-panel power-off is noticed even
	// when the radio keeps the TCP session open.
	if len(msg) == 3 && msg[:2] == "PS" && msg[2] >= '0' && msg[2] <= '3' {
		standby := msg[2] == '0' || msg[2] == '2'
		if s.radioStandby == standby {
			return false
		}
		s.radioStandby = standby
		return true
	}

	if vfo, hz, err := cat.ParseFrequency(msg); err == nil {
		switch vfo {
		case cat.VFOA:
			if s.vfoAHz == hz {
				return false
			}
			s.vfoAHz = hz
		case cat.VFOB:
			if s.vfoBHz == hz {
				return false
			}
			s.vfoBHz = hz
		}
		return true
	}

	// Only the main receiver's mode (OM0) drives the display for now; the
	// sub receiver (OM1) can be added once the UI shows both receivers.
	if receiver, mode, err := cat.ParseMode(msg); err == nil {
		if receiver != 0 || mode == "" || s.mode == mode {
			return false
		}
		s.mode = mode
		return true
	}

	if vfo, err := cat.ParseActiveReceiver(msg); err == nil {
		if s.activeReceiver == vfo {
			return false
		}
		s.activeReceiver = vfo
		return true
	}

	if val, err := cat.ParseSMeter(msg); err == nil {
		if s.sMeter == val {
			return false
		}
		s.sMeter = val
		return true
	}

	if val, err := cat.ParseIDMeter(msg); err == nil {
		if s.idMeter == val {
			return false
		}
		s.idMeter = val
		return true
	}

	if val, err := cat.ParseALCMeter(msg); err == nil {
		if s.alcMeter == val {
			return false
		}
		s.alcMeter = val
		return true
	}

	if val, err := cat.ParseSWRMeter(msg); err == nil {
		if s.swrMeter == val {
			return false
		}
		s.swrMeter = val
		return true
	}

	if val, err := cat.ParseBandScopeSpan(msg); err == nil {
		if s.scopeSpanHz == val {
			return false
		}
		s.scopeSpanHz = val
		return true
	}

	if val, err := cat.ParseRFGain(msg); err == nil {
		if s.rfGain == val {
			return false
		}
		s.rfGain = val
		return true
	}

	if val, err := cat.ParseSquelch(msg); err == nil {
		if s.squelch == val {
			return false
		}
		s.squelch = val
		return true
	}

	if val, err := cat.ParseAGC(msg); err == nil {
		if s.agc == val {
			return false
		}
		s.agc = val
		return true
	}

	if val, err := cat.ParseNR(msg); err == nil {
		if s.nr == val {
			return false
		}
		s.nr = val
		return true
	}

	if val, err := cat.ParseATT(msg); err == nil {
		if s.att == val {
			return false
		}
		s.att = val
		return true
	}

	if val, err := cat.ParsePRE(msg); err == nil {
		if s.pre == val {
			return false
		}
		s.pre = val
		return true
	}

	if on, err := cat.ParseRIT(msg); err == nil {
		if s.ritOn == on {
			return false
		}
		s.ritOn = on
		return true
	}

	if on, err := cat.ParseXIT(msg); err == nil {
		if s.xitOn == on {
			return false
		}
		s.xitOn = on
		return true
	}

	if hz, err := cat.ParseRITOffset(msg); err == nil {
		if s.ritOffsetHz == hz {
			return false
		}
		s.ritOffsetHz = hz
		return true
	}

	if which, enabled, err := cat.ParseNB(msg); err == nil {
		switch which {
		case 1:
			if s.nb1 == enabled {
				return false
			}
			s.nb1 = enabled
		case 2:
			if s.nb2 == enabled {
				return false
			}
			s.nb2 = enabled
		}
		return true
	}

	if busy, err := cat.ParseBusy(msg); err == nil {
		if s.busy == busy {
			return false
		}
		s.busy = busy
		return true
	}

	if v, err := cat.ParseAPFBandwidth(msg); err == nil {
		if s.apfBwKnown && s.apfBw == v {
			return false
		}
		s.apfBwKnown, s.apfBw = true, v
		return true
	}

	if v, err := cat.ParseAPFGain(msg); err == nil {
		if s.apfGainKnown && s.apfGain == v {
			return false
		}
		s.apfGainKnown, s.apfGain = true, v
		return true
	}

	if on, err := cat.ParseAPFOn(msg); err == nil {
		if s.apfOn == on {
			return false
		}
		s.apfOn = on
		return true
	}

	if hz, err := cat.ParseAPFShift(msg); err == nil {
		if s.apfKnown && s.apfShiftHz == hz {
			return false
		}
		s.apfKnown, s.apfShiftHz = true, hz
		return true
	}

	if hz, err := cat.ParsePitch(msg); err == nil {
		if s.pitchHz == hz {
			return false
		}
		s.pitchHz = hz
		return true
	}

	if ms, err := cat.ParseJitterBuffer(msg); err == nil {
		if s.jitterMs == ms {
			return false
		}
		s.jitterMs = ms
		return true
	}

	if output, level, err := cat.ParseVoipLevel(msg); err == nil {
		if output {
			if s.voipOutLevel == level {
				return false
			}
			s.voipOutLevel = level
		} else {
			if s.voipInLevel == level {
				return false
			}
			s.voipInLevel = level
		}
		return true
	}

	if src, id, err := cat.ParseMessageID(msg); err == nil {
		before := s.radioMessage()
		s.msgID[src] = id
		return s.radioMessage() != before
	}

	if tx, err := cat.ParseTX(msg); err == nil {
		if s.tx == tx {
			return false
		}
		s.tx = tx
		return true
	}

	if which, v, err := cat.ParseNRSetting(msg); err == nil {
		cur := &s.nr1Level
		if which == 2 {
			cur = &s.nr2Tc
		}
		if *cur == v {
			return false
		}
		*cur = v
		return true
	}
	if which, level, err := cat.ParseNBLevel(msg); err == nil {
		cur := &s.nb1Level
		if which == 2 {
			cur = &s.nb2Level
		}
		if *cur == level {
			return false
		}
		*cur = level
		return true
	}
	if typeB, err := cat.ParseNBType(msg); err == nil {
		if s.nb2TypeB == typeB {
			return false
		}
		s.nb2TypeB = typeB
		return true
	}
	if v, err := cat.ParseNBDepth(msg); err == nil {
		if s.nb2Depth == v {
			return false
		}
		s.nb2Depth = v
		return true
	}
	if v, err := cat.ParseNBWidth(msg); err == nil {
		if s.nb2Width == v {
			return false
		}
		s.nb2Width = v
		return true
	}

	if val, err := cat.ParseTXEQ(msg); err == nil {
		if s.txEq == val {
			return false
		}
		s.txEq = val
		return true
	}
	if val, err := cat.ParseTXEQEffect(msg); err == nil {
		if s.txEqEffect == val {
			return false
		}
		s.txEqEffect = val
		return true
	}
	if val, err := cat.ParseRXEQ(msg); err == nil {
		if s.rxEq == val {
			return false
		}
		s.rxEq = val
		return true
	}
	if val, err := cat.ParseRXEQEffect(msg); err == nil {
		if s.rxEqEffect == val {
			return false
		}
		s.rxEqEffect = val
		return true
	}
	if tx, bands, err := cat.ParseEQBands(msg); err == nil {
		cur := &s.rxEqBands
		if tx {
			cur = &s.txEqBands
		}
		if slices.Equal(*cur, bands) {
			return false
		}
		*cur = bands
		return true
	}
	if val, err := cat.ParseTXMonitor(msg); err == nil {
		if s.txMonitor == val {
			return false
		}
		s.txMonitor = val
		return true
	}
	if val, err := cat.ParseTXMonitorLevel(msg); err == nil {
		if s.txMonitorLevel == val {
			return false
		}
		s.txMonitorLevel = val
		return true
	}

	if val, err := cat.ParseBC(msg); err == nil {
		if s.bc == val {
			return false
		}
		s.bc = val
		return true
	}

	if proc, err := cat.ParseProc(msg); err == nil {
		if s.proc == proc {
			return false
		}
		s.proc = proc
		return true
	}

	if hard, err := cat.ParseProcType(msg); err == nil {
		if s.procTypeKnown && s.procType == hard {
			return false
		}
		s.procType, s.procTypeKnown = hard, true
		return true
	}

	if ant, err := cat.ParseAntenna(msg); err == nil {
		if s.antenna == ant {
			return false
		}
		s.antenna = ant
		return true
	}

	if val, err := cat.ParsePower(msg); err == nil {
		if s.power == val {
			return false
		}
		s.power = val
		return true
	}

	if val, err := cat.ParseMicGain(msg); err == nil {
		if s.micGain == val {
			return false
		}
		s.micGain = val
		return true
	}

	if val, err := cat.ParseProcLevels(msg); err == nil {
		if s.procLevels == val {
			return false
		}
		s.procLevels = val
		return true
	}

	if val, err := cat.ParseIFFilter(msg); err == nil {
		if s.ifFilter == val {
			return false
		}
		s.ifFilter = val
		return true
	}

	if filter, widthHz, err := cat.ParseIFFilterWidth(msg); err == nil {
		if s.filterWidthHz[filter] == widthHz {
			return false
		}
		s.filterWidthHz[filter] = widthHz
		return true
	}

	if val, err := cat.ParseSSBDataFilterMode(msg); err == nil {
		if s.ssbDataFilterMode == val {
			return false
		}
		s.ssbDataFilterMode = val
		s.cacheAudioWidth()
		return true
	}

	if val, err := cat.ParseSSBFilterMode(msg); err == nil {
		if s.ssbFilterMode == val {
			return false
		}
		s.ssbFilterMode = val
		s.cacheAudioWidth()
		return true
	}

	if isHi, passbandID, err := cat.ParseFilterPassband(msg); err == nil {
		if isHi {
			if s.hiPassbandID == passbandID {
				return false
			}
			s.hiPassbandID = passbandID
		} else {
			if s.loPassbandID == passbandID {
				return false
			}
			s.loPassbandID = passbandID
		}
		s.cacheAudioWidth()
		return true
	}

	if val, err := cat.ParseTuner(msg); err == nil {
		if s.tuner == val {
			return false
		}
		s.tuner = val
		return true
	}

	return false
}

// cacheAudioWidth recomputes the audio filter's width for the current mode/
// filter-mode/passband state and remembers it against whichever roofing
// filter is currently selected. SL0/SH0 only ever report the ACTIVE
// receiver's own passband — confirmed live that switching roofing filters
// (FIL 1/2/3) recalls a different width per filter (e.g. 2200 Hz vs 2500 Hz
// on the same radio) — so a filter's width can only become known once it's
// actually been selected at least once this session; must be called with
// s.mu already held for writing.
func (s *State) cacheAudioWidth() {
	if s.ifFilter == "" {
		return
	}
	widthHz, _, _ := cat.FilterWidthShift(s.mode, s.filterModeLocked(), s.loPassbandID, s.hiPassbandID)
	s.audioWidthByFilter[s.ifFilter] = widthHz
}

// ActiveVFO returns which VFO is currently the active (main) receiver, so a
// frequency change from the browser is sent to the right one.
func (s *State) ActiveVFO() cat.VFO {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.activeReceiver == "" {
		return cat.VFOA
	}
	return s.activeReceiver
}

// Antenna returns the current antenna state, defaulting to antenna 1 (with
// the extra RX-ANT/DRV/ANT-OUT toggles off) before the radio has reported
// anything. Selecting an antenna must resend the other three fields
// unchanged, so callers building an "AN" command read this first.
func (s *State) Antenna() cat.Antenna {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.antenna.Selected == "" {
		return cat.Antenna{Selected: "1"}
	}
	return s.antenna
}

// ProcLevels returns the speech processor's current input/output levels, so
// a browser-requested change to just the output level can preserve whatever
// the input level currently is (the radio's "PL" command always sets both
// together).
func (s *State) ProcLevels() cat.ProcLevels {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.procLevels
}

// Tuner returns the antenna tuner's current status bits, so a browser
// request to toggle just one bit (AT on/off, or a TUNE press) can preserve
// whatever the other one currently is (the radio's "AC" command always sets
// all three bits together).
func (s *State) Tuner() cat.TunerState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.tuner
}

// filterModeLocked is the SSB filter display mode that applies to the current
// operating mode: the data-mode menu item (EX00612) for LSB-D/USB-D, else
// EX00611. Caller holds s.mu.
func (s *State) filterModeLocked() cat.FilterMode {
	if s.mode == "LSB-D" || s.mode == "USB-D" {
		return s.ssbDataFilterMode
	}
	return s.ssbFilterMode
}

// AudioFilterConfig returns the current mode, SSB filter-mode, and lo-cut
// passband index, so a browser-requested audio width change can be resolved
// against the right lookup table (see cat.EncodeAudioWidth) — AM/FM need the
// current lo-cut to compute a target hi-cut from a desired width.
func (s *State) AudioFilterConfig() (mode string, filterMode cat.FilterMode, loPassbandID int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.mode, s.filterModeLocked(), s.loPassbandID
}

// Snapshot returns a copy of the current state for JSON serialization.
func (s *State) Snapshot() Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()

	activeReceiver := s.activeReceiver
	if activeReceiver == "" {
		activeReceiver = cat.VFOA
	}

	activeHz := s.vfoAHz
	if activeReceiver == cat.VFOB {
		activeHz = s.vfoBHz
	}

	ant := s.antenna.Selected
	if ant == "" {
		ant = "1"
	}

	filterWidthHz := make(map[string]int, len(s.filterWidthHz))
	for k, v := range s.filterWidthHz {
		filterWidthHz[k] = v
	}

	audioWidthByFilter := make(map[string]int, len(s.audioWidthByFilter))
	for k, v := range s.audioWidthByFilter {
		audioWidthByFilter[k] = v
	}

	audioWidthHz, audioShiftHz, audioHasShift := cat.FilterWidthShift(s.mode, s.filterModeLocked(), s.loPassbandID, s.hiPassbandID)

	audioWidthMin, audioWidthMax, audioWidthSettable := cat.AudioWidthRange(s.mode, s.filterModeLocked())
	audioShiftMin, audioShiftMax, _ := cat.ShiftRange(s.mode, s.filterModeLocked())

	audioLoCutHz, audioHiCutHz, audioHasLoHiCut := cat.AudioLoHiCut(s.mode, s.filterModeLocked(), s.loPassbandID, s.hiPassbandID)
	audioLoCutMin, audioLoCutMax, _ := cat.AudioLoCutRange(s.mode, s.filterModeLocked())
	audioHiCutMin, audioHiCutMax, _ := cat.AudioHiCutRange(s.mode, s.filterModeLocked())
	audioLoCutSteps := cat.AudioLoCutSteps(s.mode, s.filterModeLocked())
	audioHiCutSteps := cat.AudioHiCutSteps(s.mode, s.filterModeLocked())

	return Snapshot{
		RadioHost:            s.radioHost,
		RadioPort:            s.radioPort,
		RadioVoipPort:        s.radioVoipPort,
		RadioUser:            s.radioUser,
		RadioAdmin:           s.radioAdmin,
		Connected:            s.connected,
		RadioStandby:         s.radioStandby,
		VFOAHz:               s.vfoAHz,
		VFOBHz:               s.vfoBHz,
		Mode:                 s.mode,
		ActiveReceiver:       string(activeReceiver),
		SMeter:               s.sMeter,
		SWRMeter:             s.swrMeter,
		ALCMeter:             s.alcMeter,
		IDMeter:              s.idMeter,
		AGC:                  s.agc,
		NR:                   s.nr,
		NB1:                  s.nb1,
		NB2:                  s.nb2,
		RFGain:               s.rfGain,
		Squelch:              s.squelch,
		Band:                 cat.BandForFrequency(activeHz),
		Busy:                 s.busy,
		TX:                   s.tx,
		BC:                   s.bc,
		NR1Level:             s.nr1Level,
		NR2Tc:                s.nr2Tc,
		NB1Level:             s.nb1Level,
		NB2Level:             s.nb2Level,
		NB2TypeB:             s.nb2TypeB,
		NB2Depth:             s.nb2Depth,
		NB2Width:             s.nb2Width,
		TXEq:                 s.txEq,
		TXEqEffect:           s.txEqEffect,
		RXEq:                 s.rxEq,
		RXEqEffect:           s.rxEqEffect,
		TXEqBands:            s.txEqBands,
		RXEqBands:            s.rxEqBands,
		TXMonitor:            s.txMonitor,
		TXMonitorLevel:       s.txMonitorLevel,
		Proc:                 s.proc,
		ProcTypeHard:         s.procType,
		ProcTypeKnown:        s.procTypeKnown,
		Ant:                  ant,
		Power:                s.power,
		MicGain:              s.micGain,
		ProcLevelIn:          s.procLevels.Input,
		ProcLevelOut:         s.procLevels.Output,
		IFFilter:             s.ifFilter,
		FilterWidthHz:        filterWidthHz,
		AudioWidthByFilterHz: audioWidthByFilter,
		TunerOn:              s.tuner.TXEnabled,
		Tuning:               s.tuner.TuningActive,
		AudioWidthHz:         audioWidthHz,
		AudioShiftHz:         audioShiftHz,
		AudioHasShift:        audioHasShift,
		AudioWidthSet:        audioWidthSettable,
		AudioWidthMin:        audioWidthMin,
		AudioWidthMax:        audioWidthMax,
		AudioShiftMin:        audioShiftMin,
		AudioShiftMax:        audioShiftMax,
		AudioHasLoHiCut:      audioHasLoHiCut,
		SSBFilterMode:        ssbFilterModeName(s.mode, s.filterModeLocked()),
		AudioLoCutHz:         audioLoCutHz,
		AudioHiCutHz:         audioHiCutHz,
		AudioLoCutMin:        audioLoCutMin,
		AudioLoCutMax:        audioLoCutMax,
		AudioHiCutMin:        audioHiCutMin,
		AudioHiCutMax:        audioHiCutMax,
		AudioLoCutSteps:      audioLoCutSteps,
		AudioHiCutSteps:      audioHiCutSteps,
		ScopeSpanHz:          s.scopeSpanHz,
		ScopeRate:            s.scopeRate,
		RxAudioLost:          s.rxAudioLost,
		ATT:                  s.att,
		PRE:                  s.pre,
		RITOn:                s.ritOn,
		RITOffsetHz:          s.ritOffsetHz,
		XITOn:                s.xitOn,
		AmpPort:              s.ampPort,
		AmpSavedPort:         s.ampSavedPort,
		AmpAuto:              s.ampAuto,
		KnsAuto:              s.knsAuto,
		KnsMac:               s.knsMac,
		VoipAutoSync:         s.voipAutoSync,
		VoipAutoSyncMin:      s.voipAutoSyncMin,
		AmpTxTimeout:         s.ampTxTimeout,
		AmpMaxPowerW:         s.ampMaxPowerW,
		AmpOn:                s.ampOn,
		AmpOperate:           s.ampOperate,
		AmpTX:                s.ampTX,
		AmpLevel:             s.ampLevel,
		AmpWarning:           s.ampWarning,
		AmpAlarm:             s.ampAlarm,
		RadioMessage:         s.radioMessage(),
		JitterBufferMs:       s.jitterMs,
		VoipInLevel:          s.voipInLevel,
		VoipOutLevel:         s.voipOutLevel,
		CWPitchHz:            s.pitchHz,
		APFOn:                s.apfOn,
		APFBwKnown:           s.apfBwKnown,
		APFBw:                s.apfBw,
		APFGainKnown:         s.apfGainKnown,
		APFGain:              s.apfGain,
		APFKnown:             s.apfKnown,
		APFShiftHz:           s.apfShiftHz,
		AmpTuning:            s.ampTuning,
		AmpModel:             s.ampModel,
		AmpPowerW:            s.ampPowerW,
		AmpSWR:               s.ampSWR,
	}
}

func ssbFilterModeName(mode string, fm cat.FilterMode) string {
	switch mode {
	case "LSB", "USB", "LSB-D", "USB-D":
		if fm == cat.FilterModeHiLoCut {
			return "hiLoCut"
		}
		return "shiftWidth"
	}
	return ""
}
