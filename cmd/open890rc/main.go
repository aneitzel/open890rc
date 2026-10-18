// Command open890rc connects to a Kenwood TS-890S over LAN (KNS), logs in, and
// serves a web interface showing live frequency and mode over WebSocket.
package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"open890rc/internal/audio"
	"open890rc/internal/cat"
	"open890rc/internal/config"
	"open890rc/internal/hub"
	"open890rc/internal/radio"
	"open890rc/internal/spe"
	"open890rc/internal/state"
	"open890rc/internal/web"
)

// envIntOr returns the parsed integer value of the named environment
// variable, or fallback if it's unset or not a valid integer.
func orDefault(v, def int) int {
	if v == 0 {
		return def
	}
	return v
}

func envIntOr(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

// envBoolOr returns the parsed boolean value of the named environment
// variable (accepts the same forms as strconv.ParseBool: "1", "true",
// "TRUE", "t", etc.), or fallback if it's unset or not a valid boolean.
func envBoolOr(key string, fallback bool) bool {
	if v := os.Getenv(key); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return fallback
}

// wantMeter is the extra radio meter ("alc" = RM1, "id" = RM4, "" = none) a
// browser currently has selected on the gauge. The radio only streams these
// after "RM<P1>1" (P2 = 1 read; "RM<P1>0" = do not read, per the Kenwood
// reference, and all meters are reset to "do not read" at power-on); to save
// traffic that is only switched on while somebody looks at it.
var (
	wantMeterMu sync.Mutex
	wantMeter   string
)

func meterCode(mode string) string {
	switch mode {
	case "alc":
		return "1"
	case "id":
		return "4"
	}
	return ""
}

// initialQueries are sent right after every successful login, whether that
// happens at startup (via flags) or later from the browser's setup dialog.
var initialQueries = []string{
	"AI2", "FR", "FA", "FB", "OM0", "RM21", "GC", "NR", "NB1", "NB2", "RG",
	"SQ", "BY", "BC", "NL1", "NL2", "NBT", "NBD", "NBW", "EQR0", "EQR1", "PR0", "PR1", "AN", "PC", "MG", "PL", "AC", "FL0", "RA", "PA",
	"FL10", "FL11", "FL12", "EX00611", "EX00612", "SH0", "SL0", "##KN4", "##KN30", "##KN31", "PT", "AP0", "AP1", "AP2", "AP3", "BS4", "DD01",
	"RT", "RF", "XT", "MO0", "ML",
}

const banner = `
   ____                    ___   ___   ___
  / __ \                  / _ \ / _ \ / _ \
 | |  | |_ __   ___ _ __ | (_) | (_) | | | |_ __ ___
 | |  | | '_ \ / _ \ '_ \ > _ < \__, | | | | '__/ __|
 | |__| | |_) |  __/ | | | (_) |  / /| |_| | | | (__
  \____/| .__/ \___|_| |_|\___/  /_/  \___/|_|  \___|
        | |
        |_|

Open890RC - Web remote control for Kenwood TS890 by André HB9INA

Config / Variables found!
`

func printBanner(webURL string) {
	fmt.Print(banner)
	// Same treatment as printNoConfigBanner below: a blank line first so
	// this doesn't run straight into the banner text above it.
	fmt.Println()
	fmt.Printf(">>> WEBINTERFACE started at URL: %s <<<\n\n", webURL)
	fmt.Println("Open browser, accept certificate warning (if selfsigned) and start config via settings button")
	fmt.Println()
}

// noConfigBanner is shown instead of the regular banner specifically when
// the program is started with no flags and no OPEN890RC_* env vars set — a
// bigger nudge toward the available options than the plain banner, since at
// that point the operator has nothing configured yet at all.
const noConfigBanner = `
   ____                    ___   ___   ___
  / __ \                  / _ \ / _ \ / _ \
 | |  | |_ __   ___ _ __ | (_) | (_) | | | |_ __ ___
 | |  | | '_ \ / _ \ '_ \ > _ < \__, | | | | '__/ __|
 | |__| | |_) |  __/ | | | (_) |  / /| |_| | | | (__
  \____/| .__/ \___|_| |_|\___/  /_/  \___/|_|  \___|
        | |
        |_|

Open890RC - Many thanks to Tony Collen (SK) for inspiration.
This tool is dedicate to him and his work in open890! André HB9INA

Command line options:

-knsip        - ip/hostname of TS890 (or set OPEN890RC_IP)
-knstcpport   - KNS TCP port for transceiver control and command data, default 60000 (or set OPEN890RC_TCPPORT)
-knsvoipport  - KNS VoiP port VoIP/audio, default 60001 (or set OPEN890RC_VOIPPORT)
-knsuser      - KNS username (or set OPEN890RC_USER)
-knspass      - KNS password (or set OPEN890RC_PASS)
-knsadm       - KNS user is admin (or set OPEN890RC_ADMIN to true)

-config       - file remembering the settings made in the web UI (KNS connection, PA, PROC, equalizers), default "open890rc-config.json"

-speport      - serial port of an SPE Expert PA, e.g. /dev/cu.usbserial-1430 (or set OPEN890RC_SPEPORT)
-spebaud      - baud rate of the SPE Expert serial port, default 115200 (or set OPEN890RC_SPEBAUD)

-web          - address for the Open890RC web interface, default all interfaces „:8080“, for example -web :8080, or 192.168.1.174:8080
-no-tls       - serve plain HTTP instead of HTTPS (RX audio needs a secure context, so only useful when every client is literally "localhost")
-tls-cert     - path to cache the generated self-signed certificate (default "open890rc-cert.pem")
-tls-key      - path to cache the generated self-signed certificate's key (default "open890rc-key.pem")
`

func printNoConfigBanner(webURL string) {
	fmt.Print(noConfigBanner)
	// Blank line before this on both sides (Print above already ends with
	// one from the raw string) so it stands out from the option list
	// instead of running straight into it — this is the one line the
	// operator actually needs to act on.
	fmt.Println()
	fmt.Printf(">>> WEBINTERFACE initialized on URL: %s <<<\n\n", webURL)
	fmt.Println("Open browser, accept certificate warning (if selfsigned) and start config via settings button")
	fmt.Println()
}

// radioManager holds the single active radio connection, if any, so browser-
// triggered commands and a browser-triggered reconnect can't race each other.
type radioManager struct {
	mu   sync.Mutex
	conn *radio.Conn
}

func (r *radioManager) current() *radio.Conn {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.conn
}

// swap installs c as the current connection and returns whatever was there
// before (nil if this is the first connection), for the caller to close.
func (r *radioManager) swap(c *radio.Conn) *radio.Conn {
	r.mu.Lock()
	defer r.mu.Unlock()
	old := r.conn
	r.conn = c
	return old
}

// txSenderManager holds the current TX audio UDP sender, mirroring
// radioManager: re-created on every (re)connect since it targets a specific
// radio IP, swapped in only once the new one exists so a reconnect attempt
// can't leave TX audio with nowhere to go.
type txSenderManager struct {
	mu     sync.Mutex
	sender *audio.TXSender
}

func (t *txSenderManager) current() *audio.TXSender {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.sender
}

func (t *txSenderManager) swap(s *audio.TXSender) *audio.TXSender {
	t.mu.Lock()
	defer t.mu.Unlock()
	old := t.sender
	t.sender = s
	return old
}

// audioReceiverManager holds the current RX audio UDP listener, mirroring
// txSenderManager: the KNS VoIP port is user-configurable (setup dialog or
// -knsvoipport/OPEN890RC_VOIPPORT), so the listener has to be re-bound on
// every (re)connect the same way the TX sender is re-targeted, rather than
// opened once for the process's whole lifetime on a fixed port.
type audioReceiverManager struct {
	mu   sync.Mutex
	recv *audio.Receiver
}

func (a *audioReceiverManager) swap(r *audio.Receiver) *audio.Receiver {
	a.mu.Lock()
	defer a.mu.Unlock()
	old := a.recv
	a.recv = r
	return old
}

// lostPackets reports the current receiver's RTP sequence gap count, or 0
// if there is none (not connected, or between a reconnect's close/re-bind).
func (a *audioReceiverManager) lostPackets() uint64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.recv == nil {
		return 0
	}
	return a.recv.LostPackets()
}

// resetLoss zeroes the current receiver's loss counter, if there is one —
// no-op while not connected.
func (a *audioReceiverManager) resetLoss() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.recv != nil {
		a.recv.ResetLoss()
	}
}

// tlsHandshakeErrorFilter drops net/http's own "TLS handshake error" log
// lines and passes everything else through unchanged.
type tlsHandshakeErrorFilter struct {
	out *os.File
}

func (f tlsHandshakeErrorFilter) Write(p []byte) (int, error) {
	if bytes.Contains(p, []byte("TLS handshake error")) {
		return len(p), nil
	}
	return f.out.Write(p)
}

func main() {
	host := flag.String("knsip", os.Getenv("OPEN890RC_IP"), "ip/hostname of TS890 (or set OPEN890RC_IP — optional either way, can also be set from the web UI's setup dialog)")
	port := flag.Int("knstcpport", envIntOr("OPEN890RC_TCPPORT", radio.DefaultPort), "KNS TCP port for transceiver control and command data (or set OPEN890RC_TCPPORT)")
	voipPort := flag.Int("knsvoipport", envIntOr("OPEN890RC_VOIPPORT", audio.DefaultPort), "KNS VoIP port for VoIP/audio (or set OPEN890RC_VOIPPORT)")
	username := flag.String("knsuser", os.Getenv("OPEN890RC_USER"), "KNS username (or set OPEN890RC_USER)")
	password := flag.String("knspass", os.Getenv("OPEN890RC_PASS"), "KNS password (or set OPEN890RC_PASS)")
	admin := flag.Bool("knsadm", envBoolOr("OPEN890RC_ADMIN", false), "KNS user is admin (or set OPEN890RC_ADMIN)")
	speAmpPort := flag.String("speport", os.Getenv("OPEN890RC_SPEPORT"), "serial port of an SPE Expert PA, e.g. /dev/cu.usbserial-1430 (or set OPEN890RC_SPEPORT) — optional, can also be set from the web UI's setup dialog")
	speAmpBaud := flag.Int("spebaud", envIntOr("OPEN890RC_SPEBAUD", spe.DefaultBaud), "baud rate for the SPE Expert serial port (or set OPEN890RC_SPEBAUD)")
	configFile := flag.String("config", "open890rc-config.json", "file remembering the settings made in the web UI (KNS connection incl. password, PA, PROC, equalizers)")
	usersFile := flag.String("usersfile", "open890rc-users.json", "file with the web login users (password hashes); browsers outside the local network must log in, local ones manage the users in the UI")
	webAddr := flag.String("web", ":8080", "address for the web interface")
	noTLS := flag.Bool("no-tls", false, "serve plain HTTP instead of HTTPS (RX audio needs a secure context, so only useful when every client is literally \"localhost\")")
	certFile := flag.String("tls-cert", "open890rc-cert.pem", "path to cache the generated self-signed certificate")
	keyFile := flag.String("tls-key", "open890rc-key.pem", "path to cache the generated self-signed certificate's key")
	// Neither a flag nor an OPEN890RC_* env var was used — nothing at all is
	// configured yet, as opposed to e.g. -knsadm alone with everything else
	// left at defaults, which still counts as "configured" and gets the
	// regular banner instead.
	noConfigGiven := len(os.Args) == 1 &&
		os.Getenv("OPEN890RC_IP") == "" &&
		os.Getenv("OPEN890RC_TCPPORT") == "" &&
		os.Getenv("OPEN890RC_VOIPPORT") == "" &&
		os.Getenv("OPEN890RC_USER") == "" &&
		os.Getenv("OPEN890RC_PASS") == "" &&
		os.Getenv("OPEN890RC_ADMIN") == "" &&
		os.Getenv("OPEN890RC_SPEPORT") == "" &&
		os.Getenv("OPEN890RC_SPEBAUD") == ""
	flag.Parse()
	cfgStore := config.Open(*configFile)
	web.SetUsersFile(*usersFile)
	log.SetOutput(io.MultiWriter(os.Stderr, web.DebugLog)) // console + the Debug tab of the user window

	// Go's flag package stops parsing at the first non-flag argument — a
	// boolean flag like -knsadm given WITH a value but no "=" (e.g. "-knsadm
	// enabled" instead of just "-knsadm", or "-knsadm=true") sets -knsadm
	// true and then treats "enabled" itself as that first non-flag argument,
	// silently ending parsing right there: every flag after it (e.g. -web)
	// is never even looked at and quietly keeps its default. Live-reported
	// (2026-09-29): -web appeared to have no effect at all when given after
	// exactly this kind of -knsadm usage — not a bug in how -web itself is
	// applied, just parsing having already stopped before reaching it.
	if flag.NArg() > 0 {
		log.Printf(
			"main: ignoring unrecognized command-line argument(s) %v — flag parsing stops at the first one, so any flags meant to come after it (like -web) were never applied. A boolean flag such as -knsadm takes no value: write it alone (\"-knsadm\"), not with one (\"-knsadm enabled\").",
			flag.Args(),
		)
	}

	scheme := "https"
	if *noTLS {
		scheme = "http"
	}
	_, webPort, err := net.SplitHostPort(*webAddr)
	if err != nil {
		webPort = *webAddr
	}
	webURL := fmt.Sprintf("%s://%s:%s", scheme, web.PreferredLocalIP(), webPort)
	if noConfigGiven {
		printNoConfigBanner(webURL)
	} else {
		printBanner(webURL)
	}

	st := state.New()
	h := hub.New()
	rm := &radioManager{}
	txm := &txSenderManager{}
	arm := &audioReceiverManager{}

	broadcastState := func() {
		snap, err := json.Marshal(st.Snapshot())
		if err != nil {
			log.Printf("main: marshaling state: %v", err)
			return
		}
		h.Broadcast(snap)
	}

	pcmHub := hub.New()
	opusHub := hub.New()
	waterfallHub := hub.New()

	// With the PA on, the TS-890 may only drive so much — the UI slider is
	// capped at ampMaxPowerW, and whenever the PA switches on while the radio
	// is set higher, the radio is turned down to that same cap. Used to be a
	// fixed 17W (plus a separate, also-fixed 15W "just switched on" target)
	// baked into the code; now one configurable value (Nutzer-Wunsch,
	// 2026-10-14: "Eingabefeld Max PWR bei aktiver PA", 5-100W, default 15W),
	// persisted in -config (section "spe") (see speCfg further down, which Store()s the
	// loaded/saved value here) and used identically for both roles — the
	// "drop to a lower safe default on PA-on, separate from the hard
	// ceiling" distinction the old two-constant version had wasn't something
	// asked for, and would have been a surprising mismatch against a field
	// literally named "Max PWR bei aktiver PA" (set it to 25W, expect PA-on
	// to allow up to 25W, not silently cap at a hidden lower default first).
	// ampPowerPending stays set until that check could actually run — the
	// PA can report "on" before the radio's PC value is known (power 0).
	const (
		ampMaxPowerDefaultW = 15
		ampMaxPowerMinW     = 5
		ampMaxPowerMaxW     = 100
	)
	var ampMaxPowerW atomic.Int64
	ampMaxPowerW.Store(ampMaxPowerDefaultW)
	var ampPowerPending atomic.Bool
	// Radio settings from before the PA went on, restored when it goes off.
	var ampSavedMu sync.Mutex
	var ampSavedValid bool
	var ampSavedAT bool
	var ampSavedPower int
	var lastATCorrection atomic.Int64
	var lastPowerCorrection atomic.Int64 // unix ms, rate-limits corrections
	enforceAmpPower := func() {
		power, ampOn := st.PowerAndAmp()
		if !ampOn {
			ampPowerPending.Store(false)
			return
		}
		conn := rm.current()
		if conn == nil {
			return
		}
		// The PA has its own tuner: the TS-890's internal AT must stay off.
		if t := st.Tuner(); t.TXEnabled {
			now := time.Now().UnixMilli()
			if now-lastATCorrection.Load() >= 500 {
				lastATCorrection.Store(now)
				if err := conn.Send(cat.EncodeTuner(false, t.TuningActive)); err != nil {
					log.Printf("main: switching AT off for PA failed: %v", err)
				} else {
					log.Println("main: PA on, switched the TS-890's internal AT off")
				}
			}
		}
		if power == 0 {
			return // not known yet; retried on the next radio message
		}
		maxPower := int(ampMaxPowerW.Load())
		target := maxPower
		justSwitchedOn := ampPowerPending.Load()
		if justSwitchedOn {
			ampPowerPending.Store(false)
		}
		if power <= maxPower {
			return
		}
		// Radio messages (S-meter etc.) arrive many times per second; give the
		// radio time to echo the corrected PC value before correcting again.
		now := time.Now().UnixMilli()
		if last := lastPowerCorrection.Load(); now-last < 500 {
			if !justSwitchedOn {
				return
			}
		}
		lastPowerCorrection.Store(now)
		cmd, _ := cat.EncodePower(target)
		if err := conn.Send(cmd); err != nil {
			log.Printf("main: reducing power for PA failed: %v", err)
			return
		}
		log.Printf("main: PA on, radio power %dW is above %dW, set to %dW", power, maxPower, target)
	}

	// Power status replies ("PS0"/"PS1") for radioPower, see there.
	psReplies := make(chan string, 8)
	// "MS0<P2><P3>" replies (TX audio source for SEND/PTT), see applyTXSource.
	msReplies := make(chan string, 4)
	// "PR0<n>" / "PR1<n>" / "PL<in><out>" replies, see applyProcSettings.
	prReplies := make(chan string, 4)
	pr1Replies := make(chan string, 4)
	plReplies := make(chan string, 4)
	// "EQT0<n>" replies (TX equalizer on/off), see forceTXEQOff.
	eqReplies := make(chan string, 4)
	// "EQR0<n>" replies (RX equalizer on/off), see forceRXEQOff.
	eqRxReplies := make(chan string, 4)
	// "MO0<n>" replies (TX monitor on/off), see forceTXMonOff.
	txMonReplies := make(chan string, 4)
	// "BS3<n>" replies (band scope mode), see applyBandScopeCenter.
	bs3Replies := make(chan string, 4)
	// Mode-change hook for the TX/RX equalizers (set further down, after the
	// equalizer state exists).
	var onModeChanged func()
	onMsg := func(msg string) {
		if len(msg) == 5 && strings.HasPrefix(msg, "EQT0") {
			select {
			case eqReplies <- msg:
			default:
			}
		}
		if len(msg) == 5 && strings.HasPrefix(msg, "EQR0") {
			select {
			case eqRxReplies <- msg:
			default:
			}
		}
		if len(msg) == 4 && strings.HasPrefix(msg, "MO0") {
			select {
			case txMonReplies <- msg:
			default:
			}
		}
		if len(msg) == 4 && strings.HasPrefix(msg, "PR0") {
			select {
			case prReplies <- msg:
			default:
			}
		}
		if len(msg) == 4 && strings.HasPrefix(msg, "PR1") {
			select {
			case pr1Replies <- msg:
			default:
			}
		}
		if len(msg) == 8 && strings.HasPrefix(msg, "PL") {
			select {
			case plReplies <- msg:
			default:
			}
		}
		if len(msg) == 5 && strings.HasPrefix(msg, "MS0") {
			select {
			case msReplies <- msg:
			default:
			}
		}
		if len(msg) == 4 && strings.HasPrefix(msg, "BS3") {
			select {
			case bs3Replies <- msg:
			default:
			}
		}
		// The radio answers a rejected command with "?" (or "E"): worth a log
		// line, otherwise nothing shows that a command was refused.
		if msg == "?" || msg == "E" {
			log.Printf("radio: reply %q", msg)
		}
		if strings.HasPrefix(msg, "PS") && len(msg) >= 3 {
			select {
			case psReplies <- msg:
			default:
			}
		}
		// Band scope lines are high-frequency binary-ish data, not part of
		// the JSON state snapshot — relay them straight to their own hub
		// instead of running them through st.Update (which wouldn't
		// recognize "##DD2" anyway).
		if line, ok := cat.ParseBandScopeLine(msg); ok {
			waterfallHub.Broadcast(line)
			return
		}

		if st.Update(msg) {
			broadcastState()
		}
		enforceAmpPower()

		// The radio's "MG" query returns a stale, frozen mic-gain value the
		// whole time PROC is on — a SET still applies underneath, but only
		// shows up in a query once PROC is off (verified live: setting MG
		// while PROC was on echoed the old value, yet appeared correctly the
		// moment PROC was switched off). Refresh it right when it becomes
		// trustworthy and relevant (the UI now shows the MIC slider).
		if strings.HasPrefix(msg, "OM0") && onModeChanged != nil {
			onModeChanged()
		}
		if enabled, err := cat.ParseProc(msg); err == nil && !enabled {
			if conn := rm.current(); conn != nil {
				if err := conn.Send("MG"); err != nil {
					log.Printf("main: refreshing mic gain after PROC off failed: %v", err)
				}
			}
		}
	}

	opusEncoder, err := audio.NewOpusEncoder()
	if err != nil {
		log.Fatalf("creating opus encoder: %v", err)
	}

	// opusEncoder is shared by two independent callers once TX relay is
	// wired in below: the radio's own readLoop goroutine (via onPCM) and
	// whichever browser connection currently owns TX (via handleTXAudioWS,
	// a different goroutine per claimTXAudio). OpusEncoder is explicitly
	// documented as not safe for concurrent use (it reuses an internal
	// scratch buffer) — same lesson as radio.Conn's write mutex and
	// TXSender's own mutex, a shared mutable resource needs serialized
	// access the moment more than one goroutine can reach it.
	var opusEncMu sync.Mutex

	// broadcastRXAudio fans one raw little-endian 16-bit PCM frame out to
	// every browser on the RX audio stream (PCM as-is, Opus-encoded only if
	// anyone is actually subscribed to it). Used both for real RX audio
	// from the radio (onPCM below) and, once wired into txAudio.Relay
	// further down, to echo a transmitting client's own mic audio to every
	// other connected client — the link is simplex, so there is no real RX
	// audio to talk over while someone is sending anyway (Nutzer-Wunsch,
	// 2026-10-14: mix into the existing stream instead of a separate
	// monitor channel).
	broadcastRXAudio := func(pcm []byte) {
		pcmHub.Broadcast(pcm)
		if opusHub.Len() > 0 {
			opusEncMu.Lock()
			packet, err := opusEncoder.Encode(pcm)
			opusEncMu.Unlock()
			if err != nil {
				log.Printf("audio: opus encode failed: %v", err)
			} else {
				opusHub.Broadcast(packet)
			}
		}
	}

	// lastReportedLost is only ever touched from onPCM, which the currently
	// active Receiver's single readLoop goroutine calls one packet at a
	// time (the old one is always closed before a new one starts, see
	// connectRadio below) — safe without its own lock.
	var lastReportedLost uint64
	onPCM := func(pcm []byte) {
		// While transmitting, the link is simplex (no real RX content), but
		// the radio's own LAN audio output was found to keep streaming RTP
		// packets at the normal real-time cadence regardless — broadcasting
		// those alongside the new TX-audio relay below roughly doubled the
		// data rate into the RX hubs during TX, growing a listening
		// client's playback backlog continuously and triggering frequent
		// buffer trims, heard as distortion/dropouts (Nutzer-Report,
		// 2026-10-14: "rx audio: browser buffer trimmed" firing about once
		// a second for the whole duration of a TX). Skipping the
		// radio-origin broadcast during TX leaves only the mic relay
		// feeding the hubs — a single real-time stream again.
		if radioTX, _, _ := st.TXFlags(); !radioTX {
			broadcastRXAudio(pcm)
		}
		// Checked once per incoming packet (every ~20ms) rather than on a
		// separate timer — cheap (an atomic load), and only actually
		// broadcasts on a change, which real packet loss is rare enough
		// that this doesn't add meaningful broadcast traffic.
		if lost := arm.lostPackets(); lost != lastReportedLost {
			lastReportedLost = lost
			st.SetRxAudioLost(lost)
			broadcastState()
		}
	}

	// Diagnostic for the "Klatschen" (2026-10-11): audio packets that did not reach a
	// browser because its queue was full (server -> browser too slow). Logged only
	// when it happened; the matching radio -> server check is in internal/audio.
	go func() {
		var lastPCM, lastOpus uint64
		for range time.Tick(10 * time.Second) {
			p, o := pcmHub.Dropped(), opusHub.Dropped()
			if p != lastPCM || o != lastOpus {
				log.Printf("audio: packets dropped for slow browser clients, last 10 s: PCM %d, Opus %d", p-lastPCM, o-lastOpus)
				lastPCM, lastOpus = p, o
			}
		}
	}()

	// TX audio source ("MS" command). Remote TX sends its audio over LAN, so
	// while we are connected the radio must take SEND/PTT audio from the LAN
	// (rear, P3=3) with the front microphone off (P2=0). The settings found at
	// connect time are put back when we let go (disconnect, power off,
	// shutdown). Default if they could not be read: microphone + LAN.
	var txSrcMu sync.Mutex
	txSrcOrig := "13" // P2 (front) + P3 (rear) as found on the radio
	txSrcApplied := false
	applyTXSource := func(conn *radio.Conn) {
		for len(msReplies) > 0 {
			<-msReplies
		}
		if err := conn.Send("MS0"); err != nil {
			return
		}
		var found string
		select {
		case m := <-msReplies:
			found = m[3:]
		case <-time.After(2 * time.Second):
			log.Println("radio: TX audio source (MS) not answered, assuming mic + LAN as the original")
		}
		txSrcMu.Lock()
		// After a reconnect without a restore in between, the radio still
		// holds OUR setting: keep the original found earlier.
		if found != "" && !txSrcApplied {
			txSrcOrig = found
		}
		txSrcApplied = true
		orig := txSrcOrig
		txSrcMu.Unlock()
		log.Printf("radio: TX audio source: front mic off, LAN on (original MS0%s)", orig)
		if err := conn.Send("MS003"); err != nil {
			log.Printf("main: setting TX audio source failed: %v", err)
		}
	}
	restoreTXSource := func(conn *radio.Conn) {
		if conn == nil {
			return
		}
		txSrcMu.Lock()
		applied, orig := txSrcApplied, txSrcOrig
		txSrcApplied = false
		txSrcMu.Unlock()
		if !applied {
			return
		}
		log.Printf("radio: restoring TX audio source MS0%s", orig)
		if conn.Send("MS0"+orig) == nil {
			time.Sleep(150 * time.Millisecond) // let it leave the socket before closing
		}
	}

	// Band scope mode ("BS3"): the waterfall's VFO line and click-to-tune
	// both assume the radio is in "center" mode (see waterfall.js), so the
	// mode found at connect time is forced to center while a browser client
	// is around and put back when we let go (Nutzer-Wunsch, 2026-10-18) —
	// same remember/apply/restore shape as applyTXSource/restoreTXSource
	// above. Default if unreadable: "0" (center) — a reasonable guess, and
	// restoring to it is harmless even if wrong.
	var bs3Mu sync.Mutex
	bs3Orig := "0"
	bs3Applied := false
	applyBandScopeCenter := func(conn *radio.Conn) {
		for len(bs3Replies) > 0 {
			<-bs3Replies
		}
		if err := conn.Send("BS3"); err != nil {
			return
		}
		var found string
		select {
		case m := <-bs3Replies:
			found = m[3:]
		case <-time.After(2 * time.Second):
			log.Println("radio: band scope mode (BS3) not answered, assuming center as the original")
		}
		bs3Mu.Lock()
		// After a reconnect without a restore in between, the radio still
		// holds OUR setting: keep the original found earlier.
		if found != "" && !bs3Applied {
			bs3Orig = found
		}
		bs3Applied = true
		orig := bs3Orig
		bs3Mu.Unlock()
		log.Printf("radio: band scope mode: center (original BS3%s)", orig)
		if err := conn.Send("BS30"); err != nil {
			log.Printf("main: setting band scope center mode failed: %v", err)
		}
	}
	restoreBandScopeMode := func(conn *radio.Conn) {
		if conn == nil {
			return
		}
		bs3Mu.Lock()
		applied, orig := bs3Applied, bs3Orig
		bs3Applied = false
		bs3Mu.Unlock()
		if !applied {
			return
		}
		log.Printf("radio: restoring band scope mode BS3%s", orig)
		conn.Send("BS3" + orig)
	}

	// Speech processor (PROC): the PROC on/off state, input/output levels, and
	// effect type (Soft/Hard, "PR1" — a separate command from "PR0" on/off and
	// "PL" levels, see cat.EncodeProcType) found at connect time are put back
	// when we let go. The last choices made in the web UI are remembered
	// (-config, section "proc") and applied to the radio at the next connect (if they
	// differ from what the radio has). Levels are remembered as separate
	// Input/Output wants (not mode-dependent anymore — both are shown and
	// settable directly in the UI's PROC config overlay).
	var procMu sync.Mutex
	procApplied := false
	procOrigOn := false
	procOrigType := false
	procHaveType := false
	procOrigLevels := cat.ProcLevels{}
	procHaveLevels := false
	procWant, procHaveWant := false, false
	procWantType, procHaveWantType := false, false
	procWantIn, procHaveWantIn := 0, false
	procWantOut, procHaveWantOut := 0, false
	if data, ok := cfgStore.Read("proc"); ok {
		var c struct {
			Proc  string `json:"proc"`
			Off   bool   `json:"procOff"` // older files: only "off" was remembered
			Level *int   `json:"level"`   // older files: one value, Output's predecessor
			In    *int   `json:"in"`
			Out   *int   `json:"out"`
			Type  string `json:"type"` // "soft" / "hard"
		}
		if json.Unmarshal(data, &c) == nil {
			// An older file's single "level" seeds both — it predates the
			// Input/Output split, no way to know which one it really meant.
			if c.Level != nil {
				procWantIn, procHaveWantIn = *c.Level, true
				procWantOut, procHaveWantOut = *c.Level, true
			}
			if c.In != nil {
				procWantIn, procHaveWantIn = *c.In, true
			}
			if c.Out != nil {
				procWantOut, procHaveWantOut = *c.Out, true
			}
			switch c.Type {
			case "soft":
				procWantType, procHaveWantType = false, true
			case "hard":
				procWantType, procHaveWantType = true, true
			}
			switch {
			case c.Proc == "on":
				procWant, procHaveWant = true, true
			case c.Proc == "off" || c.Off:
				procWant, procHaveWant = false, true
			}
		}
	}
	// Caller holds procMu.
	writeProcConfig := func() {
		var c struct {
			Proc string `json:"proc,omitempty"`
			In   *int   `json:"in,omitempty"`
			Out  *int   `json:"out,omitempty"`
			Type string `json:"type,omitempty"`
		}
		if procHaveWant {
			c.Proc = "off"
			if procWant {
				c.Proc = "on"
			}
		}
		if procHaveWantIn {
			v := procWantIn
			c.In = &v
		}
		if procHaveWantOut {
			v := procWantOut
			c.Out = &v
		}
		if procHaveWantType {
			c.Type = "soft"
			if procWantType {
				c.Type = "hard"
			}
		}
		data, _ := json.Marshal(c)
		if err := cfgStore.Write("proc", data); err != nil {
			log.Printf("main: saving PROC setting to %s failed: %v", *configFile, err)
		}
	}
	saveProcPref := func(on bool) {
		procMu.Lock()
		defer procMu.Unlock()
		procWant, procHaveWant = on, true
		writeProcConfig()
	}
	saveProcType := func(hard bool) {
		procMu.Lock()
		defer procMu.Unlock()
		procWantType, procHaveWantType = hard, true
		writeProcConfig()
	}
	saveProcLevelIn := func(level int) {
		procMu.Lock()
		defer procMu.Unlock()
		procWantIn, procHaveWantIn = level, true
		writeProcConfig()
	}
	saveProcLevelOut := func(level int) {
		procMu.Lock()
		defer procMu.Unlock()
		procWantOut, procHaveWantOut = level, true
		writeProcConfig()
	}
	applyProcSettings := func(conn *radio.Conn) {
		for len(prReplies) > 0 {
			<-prReplies
		}
		for len(pr1Replies) > 0 {
			<-pr1Replies
		}
		for len(plReplies) > 0 {
			<-plReplies
		}
		var foundOn, haveOn bool
		var foundType, haveType bool
		var foundLevels cat.ProcLevels
		var haveLevels bool
		if conn.Send("PR0") == nil {
			select {
			case m := <-prReplies:
				if on, err := cat.ParseProc(m); err == nil {
					foundOn, haveOn = on, true
				}
			case <-time.After(2 * time.Second):
			}
		}
		if conn.Send("PR1") == nil {
			select {
			case m := <-pr1Replies:
				if hard, err := cat.ParseProcType(m); err == nil {
					foundType, haveType = hard, true
				}
			case <-time.After(2 * time.Second):
			}
		}
		if conn.Send("PL") == nil {
			select {
			case m := <-plReplies:
				if l, err := cat.ParseProcLevels(m); err == nil {
					foundLevels, haveLevels = l, true
				}
			case <-time.After(2 * time.Second):
			}
		}
		procMu.Lock()
		// After a reconnect without a restore in between, the radio still
		// holds OUR setting: keep the original found earlier.
		if !procApplied {
			if haveOn {
				procOrigOn = foundOn
			}
			if haveType {
				procOrigType, procHaveType = foundType, true
			}
			if haveLevels {
				procOrigLevels, procHaveLevels = foundLevels, true
			}
			procApplied = haveOn || haveType || haveLevels
		}
		want, haveWant := procWant, procHaveWant
		wantType, haveWantType := procWantType, procHaveWantType
		wantIn, haveWantIn := procWantIn, procHaveWantIn
		wantOut, haveWantOut := procWantOut, procHaveWantOut
		procMu.Unlock()
		if haveLevels && ((haveWantIn && wantIn != foundLevels.Input) || (haveWantOut && wantOut != foundLevels.Output)) {
			l := foundLevels
			if haveWantIn {
				l.Input = wantIn
			}
			if haveWantOut {
				l.Output = wantOut
			}
			if cmd, err := cat.EncodeProcLevels(l); err == nil {
				log.Printf("radio: applying PROC levels remembered from this tool: %s", cmd)
				if err := conn.Send(cmd); err != nil {
					log.Printf("main: applying PROC levels failed: %v", err)
				}
			}
		}
		if haveWantType && haveType && wantType != foundType {
			cmd, _ := cat.EncodeProcType(wantType)
			log.Printf("radio: applying PROC type remembered from this tool: %s", cmd)
			if err := conn.Send(cmd); err != nil {
				log.Printf("main: applying PROC type failed: %v", err)
			}
		}
		if haveWant && haveOn && want != foundOn {
			cmd, _ := cat.EncodeProc(want)
			log.Printf("radio: applying PROC choice remembered from this tool: %s", cmd)
			if err := conn.Send(cmd); err != nil {
				log.Printf("main: applying PROC choice failed: %v", err)
			}
		}
	}
	restoreProcSettings := func(conn *radio.Conn) {
		procMu.Lock()
		applied := procApplied
		on, levels, haveLevels := procOrigOn, procOrigLevels, procHaveLevels
		procType, haveType := procOrigType, procHaveType
		procApplied = false
		procMu.Unlock()
		if !applied {
			return
		}
		if haveLevels {
			if cmd, err := cat.EncodeProcLevels(levels); err == nil {
				log.Printf("radio: restoring PROC levels %s", cmd)
				conn.Send(cmd)
			}
		}
		if haveType {
			if cmd, err := cat.EncodeProcType(procType); err == nil {
				log.Printf("radio: restoring PROC type %s", cmd)
				conn.Send(cmd)
			}
		}
		cmd, _ := cat.EncodeProc(on)
		log.Printf("radio: restoring PROC state %s", cmd)
		conn.Send(cmd)
	}
	// remoteActive is true exactly while at least one browser client is
	// connected (set by Controls.OnFirstClientConnected, cleared ONLY by
	// Controls.OnAllClientsGone, 15s after the last client leaves — see that
	// function's own comment for why restoreRadioSettings itself must not
	// touch it). Gates every remote-operation override below (PROC/MIC
	// input/TX-EQ/RX-EQ/TX monitor): a plain server<->radio KNS connection on
	// its own — server startup, "KNS auto connect", a radio power-cycle
	// reconnect — must NOT touch the radio at all when nobody is actually
	// operating it remotely (Nutzer-Wunsch, 2026-10-14: "da kein Benutzer
	// aktiv braucht es das ja nicht" — correct, the old code forced these
	// overrides on every KNS dial regardless of client count, which could
	// silently change a purely-local, nobody-watching radio the moment the
	// Pi's auto-connect happened to dial in).
	var remoteActive atomic.Bool

	// Remembered TX/RX equalizer and TX monitor on/off choices (Nutzer-
	// Wunsch, 2026-10-14: "wie PROC persistieren" — same idea as procWant
	// below: the LAST choice made in the web UI, applied to the radio
	// whenever a remote session starts, surviving server restarts. Without
	// this, forceTXEQOff/forceRXEQOff/forceTXMonOff only had eqUserOn/
	// eqRxUserOn/txMonUserOn to go on — purely in-memory for the CURRENT
	// session, cleared on every restore — so turning e.g. RX EQ on, ending
	// the session, and starting a new one later never brought it back; only
	// PROC (which already had this) did. TX-EQ/RX-EQ stay per-mode (matching
	// their own per-mode capture/restore, since the radio genuinely has a
	// separate EQT0/EQR0 state per mode); TX monitor is a single global
	// value (MO0 isn't documented as mode-restricted the way EQT0 is).
	var eqCfg struct {
		TXEq  map[string]bool `json:"txEq"`
		RXEq  map[string]bool `json:"rxEq"`
		TXMon *bool           `json:"txMon"`
	}
	if data, ok := cfgStore.Read("eq"); ok {
		json.Unmarshal(data, &eqCfg)
	}
	if eqCfg.TXEq == nil {
		eqCfg.TXEq = map[string]bool{}
	}
	if eqCfg.RXEq == nil {
		eqCfg.RXEq = map[string]bool{}
	}
	var eqCfgMu sync.Mutex
	writeEQConfig := func() {
		// Caller holds eqCfgMu.
		data, _ := json.Marshal(eqCfg)
		if err := cfgStore.Write("eq", data); err != nil {
			log.Printf("main: saving TX/RX equalizer and TX monitor preferences to %s failed: %v", *configFile, err)
		}
	}
	saveTXEQPref := func(mode string, on bool) {
		eqCfgMu.Lock()
		defer eqCfgMu.Unlock()
		eqCfg.TXEq[mode] = on
		writeEQConfig()
	}
	saveRXEQPref := func(mode string, on bool) {
		eqCfgMu.Lock()
		defer eqCfgMu.Unlock()
		eqCfg.RXEq[mode] = on
		writeEQConfig()
	}
	saveTXMonPref := func(on bool) {
		eqCfgMu.Lock()
		defer eqCfgMu.Unlock()
		eqCfg.TXMon = &on
		writeEQConfig()
	}
	// txEqWant/rxEqWant/txMonWant read a remembered preference; ok is false
	// if none was ever saved for that key (vs. a saved "off").
	txEqWant := func(mode string) (want, ok bool) {
		eqCfgMu.Lock()
		defer eqCfgMu.Unlock()
		v, ok := eqCfg.TXEq[mode]
		return v, ok
	}
	rxEqWant := func(mode string) (want, ok bool) {
		eqCfgMu.Lock()
		defer eqCfgMu.Unlock()
		v, ok := eqCfg.RXEq[mode]
		return v, ok
	}
	txMonWant := func() (want, ok bool) {
		eqCfgMu.Lock()
		defer eqCfgMu.Unlock()
		if eqCfg.TXMon == nil {
			return false, false
		}
		return *eqCfg.TXMon, true
	}
	// TX equalizer ("EQT0"): it colours the transmitted audio and falsifies remote
	// operation, so it is switched OFF while we are connected and put back when we
	// let go. The radio reads/sets it for the SELECTED TRANSMIT MODE only and not at
	// all in CW/FSK/PSK, so this is done per mode: whenever the radio is in a mode
	// that has the equalizer (at connect and on every mode change) it is checked, and
	// the state found there is remembered per mode. At restore time only the mode the
	// radio is in then can be put back; equalizers we switched off in other modes
	// during the session cannot be reached without changing the radio's mode, and
	// stay off (reported in the log).
	var eqMu sync.Mutex
	eqOrig := map[string]bool{}   // mode -> equalizer state found before we touched it
	eqOff := map[string]bool{}    // modes where WE switched it off
	eqChecked := ""               // mode last checked
	eqUserOn := map[string]bool{} // modes where the operator switched the TX equalizer ON in the UI
	var eqOpMu sync.Mutex         // one check at a time
	onOffWord := func(on bool) string {
		if on {
			return "ON"
		}
		return "OFF"
	}
	forceTXEQOff := func(conn *radio.Conn, mode string) {
		if conn == nil || !cat.TXEQApplies(mode) {
			return
		}
		eqOpMu.Lock()
		defer eqOpMu.Unlock()
		for len(eqReplies) > 0 {
			<-eqReplies
		}
		if err := conn.Send("EQT0"); err != nil {
			return
		}
		var on bool
		select {
		case m := <-eqReplies:
			v, err := cat.ParseTXEQ(m)
			if err != nil {
				return
			}
			on = v
		case <-time.After(2 * time.Second):
			log.Printf("radio: TX equalizer (EQT0) not answered in mode %s", mode)
			return
		}
		eqMu.Lock()
		if _, seen := eqOrig[mode]; !seen {
			eqOrig[mode] = on
		}
		if on {
			eqOff[mode] = true
		}
		orig := eqOrig[mode]
		eqMu.Unlock()
		// effect shown in the UI (voice modes only, like EQT0 itself)
		conn.Send("EQT1")
		// A remembered preference (Nutzer-Wunsch, 2026-10-14: "wie PROC
		// persistieren") wins over both "leave as found" and "force off
		// unless chosen this session" below — applied unconditionally
		// whenever it differs from what's live, same as PROC's own want-vs-
		// found comparison in applyProcSettings.
		if want, ok := txEqWant(mode); ok {
			if want != on {
				log.Printf("radio: applying TX equalizer preference remembered from this tool: %s in mode %s", onOffWord(want), mode)
				conn.Send(cat.EncodeTXEQ(want))
				conn.Send("EQT0")
			}
			if want {
				eqMu.Lock()
				eqUserOn[mode] = true
				eqMu.Unlock()
			}
			return
		}
		if !on {
			return
		}
		eqMu.Lock()
		userWants := eqUserOn[mode]
		eqMu.Unlock()
		if userWants {
			return // the operator chose ON for this mode in the UI
		}
		log.Printf("radio: TX equalizer was ON in mode %s (original: %v), switched OFF for remote operation", mode, orig)
		if err := conn.Send(cat.EncodeTXEQ(false)); err != nil {
			log.Printf("main: switching TX equalizer off failed: %v", err)
			return
		}
		conn.Send("EQT0") // let the UI show the new state
	}
	// RX equalizer ("EQR0"): same reasoning and structure as the TX equalizer
	// above, just for the receive side — colours what every connected browser
	// hears over the shared LAN RX audio stream (not something a browser could
	// undo on its own), so it is handled identically: switched off while
	// connected unless the operator explicitly chose ON in the UI for this
	// mode, and the original per-mode state is put back when we let go
	// (2026-10-14, Nutzer-Wunsch "RX EQ auch mit aufnehmen").
	var eqRxMu sync.Mutex
	eqRxOrig := map[string]bool{}
	eqRxOff := map[string]bool{}
	eqRxChecked := ""
	eqRxUserOn := map[string]bool{}
	var eqRxOpMu sync.Mutex
	forceRXEQOff := func(conn *radio.Conn, mode string) {
		if conn == nil || !cat.RXEQApplies(mode) {
			return
		}
		eqRxOpMu.Lock()
		defer eqRxOpMu.Unlock()
		for len(eqRxReplies) > 0 {
			<-eqRxReplies
		}
		if err := conn.Send("EQR0"); err != nil {
			return
		}
		var on bool
		select {
		case m := <-eqRxReplies:
			v, err := cat.ParseRXEQ(m)
			if err != nil {
				return
			}
			on = v
		case <-time.After(2 * time.Second):
			log.Printf("radio: RX equalizer (EQR0) not answered in mode %s", mode)
			return
		}
		eqRxMu.Lock()
		if _, seen := eqRxOrig[mode]; !seen {
			eqRxOrig[mode] = on
		}
		if on {
			eqRxOff[mode] = true
		}
		orig := eqRxOrig[mode]
		eqRxMu.Unlock()
		// effect shown in the UI (voice modes only, like EQR0 itself)
		conn.Send("EQR1")
		if want, ok := rxEqWant(mode); ok {
			if want != on {
				log.Printf("radio: applying RX equalizer preference remembered from this tool: %s in mode %s", onOffWord(want), mode)
				conn.Send(cat.EncodeRXEQ(want))
				conn.Send("EQR0")
			}
			if want {
				eqRxMu.Lock()
				eqRxUserOn[mode] = true
				eqRxMu.Unlock()
			}
			return
		}
		if !on {
			return
		}
		eqRxMu.Lock()
		userWants := eqRxUserOn[mode]
		eqRxMu.Unlock()
		if userWants {
			return // the operator chose ON for this mode in the UI
		}
		log.Printf("radio: RX equalizer was ON in mode %s (original: %v), switched OFF for remote operation", mode, orig)
		if err := conn.Send(cat.EncodeRXEQ(false)); err != nil {
			log.Printf("main: switching RX equalizer off failed: %v", err)
			return
		}
		conn.Send("EQR0") // let the UI show the new state
	}
	onModeChanged = func() {
		conn := rm.current()
		mode := st.Mode()
		if conn == nil || !remoteActive.Load() {
			return
		}
		if cat.TXEQApplies(mode) {
			eqMu.Lock()
			same := eqChecked == mode
			eqChecked = mode
			eqMu.Unlock()
			if !same {
				go forceTXEQOff(conn, mode)
			}
		}
		if cat.RXEQApplies(mode) {
			eqRxMu.Lock()
			same := eqRxChecked == mode
			eqRxChecked = mode
			eqRxMu.Unlock()
			if !same {
				go forceRXEQOff(conn, mode)
			}
		}
	}
	// touched (eqOff ∪ eqUserOn) is every mode where the LIVE state might
	// differ from eqOrig this session, regardless of which direction caused
	// it: eqOff is set when WE auto-switched it off (forceTXEQOff), eqUserOn
	// when the OPERATOR explicitly switched it on via the UI (SetTXEQ) — a
	// bug found live (2026-10-14, Nutzer-Frage: "wenn ich TX EQ aktiviere
	// und die Browser Session beende... wird dann wieder TX EQ aktiviert?"):
	// the OLD code here only ever considered eqOff and only ever sent ON,
	// so an operator's explicit ON choice was never reverted on restore —
	// TX-EQ stayed on at the radio indefinitely (until a mode change/
	// reconnect happened to re-run forceTXEQOff), exactly the "local
	// operator finds it still on the remote operator's setting" problem the
	// idle-restore feature exists to prevent. Restoring to orig[mode]
	// (whichever direction that actually is) for every touched mode fixes
	// both: our own auto-off gets put back ON, the operator's explicit ON
	// gets put back OFF.
	restoreTXEQ := func(conn *radio.Conn) {
		eqMu.Lock()
		orig := eqOrig
		touched := map[string]bool{}
		for m := range eqOff {
			touched[m] = true
		}
		for m := range eqUserOn {
			touched[m] = true
		}
		eqOrig, eqOff, eqChecked, eqUserOn = map[string]bool{}, map[string]bool{}, "", map[string]bool{}
		eqMu.Unlock()
		if conn == nil {
			return
		}
		mode := st.Mode()
		for m := range touched {
			if m != mode {
				log.Printf("radio: TX equalizer of mode %s could not be restored to %s (radio is in mode %s)", m, onOffWord(orig[m]), mode)
			}
		}
		if touched[mode] && cat.TXEQApplies(mode) {
			log.Printf("radio: restoring TX equalizer %s in mode %s", onOffWord(orig[mode]), mode)
			conn.Send(cat.EncodeTXEQ(orig[mode]))
		}
	}
	restoreRXEQ := func(conn *radio.Conn) {
		eqRxMu.Lock()
		orig := eqRxOrig
		touched := map[string]bool{}
		for m := range eqRxOff {
			touched[m] = true
		}
		for m := range eqRxUserOn {
			touched[m] = true
		}
		eqRxOrig, eqRxOff, eqRxChecked, eqRxUserOn = map[string]bool{}, map[string]bool{}, "", map[string]bool{}
		eqRxMu.Unlock()
		if conn == nil {
			return
		}
		mode := st.Mode()
		for m := range touched {
			if m != mode {
				log.Printf("radio: RX equalizer of mode %s could not be restored to %s (radio is in mode %s)", m, onOffWord(orig[m]), mode)
			}
		}
		if touched[mode] && cat.RXEQApplies(mode) {
			log.Printf("radio: restoring RX equalizer %s in mode %s", onOffWord(orig[mode]), mode)
			conn.Send(cat.EncodeRXEQ(orig[mode]))
		}
	}
	// TX Monitor ("MO0"): treated the same as TX/RX-EQ above (Nutzer-Wunsch,
	// 2026-10-14) — forced off while remote unless the operator explicitly
	// chose on this session or via a remembered preference, restored to the
	// pre-session original on disconnect/idle. Global, not per-mode (MO0/ML
	// aren't documented as mode-restricted the way EQT0 is), so this mirrors
	// PROC's simpler single-value capture/restore (an "applied" flag plus one
	// orig value) instead of TX/RX-EQ's per-mode bookkeeping.
	var txMonMu sync.Mutex
	var txMonApplied bool
	var txMonOrig bool
	var txMonUserOn bool
	var txMonOpMu sync.Mutex
	forceTXMonOff := func(conn *radio.Conn) {
		if conn == nil {
			return
		}
		txMonOpMu.Lock()
		defer txMonOpMu.Unlock()
		for len(txMonReplies) > 0 {
			<-txMonReplies
		}
		if err := conn.Send("MO0"); err != nil {
			return
		}
		var on bool
		select {
		case m := <-txMonReplies:
			v, err := cat.ParseTXMonitor(m)
			if err != nil {
				return
			}
			on = v
		case <-time.After(2 * time.Second):
			log.Println("radio: TX monitor (MO0) not answered")
			return
		}
		txMonMu.Lock()
		if !txMonApplied {
			txMonOrig = on
			txMonApplied = true
		}
		orig := txMonOrig
		txMonMu.Unlock()
		if want, ok := txMonWant(); ok {
			if want != on {
				log.Printf("radio: applying TX monitor preference remembered from this tool: %s", onOffWord(want))
				conn.Send(cat.EncodeTXMonitor(want))
			}
			if want {
				txMonMu.Lock()
				txMonUserOn = true
				txMonMu.Unlock()
			}
			return
		}
		if !on {
			return
		}
		txMonMu.Lock()
		userWants := txMonUserOn
		txMonMu.Unlock()
		if userWants {
			return // the operator chose ON this session in the UI
		}
		log.Printf("radio: TX monitor was ON (original: %v), switched OFF for remote operation", orig)
		if err := conn.Send(cat.EncodeTXMonitor(false)); err != nil {
			log.Printf("main: switching TX monitor off failed: %v", err)
		}
	}
	restoreTXMon := func(conn *radio.Conn) {
		txMonMu.Lock()
		applied, orig := txMonApplied, txMonOrig
		txMonApplied, txMonUserOn = false, false
		txMonMu.Unlock()
		if conn == nil || !applied {
			return
		}
		log.Printf("radio: restoring TX monitor %s", onOffWord(orig))
		conn.Send(cat.EncodeTXMonitor(orig))
	}
	// Everything we changed on the radio for our session, put back.
	//
	// Deliberately does NOT touch remoteActive (an earlier version cleared it
	// right here, unconditionally — wrong: most callers of this function
	// (explicit Trennen, radio power-off, reconnect-to-a-different-radio)
	// can run with a browser client very much still connected, e.g. the same
	// operator who just clicked "Trennen" in the Setup overlay clicking
	// "Verbinden" right after. Clearing remoteActive there made the
	// subsequent connectRadio treat that reconnect as "nobody's watching"
	// and skip re-applying PROC/MIC input/TX-EQ/RX-EQ entirely — live bug,
	// 2026-10-14: "beim manuellen trennen und verbinden ... werden die Werte
	// die wir uns für remote Betrieb merken ... nicht gesetzt", and the same
	// gap affected a remote power OFF/ON cycle for the same reason. Only
	// Controls.OnAllClientsGone (genuinely zero clients) clears remoteActive
	// now, right where it already belongs.
	restoreRadioSettings := func(conn *radio.Conn) {
		if conn == nil {
			return
		}
		restoreTXEQ(conn)
		restoreRXEQ(conn)
		restoreTXMon(conn)
		restoreProcSettings(conn)
		restoreTXSource(conn)
		restoreBandScopeMode(conn)
	}

	// The radio has no readback for the scope rate, so remember the last one
	// the browser chose and re-apply it after every (re)connect — otherwise
	// initialQueries' DD01 silently resets a Mid/Lo choice to fast.
	var scopeRateMu sync.Mutex
	scopeRate := "high"

	// Last successfully used connection settings, so "power on" can redial
	// the radio after it was switched off (or never connected this run).
	var lastReq *web.ConnectRequest
	var lastReqMu sync.Mutex
	connectRadio := func(req web.ConnectRequest) error {
		port := req.Port
		if port == 0 {
			port = radio.DefaultPort
		}
		voipPort := req.VoipPort
		if voipPort == 0 {
			voipPort = audio.DefaultPort
		}
		addr := fmt.Sprintf("%s:%d", req.Host, port)
		creds := radio.Credentials{Username: req.User, Password: req.Pass, IsAdmin: req.Admin}

		onClose := func() {
			st.SetConnected(false)
			broadcastState()
		}

		connectTO, loginTO := 5*time.Second, 5*time.Second
		if req.Timeout > 0 {
			connectTO, loginTO = req.Timeout, 15*time.Second
		}
		conn, err := radio.DialTimeout(addr, creds, onMsg, onClose, connectTO, loginTO)
		if err != nil {
			return err
		}

		if old := rm.swap(conn); old != nil {
			restoreRadioSettings(old)
			old.Close()
		}

		// The KNS VoIP port is user-configurable, so both the RX listener and
		// the TX sender's destination need to be (re)bound to it on every
		// (re)connect, not just once at startup on a fixed port.
		if receiver, err := audio.Listen(voipPort, onPCM); err != nil {
			log.Printf("main: opening RX audio receiver on port %d failed (RX audio unavailable): %v", voipPort, err)
		} else if old := arm.swap(receiver); old != nil {
			old.Close()
		}

		if txSender, err := audio.NewTXSender(req.Host, voipPort); err != nil {
			log.Printf("main: opening TX audio sender failed (TX mic audio unavailable): %v", err)
		} else if old := txm.swap(txSender); old != nil {
			old.Close()
		}

		lastReqMu.Lock()
		lastReq = &req
		lastReqMu.Unlock()
		st.SetRadioConnection(req.Host, port, voipPort, req.User, req.Admin)
		st.SetConnected(true)
		broadcastState()
		log.Printf("radio: connected to %s (from %s)", addr, conn.LocalAddr())

		for _, cmd := range initialQueries {
			if err := conn.Send(cmd); err != nil {
				log.Printf("main: sending initial query %q failed: %v", cmd, err)
			}
		}
		// The VoIP/RX audio stream runs only while a browser client is
		// connected (Nutzer-Wunsch, 2026-10-16): with nobody here it would
		// only be thrown away, and a long-running stream is what tended to
		// develop the delayed echo. A client arriving later starts it fresh
		// (Controls.OnFirstClientConnected), the last one leaving stops it.
		if remoteActive.Load() {
			if err := conn.Send("##VP1"); err != nil {
				log.Printf("main: starting the VoIP stream failed: %v", err)
			}
		} else if err := conn.Send("##VP0"); err != nil {
			log.Printf("main: stopping the idle VoIP stream failed: %v", err)
		}
		wantMeterMu.Lock()
		if code := meterCode(wantMeter); code != "" {
			_ = conn.Send("RM" + code + "1")
		}
		wantMeterMu.Unlock()
		// Remote-operation overrides (MIC input/PROC/TX-EQ/RX-EQ/TX monitor/band scope mode) only belong
		// here if a browser client was ALREADY connected at the moment this
		// (re)dial happened — e.g. the radio power-cycled and redialled while
		// people were using it. The far more common case, a plain KNS
		// auto-connect at server startup or an operator-triggered reconnect
		// with nobody watching yet, must leave the radio untouched
		// (Controls.OnFirstClientConnected below is what applies these the
		// very first time someone actually connects).
		if remoteActive.Load() {
			// check the TX/RX equalizers again with the first mode report of
			// this connection (also after a reconnect without restore: the
			// radio may have been power cycled)
			eqMu.Lock()
			eqChecked = ""
			eqMu.Unlock()
			eqRxMu.Lock()
			eqRxChecked = ""
			eqRxMu.Unlock()
			go applyTXSource(conn)
			go applyProcSettings(conn)
			go forceTXMonOff(conn)
			go applyBandScopeCenter(conn)
		}
		scopeRateMu.Lock()
		rate := scopeRate
		scopeRateMu.Unlock()
		if rate != "high" {
			if cmd, err := cat.EncodeBandScopeRate(rate); err == nil {
				if err := conn.Send(cmd); err != nil {
					log.Printf("main: restoring scope rate %q failed: %v", rate, err)
				}
			}
		}
		return nil
	}

	// KNS settings remembered from the web UI (-config file, section "kns"). With
	// "KNS auto connect" on they are used at start when no -knsip was given.
	var knsCfg struct {
		Host     string `json:"host"`
		Port     int    `json:"port"`
		VoipPort int    `json:"voipPort"`
		User     string `json:"user"`
		Pass     string `json:"pass"`
		Admin    bool   `json:"admin"`
		Auto     bool   `json:"auto"`
		Mac      string `json:"mac"` // radio MAC for Wake-on-LAN
	}
	var knsCfgMu sync.Mutex
	if data, ok := cfgStore.Read("kns"); ok {
		json.Unmarshal(data, &knsCfg)
	}
	st.SetKnsAuto(knsCfg.Auto)
	st.SetKnsMac(knsCfg.Mac)
	saveKnsCfgLocked := func() {
		data, _ := json.Marshal(knsCfg)
		// the file is 0600: it contains the KNS password.
		if err := cfgStore.Write("kns", data); err != nil {
			log.Printf("kns: saving settings to %s failed: %v", *configFile, err)
		}
	}
	// learnMAC remembers the radio's MAC from the ARP cache (the radio was
	// just contacted, so it's there) when none is known yet, for Wake-on-LAN.
	learnMAC := func(host string) {
		knsCfgMu.Lock()
		defer knsCfgMu.Unlock()
		if knsCfg.Mac != "" || host == "" {
			return
		}
		if mac := radio.LookupMAC(host); mac != "" {
			knsCfg.Mac = mac
			st.SetKnsMac(mac)
			if knsCfg.Host != "" { // only persist alongside an existing saved config
				saveKnsCfgLocked()
			}
		}
	}
	// Browser-initiated connect: remember the settings after it succeeded.
	connectFromUI := func(req web.ConnectRequest) error {
		// The KNS only tolerates one session and drops the working one when a
		// second login attempt arrives, so never redial an identical, already
		// active connection (e.g. OK in the settings dialog without changes).
		// Only the remembered settings (password, auto connect) are updated.
		lastReqMu.Lock()
		prev := lastReq
		lastReqMu.Unlock()
		sameAsActive := rm.current() != nil && st.Connected() && prev != nil &&
			prev.Host == req.Host &&
			orDefault(prev.Port, radio.DefaultPort) == orDefault(req.Port, radio.DefaultPort) &&
			orDefault(prev.VoipPort, audio.DefaultPort) == orDefault(req.VoipPort, audio.DefaultPort) &&
			prev.User == req.User && prev.Admin == req.Admin
		// "First come, first serve" (Nutzer-Wunsch, 2026-10-14): a DIFFERENT
		// target while a session is already up is refused outright, not
		// silently redialled — without this, any client's "Verbinden" (a
		// second operator's browser, still holding a different host/user/etc.
		// from an earlier session in its own localStorage) would evict the
		// session someone else is actively using (same KNS single-session
		// eviction this function already protects the IDENTICAL-request case
		// from). The app.js Setup overlay already avoids resubmitting an
		// unchanged, already-active connection on its own (pre-fills every
		// field but the password from the server's live-reported values
		// while connected) — this is the server-side backstop for every
		// other case: a deliberately edited host/port/user, or any other
		// client that doesn't run that same JS logic. Whoever actually wants
		// to point this server at a different radio has to explicitly
		// disconnect first (Setup overlay's "Trennen"/toggle button), which
		// already runs restoreRadioSettings cleanly before freeing the
		// session up.
		//
		// Checks rm.current() (set/cleared synchronously by connectRadio and
		// closeRadio/disconnectRadio), NOT st.Connected(): that flag is only
		// flipped to false later, asynchronously, by radio.Conn's onClose
		// callback once its readLoop goroutine notices the socket actually
		// closed (radio/conn.go) — conn.Close() itself doesn't wait for
		// that. Checking st.Connected() here raced with that: Trennen
		// followed right away by "Verbinde WebServer <-> TS890" (the
		// Setup overlay's own toggle button, deliberately a single click)
		// regularly hit the window where rm.current() was already nil but
		// st.Connected() hadn't caught up yet — the explicit reconnect got
		// rejected as "already connected" even though nothing was (live
		// Nutzer-Report, 2026-10-14: "dann geht der Verbinden Button"
		// nicht mehr, nur durch einen Umweg der zufällig genug Zeit liess
		// zuverlässig reproduzierbar). rm.current() has no such gap.
		if !sameAsActive && rm.current() != nil {
			return fmt.Errorf("already connected to %s — disconnect first before connecting elsewhere", prev.Host)
		}
		if !sameAsActive {
			if err := connectRadio(req); err != nil {
				return err
			}
		}
		knsCfgMu.Lock()
		knsCfg.Host, knsCfg.Port, knsCfg.VoipPort = req.Host, req.Port, req.VoipPort
		knsCfg.User, knsCfg.Pass, knsCfg.Admin, knsCfg.Auto = req.User, req.Pass, req.Admin, req.Auto
		saveKnsCfgLocked()
		knsCfgMu.Unlock()
		st.SetKnsAuto(req.Auto)
		learnMAC(req.Host)
		broadcastState()
		return nil
	}
	setKnsMac := func(mac string) error {
		norm, err := radio.NormalizeMAC(mac)
		if err != nil {
			return err
		}
		knsCfgMu.Lock()
		knsCfg.Mac = norm
		saveKnsCfgLocked()
		knsCfgMu.Unlock()
		st.SetKnsMac(norm)
		broadcastState()
		return nil
	}
	setKnsAuto := func(enabled bool) error {
		knsCfgMu.Lock()
		knsCfg.Auto = enabled
		saveKnsCfgLocked()
		knsCfgMu.Unlock()
		st.SetKnsAuto(enabled)
		broadcastState()
		return nil
	}

	// Power button: off = "PS0" on the live session. On = "PS1"; without a
	// live session, first (re)dial with the last used / remembered settings.
	// Untested against real hardware whether a switched-off TS-890 still
	// accepts the KNS login to receive PS1.
	if *host != "" {
		log.Printf("connecting to %s ...", *host)
		if err := connectRadio(web.ConnectRequest{Host: *host, Port: *port, VoipPort: *voipPort, User: *username, Pass: *password, Admin: *admin}); err != nil {
			log.Printf("radio: not reachable at start (switched off?) — use the power button or the settings in the web UI (%v)", err)
		} else {
			learnMAC(*host)
		}
	} else if knsCfg.Auto && knsCfg.Host != "" {
		log.Printf("kns auto connect to %s ...", knsCfg.Host)
		if err := connectRadio(web.ConnectRequest{Host: knsCfg.Host, Port: knsCfg.Port, VoipPort: knsCfg.VoipPort, User: knsCfg.User, Pass: knsCfg.Pass, Admin: knsCfg.Admin}); err != nil {
			log.Printf("radio: not reachable at start (switched off?) — use the power button or the settings in the web UI (%v)", err)
		} else {
			learnMAC(knsCfg.Host)
		}
	}

	sendEncoded := func(encode func() (string, error)) error {
		conn := rm.current()
		if conn == nil {
			return fmt.Errorf("not connected to radio")
		}
		cmd, err := encode()
		if err != nil {
			return err
		}
		return conn.Send(cmd)
	}

	// resetRXAudio is the low-risk alternative to a full CAT reconnect for
	// clearing RX audio dropouts (Nutzer-Wunsch, 2026-09-29, after ruling out
	// touching CAT at all if possible): toggles the radio's own RTP sender
	// off and back on via "##VP0"/"##VP1" on the EXISTING, already-logged-in
	// CAT session, instead of tearing down and redialing the whole KNS
	// session. Never touches rm/arm/txm, so it can't trip the single-session
	// KNS rejection the full-reconnect path had to work around. Genuinely
	// untested against real hardware — the previous, narrower attempt
	// (re-binding our own RX UDP socket + re-sending a bare "##VP1" without
	// ever turning it off first) was confirmed live as insufficient, but an
	// actual off/on cycle of the radio's own sender is a meaningfully
	// different, not-yet-tried action, not just a repeat of that. Small
	// delay between the two so the radio has a moment to actually tear down
	// its RTP sender before being asked to start a new one (not measured
	// against real hardware — a reasonable margin, not a confirmed value).
	// One reset at a time (manual button and the auto sync below may overlap);
	// lastRXSync is when the stream was last reset, by either.
	var rxResetMu sync.Mutex
	var lastRXSync atomic.Int64 // unix nanoseconds
	// Last moment the radio was (or was just asked to be) transmitting or tuning; the
	// auto sync below stays away for a few seconds after it.
	var lastTXActivity atomic.Int64
	resetRXAudio := func() error {
		rxResetMu.Lock()
		defer rxResetMu.Unlock()
		conn := rm.current()
		if conn == nil {
			return fmt.Errorf("not connected to radio")
		}
		// Stopping/restarting the radio's own RTP sender is a deliberate
		// stream restart, not real loss — the resulting sequence-number
		// jump would otherwise get counted as a burst of lost packets, and
		// live-reported (2026-09-29): the OLD accumulated count also just
		// sits there afterward even once nothing is actually being lost
		// anymore, no longer a useful "is there a problem right now"
		// signal. Reset before touching ##VP0/##VP1 so the UI reflects
		// zero immediately rather than waiting for the next packet to
		// happen to change the value.
		arm.resetLoss()
		st.SetRxAudioLost(0)
		broadcastState()
		if err := conn.Send("##VP0"); err != nil {
			return fmt.Errorf("stopping RX audio stream: %w", err)
		}
		// Measured 2026-10-16 (tcpdump on the Pi): the radio stops sending
		// at once on ##VP0 and needs ~150 ms to start again after ##VP1;
		// the pause here is only a safety margin.
		time.Sleep(50 * time.Millisecond)
		if err := conn.Send("##VP1"); err != nil {
			return fmt.Errorf("restarting RX audio stream: %w", err)
		}
		lastRXSync.Store(time.Now().UnixNano())
		return nil
	}

	// "VOIP auto sync" (Nutzer-Wunsch, 2026-10-16): the radio's LAN audio
	// stream sometimes drifts into a state with a delayed echo that only a
	// ##VP0/##VP1 cycle clears (see the notes), so the server repeats that
	// cycle on its own every N minutes (1-10, default 5, on by default).
	// It waits while the radio transmits or tunes (TX audio uses the same
	// VoIP link, untested whether a reset would cut it) and when nobody is
	// listening, and restarts its window whenever the setting changes.
	var voipCfg struct {
		Auto    *bool `json:"auto"` // nil = never saved = on
		Minutes int   `json:"minutes"`
	}
	if data, ok := cfgStore.Read("voip"); ok {
		json.Unmarshal(data, &voipCfg)
	}
	var voipMu sync.Mutex
	voipAuto := voipCfg.Auto == nil || *voipCfg.Auto
	voipMinutes := voipCfg.Minutes
	if voipMinutes < 1 || voipMinutes > 10 {
		voipMinutes = 5
	}
	st.SetVoipAutoSync(voipAuto, voipMinutes)
	setVoipAutoSync := func(enabled bool, minutes int) error {
		if minutes < 1 {
			minutes = 1
		}
		if minutes > 10 {
			minutes = 10
		}
		voipMu.Lock()
		voipAuto, voipMinutes = enabled, minutes
		data, _ := json.Marshal(struct {
			Auto    bool `json:"auto"`
			Minutes int  `json:"minutes"`
		}{enabled, minutes})
		if err := cfgStore.Write("voip", data); err != nil {
			log.Printf("main: saving auto sync setting to %s failed: %v", *configFile, err)
		}
		voipMu.Unlock()
		st.SetVoipAutoSync(enabled, minutes)
		lastRXSync.Store(time.Now().UnixNano()) // a full new window
		broadcastState()
		return nil
	}
	go func() {
		lastRXSync.Store(time.Now().UnixNano())
		for range time.Tick(5 * time.Second) {
			voipMu.Lock()
			on, window := voipAuto, time.Duration(voipMinutes)*time.Minute
			voipMu.Unlock()
			if !on || !st.Connected() || pcmHub.Len()+opusHub.Len() == 0 {
				lastRXSync.Store(time.Now().UnixNano()) // nothing to keep in sync: wait a full window after this
				continue
			}
			if radioTX, _, ampTX := st.TXFlags(); radioTX || ampTX || st.Tuner().TuningActive {
				lastTXActivity.Store(time.Now().UnixNano())
				continue // try again right after
			}
			// Also not in the first seconds after TX/tune ended (or was just
			// requested, before the radio confirmed it).
			if time.Since(time.Unix(0, lastTXActivity.Load())) < 5*time.Second {
				continue
			}
			if time.Since(time.Unix(0, lastRXSync.Load())) < window {
				continue
			}
			if err := resetRXAudio(); err != nil {
				log.Printf("audio: auto sync failed: %v", err)
				lastRXSync.Store(time.Now().UnixNano())
			} else {
				log.Printf("audio: auto sync (VoIP stream restarted, every %d min)", int(window.Minutes()))
			}
		}
	}()

	// disconnectRadio is the setup overlay's manual "Trennen" button — lets
	// the operator drop the current KNS session without having to close the
	// browser tab (e.g. to free it up for another KNS client, or before a
	// deliberate reconnect with different credentials). The onClose callback
	// (wired in connectRadio) already does the "mark disconnected and
	// broadcast" work whenever the CAT connection drops for any reason, so
	// closing that alone would look complete — but it leaves the RX audio
	// UDP receiver and TX sender open. Live-reported bug (2026-09-28,
	// tested twice): a later "Verbinden" then failed to re-bind either,
	// with "address already in use" — the original ones were never
	// released, unlike every other reconnect path (connectRadio's own
	// swap+Close for both). Disconnect has to release the same two things.
	closeRadio := func(quiet bool) error {
		conn := rm.swap(nil)
		if conn == nil {
			return fmt.Errorf("not connected to radio")
		}
		restoreRadioSettings(conn)
		conn.Close()
		if old := arm.swap(nil); old != nil {
			old.Close()
		}
		if old := txm.swap(nil); old != nil {
			old.Close()
		}
		if !quiet {
			log.Println("radio: disconnected")
		}
		return nil
	}
	disconnectRadio := func() error { return closeRadio(false) }

	// The redial after a wake-on-lan power on IS needed (tested 2026-10-02
	// with false: the session that logged in during standby is unusable).
	const powerOnCleanReconnect = true
	var powering atomic.Bool
	// Set once the PA is set up (further down): switches a running PA off
	// and reports whether it did, so the radio is only cut afterwards.
	var ampOffForRadioOff func() bool
	radioPower := func(on bool) error {
		if !powering.CompareAndSwap(false, true) {
			return fmt.Errorf("power command already in progress")
		}
		defer powering.Store(false)
		if !on {
			conn := rm.current()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
			// PA still on: switch it off first and give it a moment.
			if ampOffForRadioOff != nil && ampOffForRadioOff() {
				time.Sleep(2 * time.Second)
			}
			restoreRadioSettings(conn)
			if err := conn.Send("PS0"); err != nil {
				return err
			}
			// Go to the same "radio off" state as at start: drop our side of
			// the session now instead of waiting for the radio to cut it
			// (that also frees the audio ports for the next power on).
			time.Sleep(300 * time.Millisecond) // let PS0 leave the socket
			closeRadio(true)
			log.Printf("radio: powered off")
			return nil
		}
		var reconnectReq *web.ConnectRequest
		// After the radio dropped the link (power off), rm still holds the
		// dead connection and arm/txm still hold the audio ports — release
		// all of it first, otherwise PS1 goes to a dead socket and redialing
		// fails to rebind the audio ports.
		// The same goes for a session that is still up but whose radio reported
		// standby (PS0): the radio drops its side while off, so the socket is
		// stale by the time it is switched on again ("write: broken pipe").
		if rm.current() != nil && (!st.Connected() || st.Snapshot().RadioStandby) {
			disconnectRadio()
		}
		conn := rm.current()
		if conn == nil {
			lastReqMu.Lock()
			req := lastReq
			lastReqMu.Unlock()
			knsCfgMu.Lock()
			mac := knsCfg.Mac
			if req == nil && knsCfg.Host != "" {
				req = &web.ConnectRequest{Host: knsCfg.Host, Port: knsCfg.Port, VoipPort: knsCfg.VoipPort, User: knsCfg.User, Pass: knsCfg.Pass, Admin: knsCfg.Admin}
			}
			knsCfgMu.Unlock()
			if req == nil && *host != "" {
				req = &web.ConnectRequest{Host: *host, Port: *port, VoipPort: *voipPort, User: *username, Pass: *password, Admin: *admin}
			}
			log.Printf("radio: power on requested (host %v, mac %q)", req != nil, mac)
			if req == nil {
				return fmt.Errorf("no connection settings known — connect once via Settings first")
			}
			// First just try to connect: a radio that is on and reachable gets its
			// session without any wake-on-lan; only when that fails is it woken
			// (Nutzer-Wunsch 2026-10-11). A short timeout keeps the wait small.
			reachable := false
			quick := *req
			quick.Timeout = 2 * time.Second
			if qerr := connectRadio(quick); qerr == nil {
				reachable = true
				log.Printf("radio: power on: radio is reachable, no wake-on-lan needed")
			} else {
				log.Printf("radio: power on: radio not reachable (%v)", qerr)
			}
			attempts := 1
			wolMAC := ""
			if mac != "" && !reachable {
				// Wake-on-LAN first (the radio's network part wakes on the
				// magic packet), then keep trying the KNS login while it boots.
				log.Printf("radio: sending wake-on-lan to %s", mac)
				if err := radio.SendWOL(mac, req.Host); err != nil {
					return err
				}
				wolMAC = mac
				// The connection attempt itself wakes the radio from its
				// standby and it needs a while to answer. Many SHORT attempts
				// beat one long one (the OS's SYN retransmits back off
				// exponentially, live-measured 29s vs 14s); the login on an
				// accepted connection gets a longer timeout.
				attempts = 20
				r := *req
				r.Timeout = 3 * time.Second
				req = &r
			}
			var err error
			for i := 0; i < attempts && !reachable; i++ {
				if i > 0 {
					time.Sleep(time.Second)
					// A radio that was just switched off may not have been
					// in standby yet when the first packet arrived — resend.
					if i%5 == 0 {
						radio.SendWOL(wolMAC, req.Host)
					}
				}
				if err = connectRadio(*req); err == nil {
					break
				}
				if attempts > 1 && i == 0 {
					log.Printf("radio: power on: waiting for the radio to wake up ...")
				}
				if i == attempts-1 {
					log.Printf("radio: power on: last connect attempt failed: %v", err)
				}
			}
			if err != nil {
				if mac == "" {
					return fmt.Errorf("radio not reachable (no MAC known for wake-on-lan): %w", err)
				}
				return fmt.Errorf("radio did not come up after wake-on-lan: %w", err)
			}
			log.Printf("radio: power on: connected, sending PS1")
			learnMAC(req.Host)
			reconnectReq = req
			conn = rm.current()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
		}
		// waitPS waits for a power status reply satisfying want (nil = any).
		waitPS := func(d time.Duration, want func(string) bool) (string, bool) {
			deadline := time.After(d)
			for {
				select {
				case m := <-psReplies:
					if want == nil || want(m) {
						return m, true
					}
				case <-deadline:
					return "", false
				}
			}
		}
		// Ask first (PS;): only a radio that reports it is off needs PS1;
		// to switch it fully on.
		for len(psReplies) > 0 {
			<-psReplies
		}
		if err := conn.Send("PS"); err != nil {
			return err
		}
		if m, ok := waitPS(3*time.Second, nil); ok && m == "PS1" {
			log.Printf("radio: power on: radio already reports power on, nothing to do")
			return nil
		}
		if err := conn.Send("PS1"); err != nil {
			return err
		}
		// A session logged in while the radio was still in its wake-on-lan
		// standby doesn't get usable data after it finishes powering up
		// (live-reported: only a manual disconnect + connect fixed it). So
		// once the radio reports PS1 (or after 20s at the latest), redial
		// exactly like that manual workaround does.
		if req := reconnectReq; req != nil {
			if !powerOnCleanReconnect {
				if _, ok := waitPS(20*time.Second, func(m string) bool { return m == "PS1" }); ok {
					log.Printf("radio: power on: radio reports power on")
				} else {
					log.Printf("radio: power on: no PS1 seen after 20s")
				}
				return nil
			}
			if _, ok := waitPS(20*time.Second, func(m string) bool { return m == "PS1" }); ok {
				log.Printf("radio: power on: radio reports power on")
			} else {
				log.Printf("radio: power on: no PS1 seen after 20s, reconnecting anyway")
			}
			time.Sleep(3 * time.Second) // let it finish booting
			log.Printf("radio: power on: reconnecting for a clean session")
			closeRadio(true)
			time.Sleep(500 * time.Millisecond)
			if err := connectRadio(*req); err != nil {
				return fmt.Errorf("reconnect after power on failed: %w", err)
			}
			log.Printf("radio: power on: reconnected")
		}
		return nil
	}

	setFrequency := func(hz int) error {
		return sendEncoded(func() (string, error) { return cat.EncodeFrequency(st.ActiveVFO(), hz) })
	}

	setMode := func(mode string) error {
		return sendEncoded(func() (string, error) { return cat.EncodeMode(0, mode) })
	}

	setBand := func(band string) error {
		return sendEncoded(func() (string, error) { return cat.EncodeBand(st.ActiveVFO(), band) })
	}

	// SPE Expert PA: independent of the radio connection, so (re)connecting
	// either one never touches the other.
	var ampMu sync.Mutex
	var amp *spe.Amp
	currentAmp := func() (*spe.Amp, error) {
		ampMu.Lock()
		defer ampMu.Unlock()
		if amp == nil {
			return nil, fmt.Errorf("PA not connected (no serial port set)")
		}
		return amp, nil
	}
	// No PA polling while the radio is off (the PA buttons are unavailable
	// then and the PA is normally off too).
	go func() {
		for range time.Tick(time.Second) {
			ampMu.Lock()
			a := amp
			ampMu.Unlock()
			if a != nil {
				a.SetPaused(!st.Connected())
			}
		}
	}()
	ampOffForRadioOff = func() bool {
		if _, ampOn := st.PowerAndAmp(); !ampOn {
			return false
		}
		a, err := currentAmp()
		if err != nil {
			return false
		}
		log.Println("spe: radio power off requested, switching PA OFF first")
		return a.PowerOff() == nil
	}
	connectAmp := func(port string) error {
		ampMu.Lock()
		defer ampMu.Unlock()
		if amp != nil {
			amp.Close()
			amp = nil
		}
		st.SetAmpPort("")
		if port == "" {
			broadcastState()
			log.Println("spe: disconnected")
			return nil
		}
		a, err := spe.Open(port, *speAmpBaud, func(s spe.Status) {
			power, wasOn := st.PowerAndAmp()
			if s.On && !wasOn {
				ampPowerPending.Store(true)
				ampSavedMu.Lock()
				ampSavedValid = true
				ampSavedAT = st.Tuner().TXEnabled
				ampSavedPower = power
				ampSavedMu.Unlock()
			} else if !s.On && wasOn {
				ampSavedMu.Lock()
				valid, at, pw := ampSavedValid, ampSavedAT, ampSavedPower
				ampSavedValid = false
				ampSavedMu.Unlock()
				if conn := rm.current(); conn != nil && valid {
					if at {
						if err := conn.Send(cat.EncodeTuner(true, false)); err != nil {
							log.Printf("main: restoring AT after PA off failed: %v", err)
						}
					}
					if pw > 0 {
						if cmd, err := cat.EncodePower(pw); err == nil {
							if err := conn.Send(cmd); err != nil {
								log.Printf("main: restoring power after PA off failed: %v", err)
							}
						}
					}
					log.Printf("main: PA off, restored AT=%v power=%dW", at, pw)
				}
			}
			st.SetAmpStatus(s.On, s.Operate, s.TX, s.Level, s.Warning, s.Alarm, s.Model, s.PowerW, s.SWR)
			enforceAmpPower()
			broadcastState()
		})
		if err != nil {
			broadcastState()
			return err
		}
		amp = a
		st.SetAmpPort(port)
		broadcastState()
		log.Printf("spe: opened %s at %d baud", port, *speAmpBaud)
		return nil
	}
	ampDo := func(f func(*spe.Amp) error) func() error {
		return func() error {
			a, err := currentAmp()
			if err != nil {
				return err
			}
			return f(a)
		}
	}
	// PA TUNE: the amp's ATU needs an RF carrier. Press TUNE on the amp, switch
	// the radio to CW at 10W, key it, and hold the carrier until the amp's
	// front-panel TUNE LED (only visible in its RCU LCD frames) goes out again,
	// then restore the radio's mode and power. A second click cancels. Failsafes:
	// the LED must light within tuneStartWait, and the whole run is capped at
	// tuneMaxRun. NOT verified against real hardware (LED bit position and
	// whether TX0 keys a CW carrier are taken from MacExpert / assumed).
	const (
		tuneWatts     = 10
		tuneStartWait = 5 * time.Second
		tuneMaxRun    = 25 * time.Second
	)
	var tuneMu sync.Mutex
	var tuneCancel chan struct{} // non-nil while a tune run is active
	paTune := func() error {
		a, err := currentAmp()
		if err != nil {
			return err
		}
		tuneMu.Lock()
		if tuneCancel != nil { // second click: cancel the running tune
			close(tuneCancel)
			tuneCancel = nil
			tuneMu.Unlock()
			return nil
		}
		conn := rm.current()
		_, ampOn := st.PowerAndAmp()
		switch {
		case conn == nil:
			tuneMu.Unlock()
			return fmt.Errorf("PA tune needs the radio connected (it supplies the carrier)")
		case !ampOn:
			tuneMu.Unlock()
			return fmt.Errorf("PA is not on")
		case st.AmpOperate():
			tuneMu.Unlock()
			return fmt.Errorf("PA tune only works in STANDBY")
		case st.Snapshot().TX:
			tuneMu.Unlock()
			return fmt.Errorf("radio is already transmitting")
		}
		cancel := make(chan struct{})
		tuneCancel = cancel
		tuneMu.Unlock()

		go func() {
			prevMode := st.Mode()
			prevPower, _ := st.PowerAndAmp()
			st.SetAmpTuning(true)
			broadcastState()
			log.Printf("spe: tune started (radio mode %s, %dW before)", prevMode, prevPower)

			defer func() {
				conn.Send("RX")
				time.Sleep(250 * time.Millisecond)
				if cmd, err := cat.EncodeMode(0, prevMode); err == nil {
					conn.Send(cmd)
				}
				if prevPower > 0 {
					if cmd, err := cat.EncodePower(prevPower); err == nil {
						conn.Send(cmd)
					}
				}
				a.StopRCU()
				tuneMu.Lock()
				tuneCancel = nil
				tuneMu.Unlock()
				st.SetAmpTuning(false)
				broadcastState()
				log.Println("spe: tune finished, radio mode and power restored")
			}()

			if err := a.StartRCU(); err != nil {
				log.Printf("spe: tune: entering RCU mode failed: %v", err)
				return
			}
			if cmd, err := cat.EncodeMode(0, "CW"); err == nil {
				conn.Send(cmd)
			}
			if cmd, err := cat.EncodePower(tuneWatts); err == nil {
				conn.Send(cmd)
			}
			time.Sleep(250 * time.Millisecond)
			if err := a.Tune(); err != nil {
				log.Printf("spe: tune: TUNE command failed: %v", err)
				return
			}
			time.Sleep(150 * time.Millisecond)
			if err := conn.Send("TX0"); err != nil {
				log.Printf("spe: tune: keying the radio failed: %v", err)
				return
			}

			start := time.Now()
			ledSeen := false
			for {
				select {
				case <-cancel:
					log.Println("spe: tune cancelled")
					return
				case <-time.After(340 * time.Millisecond):
				}
				if err := a.RCUHeartbeat(); err != nil {
					log.Printf("spe: tune: RCU heartbeat failed: %v", err)
					return
				}
				on, _ := a.TuneLED()
				if on {
					ledSeen = true
				} else if ledSeen {
					return // LED went out: tuning done
				}
				if !ledSeen && time.Since(start) > tuneStartWait {
					log.Println("spe: tune: TUNE LED never lit, aborting")
					return
				}
				if time.Since(start) > tuneMaxRun {
					log.Println("spe: tune: max run time reached, aborting")
					return
				}
			}
		}()
		return nil
	}

	// PA settings remembered across restarts (-config file, section "spe"): the last port
	// used and the "auto connect" flag. Auto connect reconnects that port on
	// start if the device still exists; an explicit -speport always wins.
	var speCfg struct {
		Port      string `json:"port"`
		Auto      bool   `json:"auto"`
		TxTimeout int    `json:"txTimeout"`
		MaxPowerW int    `json:"maxPowerW"` // 0 (unset, e.g. an older file) means ampMaxPowerDefaultW
	}
	var speTxTimeout atomic.Int64 // seconds, 0 = off
	if data, ok := cfgStore.Read("spe"); ok {
		json.Unmarshal(data, &speCfg)
	}
	saveSpeCfg := func() {
		st.SetAmpConfig(speCfg.Port, speCfg.Auto, speCfg.TxTimeout)
		data, _ := json.Marshal(speCfg)
		if err := cfgStore.Write("spe", data); err != nil {
			log.Printf("spe: saving settings to %s failed: %v", *configFile, err)
		}
	}
	st.SetAmpConfig(speCfg.Port, speCfg.Auto, speCfg.TxTimeout)
	speTxTimeout.Store(int64(speCfg.TxTimeout))
	if speCfg.MaxPowerW >= ampMaxPowerMinW && speCfg.MaxPowerW <= ampMaxPowerMaxW {
		ampMaxPowerW.Store(int64(speCfg.MaxPowerW))
	} else {
		speCfg.MaxPowerW = ampMaxPowerDefaultW
	}
	st.SetAmpMaxPower(int(ampMaxPowerW.Load()))
	setAmpTxTimeout := func(seconds int) error {
		if seconds < 0 {
			seconds = 0
		}
		if seconds > 999 {
			seconds = 999
		}
		speCfg.TxTimeout = seconds
		speTxTimeout.Store(int64(seconds))
		saveSpeCfg()
		broadcastState()
		return nil
	}
	// "Max PWR bei aktiver PA" (Nutzer-Wunsch, 2026-10-14, 5-100W, default
	// 15W) — see ampMaxPowerW's own comment above for what it governs.
	setAmpMaxPower := func(watts int) error {
		if watts < ampMaxPowerMinW {
			watts = ampMaxPowerMinW
		}
		if watts > ampMaxPowerMaxW {
			watts = ampMaxPowerMaxW
		}
		speCfg.MaxPowerW = watts
		ampMaxPowerW.Store(int64(watts))
		st.SetAmpMaxPower(watts)
		saveSpeCfg()
		broadcastState()
		return nil
	}

	// PA TX timeout: while the PA is on and anything transmits, count the
	// time; past the limit switch the radio to RX, and if TX is still there
	// 2s later switch the PA off.
	go func() {
		var txSince, rxSentAt, offSentAt time.Time
		for range time.Tick(200 * time.Millisecond) {
			radioTX, ampOn, ampTX := st.TXFlags()
			if !ampOn || !(radioTX || ampTX) {
				txSince, rxSentAt, offSentAt = time.Time{}, time.Time{}, time.Time{}
				continue
			}
			now := time.Now()
			if txSince.IsZero() {
				txSince = now
			}
			limit := time.Duration(speTxTimeout.Load()) * time.Second
			if limit == 0 || now.Sub(txSince) < limit {
				continue
			}
			if now.Sub(rxSentAt) >= time.Second {
				rxSentAt = now
				log.Printf("spe: PA TX timeout (%s) reached, switching radio to RX", limit)
				if conn := rm.current(); conn != nil {
					conn.Send("RX")
				}
			}
			// Still transmitting 2s after the first RX request: cut the PA.
			if now.Sub(txSince) >= limit+2*time.Second && now.Sub(offSentAt) >= 3*time.Second {
				offSentAt = now
				log.Println("spe: still transmitting after RX request, switching PA OFF")
				if a, err := currentAmp(); err == nil {
					a.PowerOff()
				}
			}
		}
	}()

	userConnectAmp := func(port string) error {
		err := connectAmp(port)
		if err == nil && port != "" && port != speCfg.Port {
			speCfg.Port = port
			saveSpeCfg()
		}
		return err
	}
	setAmpAuto := func(port string, enabled bool) error {
		if port != "" {
			speCfg.Port = port
		}
		speCfg.Auto = enabled
		saveSpeCfg()
		broadcastState()
		if _, err := currentAmp(); err != nil && enabled && speCfg.Port != "" {
			return connectAmp(speCfg.Port)
		}
		return nil
	}
	startPort := *speAmpPort
	if startPort == "" && speCfg.Auto && speCfg.Port != "" {
		if _, err := os.Stat(speCfg.Port); err == nil {
			startPort = speCfg.Port
		} else {
			log.Printf("spe: saved port %s no longer exists, not connecting", speCfg.Port)
		}
	}
	if startPort != "" {
		if err := connectAmp(startPort); err != nil {
			log.Printf("spe: opening %s failed: %v", startPort, err)
		}
	}

	controls := web.Controls{
		ConnectAmp:      userConnectAmp,
		SetAmpAuto:      setAmpAuto,
		SetAmpTxTimeout: setAmpTxTimeout,
		SetAmpMaxPower:  setAmpMaxPower,
		AmpPowerOn:      ampDo((*spe.Amp).PowerOn),
		AmpPowerOff:     ampDo((*spe.Amp).PowerOff),
		AmpToggleOper:   ampDo((*spe.Amp).ToggleOperate),
		AmpCycleLevel:   ampDo((*spe.Amp).CyclePowerLevel),
		AmpTune:         paTune,
		Connect:         connectFromUI,
		SetKnsAuto:      setKnsAuto,
		RadioPower:      radioPower,
		SetKnsMac:       setKnsMac,
		SetFrequency:    setFrequency,
		SetMode:         setMode,
		SetBand:         setBand,
		SetAGC: func(value string) error {
			return sendEncoded(func() (string, error) { return cat.EncodeAGC(value) })
		},
		SetNR: func(value int) error {
			return sendEncoded(func() (string, error) { return cat.EncodeNR(value) })
		},
		SetATT: func(value int) error {
			return sendEncoded(func() (string, error) { return cat.EncodeATT(value) })
		},
		SetPRE: func(value int) error {
			return sendEncoded(func() (string, error) { return cat.EncodePRE(value) })
		},
		// RIT knob (desktop, 2026-10-13): RU/RD/RC are bare commands, no
		// encoding to fail on — same shape as sendEncoded's other callers
		// regardless, so a dead connection still gets reported consistently.
		SetRIT: func(enabled bool) error {
			return sendEncoded(func() (string, error) { return cat.EncodeRIT(enabled), nil })
		},
		RITStep: func(up bool) error {
			cmd := "RD"
			if up {
				cmd = "RU"
			}
			return sendEncoded(func() (string, error) { return cmd, nil })
		},
		RITClear: func() error {
			return sendEncoded(func() (string, error) { return "RC", nil })
		},
		// XIT shares RIT's offset (RU/RD/RC above) — only the on/off switch
		// is separate.
		SetXIT: func(enabled bool) error {
			return sendEncoded(func() (string, error) { return cat.EncodeXIT(enabled), nil })
		},
		SetNB: func(which int, enabled bool) error {
			return sendEncoded(func() (string, error) { return cat.EncodeNB(which, enabled) })
		},
		SetRFGain: func(value int) error {
			return sendEncoded(func() (string, error) { return cat.EncodeRFGain(value) })
		},
		SetSquelch: func(value int) error {
			return sendEncoded(func() (string, error) { return cat.EncodeSquelch(value) })
		},
		SetBC: func(value int) error {
			return sendEncoded(func() (string, error) { return cat.EncodeBC(value) })
		},
		// Noise blanker settings (long press on NB1/NB2): each is sent and read
		// back so the UI shows what the radio really took.
		// Active VFO (A/B): FR0 / FR1; the radio answers with its FR report, which is
		// what moves the UI (frequency, indicator, scope).
		SetVFO: func(vfo string) error {
			return sendEncoded(func() (string, error) { return cat.EncodeActiveReceiver(cat.VFO(vfo)) })
		},
		SetNBLevel: func(which, level int) error {
			conn := rm.current()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
			cmd, err := cat.EncodeNBLevel(which, level)
			if err != nil {
				return err
			}
			if err := conn.Send(cmd); err != nil {
				return err
			}
			return conn.Send(fmt.Sprintf("NL%d", which))
		},
		SetNBType: func(typeB bool) error {
			conn := rm.current()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
			if err := conn.Send(cat.EncodeNBType(typeB)); err != nil {
				return err
			}
			return conn.Send("NBT")
		},
		SetNBDepth: func(v int) error {
			conn := rm.current()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
			cmd, err := cat.EncodeNBDepth(v)
			if err != nil {
				return err
			}
			if err := conn.Send(cmd); err != nil {
				return err
			}
			return conn.Send("NBD")
		},
		SetNBWidth: func(v int) error {
			conn := rm.current()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
			cmd, err := cat.EncodeNBWidth(v)
			if err != nil {
				return err
			}
			if err := conn.Send(cmd); err != nil {
				return err
			}
			return conn.Send("NBW")
		},
		// TX equalizer (button + effect in the UI). Only for modes that have it. The
		// operator's ON choice stays for this session in that mode (the automatic
		// "off for remote operation" does not override it); the original state is
		// still put back when we let go.
		SetTXEQ: func(on bool) error {
			conn := rm.current()
			mode := st.Mode()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
			if !cat.TXEQApplies(mode) {
				return fmt.Errorf("TX equalizer is not available in mode %s", mode)
			}
			eqMu.Lock()
			if on {
				eqUserOn[mode] = true
			} else {
				delete(eqUserOn, mode)
			}
			eqMu.Unlock()
			saveTXEQPref(mode, on)
			if err := conn.Send(cat.EncodeTXEQ(on)); err != nil {
				return err
			}
			return conn.Send("EQT0")
		},
		SetTXEQEffect: func(effect int) error {
			conn := rm.current()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
			if !cat.TXEQApplies(st.Mode()) {
				return fmt.Errorf("TX equalizer is not available in mode %s", st.Mode())
			}
			cmd, err := cat.EncodeTXEQEffect(effect)
			if err != nil {
				return err
			}
			if err := conn.Send(cmd); err != nil {
				return err
			}
			return conn.Send("EQT1")
		},
		// Same "operator's ON choice stays for this session in that mode" rule
		// as SetTXEQ above, via eqRxUserOn (forceRXEQOff checks it the same
		// way forceTXEQOff checks eqUserOn). Deliberately NOT gated on
		// cat.RXEQApplies the way SetTXEQ is gated on TXEQApplies: that
		// mode list is an unconfirmed assumption for RX (see RXEQApplies'
		// own comment), so this manual toggle keeps working exactly as
		// before in every mode regardless — only the new force-off/restore
		// machinery uses the assumption, nothing that could regress existing
		// behavior.
		SetRXEQ: func(on bool) error {
			conn := rm.current()
			mode := st.Mode()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
			eqRxMu.Lock()
			if on {
				eqRxUserOn[mode] = true
			} else {
				delete(eqRxUserOn, mode)
			}
			eqRxMu.Unlock()
			saveRXEQPref(mode, on)
			if err := conn.Send(cat.EncodeRXEQ(on)); err != nil {
				return err
			}
			return conn.Send("EQR0")
		},
		SetRXEQEffect: func(effect int) error {
			conn := rm.current()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
			cmd, err := cat.EncodeRXEQEffect(effect)
			if err != nil {
				return err
			}
			if err := conn.Send(cmd); err != nil {
				return err
			}
			return conn.Send("EQR1")
		},
		// TX Monitor ("MO0" on/off, "ML" level 0-20, Kenwood PC Command
		// Reference). Same "operator's ON choice stays for this session, and
		// is remembered for the next one" rule as TX/RX-EQ above (Nutzer-
		// Wunsch, 2026-10-14: "TX MON auch mit aufnehmen") — forceTXMonOff
		// checks txMonUserOn/txMonWant the same way forceTXEQOff checks
		// eqUserOn/txEqWant.
		SetTXMonitor: func(on bool) error {
			conn := rm.current()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
			txMonMu.Lock()
			txMonUserOn = on
			txMonMu.Unlock()
			saveTXMonPref(on)
			if err := conn.Send(cat.EncodeTXMonitor(on)); err != nil {
				return err
			}
			return conn.Send("MO0")
		},
		SetTXMonitorLevel: func(level int) error {
			return sendEncoded(func() (string, error) { return cat.EncodeTXMonitorLevel(level) })
		},
		SetProc: func(enabled bool) error {
			err := sendEncoded(func() (string, error) { return cat.EncodeProc(enabled) })
			if err == nil {
				saveProcPref(enabled)
			}
			return err
		},
		SetProcType: func(hard bool) error {
			err := sendEncoded(func() (string, error) { return cat.EncodeProcType(hard) })
			if err == nil {
				saveProcType(hard)
			}
			return err
		},
		SetAnt: func(ant string) error {
			return sendEncoded(func() (string, error) {
				a := st.Antenna()
				a.Selected = ant
				return cat.EncodeAntenna(a)
			})
		},
		SetPower: func(value int) error {
			if _, ampOn := st.PowerAndAmp(); ampOn {
				if max := int(ampMaxPowerW.Load()); value > max {
					value = max
				}
			}
			return sendEncoded(func() (string, error) { return cat.EncodePower(value) })
		},
		SetMicGain: func(value int) error {
			return sendEncoded(func() (string, error) { return cat.EncodeMicGain(value) })
		},
		SetProcLevelIn: func(value int) error {
			err := sendEncoded(func() (string, error) {
				levels := st.ProcLevels()
				levels.Input = value
				return cat.EncodeProcLevels(levels)
			})
			if err == nil {
				saveProcLevelIn(value)
			}
			return err
		},
		SetProcLevelOut: func(value int) error {
			err := sendEncoded(func() (string, error) {
				levels := st.ProcLevels()
				levels.Output = value
				return cat.EncodeProcLevels(levels)
			})
			if err == nil {
				saveProcLevelOut(value)
			}
			return err
		},
		SetIFFilter: func(filter string) error {
			return sendEncoded(func() (string, error) { return cat.EncodeIFFilter(filter) })
		},
		SetTuner: func(enabled bool) error {
			if _, ampOn := st.PowerAndAmp(); ampOn && enabled {
				return fmt.Errorf("internal AT stays off while the PA is on")
			}
			return sendEncoded(func() (string, error) {
				t := st.Tuner()
				return cat.EncodeTuner(enabled, t.TuningActive), nil
			})
		},
		SetMeterMode: func(mode string) error {
			if meterCode(mode) == "" {
				mode = ""
			}
			wantMeterMu.Lock()
			defer wantMeterMu.Unlock()
			old := wantMeter
			if old == mode {
				return nil
			}
			wantMeter = mode
			conn := rm.current()
			if conn == nil {
				return nil // sent after the next connect
			}
			if code := meterCode(old); code != "" {
				if err := conn.Send("RM" + code + "0"); err != nil {
					return err
				}
			}
			if code := meterCode(mode); code != "" {
				return conn.Send("RM" + code + "1")
			}
			return nil
		},
		SetTune: func() error {
			lastTXActivity.Store(time.Now().UnixNano())
			// The PA has its own tuner (PA TUNE); only a running internal
			// tune may still be stopped.
			if _, ampOn := st.PowerAndAmp(); ampOn && !st.Tuner().TuningActive {
				return fmt.Errorf("internal TUNE is not available while the PA is on")
			}
			return sendEncoded(func() (string, error) {
				t := st.Tuner()
				return cat.EncodeTuner(t.TXEnabled, !t.TuningActive), nil
			})
		},
		SetTX: func(transmitting bool) error {
			lastTXActivity.Store(time.Now().UnixNano()) // keep the VOIP auto sync away, also before the radio confirms
			return sendEncoded(func() (string, error) { return cat.EncodeTX(transmitting), nil })
		},
		SetAudioWidth: func(widthHz int) error {
			return sendEncoded(func() (string, error) {
				mode, filterMode, _ := st.AudioFilterConfig()
				return cat.EncodeAudioWidth(mode, filterMode, widthHz)
			})
		},
		// VoIP jitter buffer (##KN4): the radio only accepts it for a KNS
		// admin login; re-read afterwards to show what it really took.
		// Audio peak filter (CW): on/off (AP0) and shift around the pitch
		// (AP1); re-read afterwards so the UI shows what the radio took.
		SetAPF: func(on bool) error {
			conn := rm.current()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
			if err := conn.Send(cat.EncodeAPFOn(on)); err != nil {
				return err
			}
			return conn.Send("AP0")
		},
		SetAPFShift: func(hz int) error {
			conn := rm.current()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
			if err := conn.Send(cat.EncodeAPFShift(hz)); err != nil {
				return err
			}
			return conn.Send("AP1")
		},
		SetAPFBandwidth: func(idx int) error {
			conn := rm.current()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
			cmd, err := cat.EncodeAPFBandwidth(idx)
			if err != nil {
				return err
			}
			if err := conn.Send(cmd); err != nil {
				return err
			}
			return conn.Send("AP2")
		},
		SetAPFGain: func(gain int) error {
			conn := rm.current()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
			cmd, err := cat.EncodeAPFGain(gain)
			if err != nil {
				return err
			}
			if err := conn.Send(cmd); err != nil {
				return err
			}
			return conn.Send("AP3")
		},
		SetJitterBuffer: func(ms int) error {
			if !st.Snapshot().RadioAdmin {
				return fmt.Errorf("jitter buffer needs a KNS admin login")
			}
			conn := rm.current()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
			cmd := cat.EncodeJitterBuffer(ms)
			if err := conn.Send(cmd); err != nil {
				return err
			}
			return conn.Send("##KN4")
		},
		// VoIP audio input/output level ("##KN3", Nutzer-Wunsch 2026-10-14):
		// same admin-only-to-set, anyone-can-read rule as the jitter buffer
		// above.
		SetVoipInLevel: func(level int) error {
			if !st.Snapshot().RadioAdmin {
				return fmt.Errorf("VoIP audio level needs a KNS admin login")
			}
			conn := rm.current()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
			cmd, err := cat.EncodeVoipLevel(false, level)
			if err != nil {
				return err
			}
			if err := conn.Send(cmd); err != nil {
				return err
			}
			return conn.Send(cat.EncodeVoipLevelQuery(false))
		},
		SetVoipOutLevel: func(level int) error {
			if !st.Snapshot().RadioAdmin {
				return fmt.Errorf("VoIP audio level needs a KNS admin login")
			}
			conn := rm.current()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
			cmd, err := cat.EncodeVoipLevel(true, level)
			if err != nil {
				return err
			}
			if err := conn.Send(cmd); err != nil {
				return err
			}
			return conn.Send(cat.EncodeVoipLevelQuery(true))
		},
		// Switch the SSB filter display between hi/lo cut and shift/width (menu
		// EX00611, or EX00612 in the data modes); re-read both the menu item
		// and the passband values, whose meaning changes with it.
		SetSSBFilterMode: func(hiLoCut bool) error {
			conn := rm.current()
			if conn == nil {
				return fmt.Errorf("not connected to radio")
			}
			mode, _, _ := st.AudioFilterConfig()
			data := mode == "LSB-D" || mode == "USB-D"
			if mode != "LSB" && mode != "USB" && !data {
				return fmt.Errorf("SSB filter mode doesn't apply to mode %q", mode)
			}
			item := "EX00611"
			if data {
				item = "EX00612"
			}
			for _, cmd := range []string{cat.EncodeSSBFilterMode(data, hiLoCut), item, "SH0", "SL0"} {
				if err := conn.Send(cmd); err != nil {
					return err
				}
			}
			return nil
		},
		SetShift: func(hz int) error {
			return sendEncoded(func() (string, error) {
				mode, filterMode, _ := st.AudioFilterConfig()
				return cat.EncodeShift(mode, filterMode, hz)
			})
		},
		SetLoCut: func(hz int) error {
			return sendEncoded(func() (string, error) {
				mode, filterMode, _ := st.AudioFilterConfig()
				return cat.EncodeLoCut(mode, filterMode, hz)
			})
		},
		SetHiCut: func(hz int) error {
			return sendEncoded(func() (string, error) {
				mode, filterMode, _ := st.AudioFilterConfig()
				return cat.EncodeHiCut(mode, filterMode, hz)
			})
		},
		SetScopeRate: func(rate string) error {
			err := sendEncoded(func() (string, error) { return cat.EncodeBandScopeRate(rate) })
			if err == nil {
				scopeRateMu.Lock()
				scopeRate = rate
				scopeRateMu.Unlock()
				st.SetScopeRate(rate)
				broadcastState()
			}
			return err
		},
		SetScopeSpan: func(hz int) error {
			return sendEncoded(func() (string, error) { return cat.EncodeBandScopeSpan(hz), nil })
		},
		ResetRXAudio:    resetRXAudio,
		SetVoipAutoSync: setVoipAutoSync,
		Disconnect:      disconnectRadio,
		// Idle restore (Nutzer-Wunsch, 2026-10-14): "last browser gone" (+15s
		// grace, see clientIdleRestoreDelay in web.go) puts PROC/MIC
		// input/TX-EQ/RX-EQ/TX monitor back to normal shack operation, same
		// restoreRadioSettings bundle the Trennen button and radio-power-off
		// already use, but WITHOUT closing the KNS connection — the Pi stays
		// dialled into the radio regardless of client count. Also clears
		// remoteActive itself, so a later plain radio reconnect (no client
		// around) won't re-apply anything. This is the ONE place remoteActive
		// is cleared (see its own and
		// restoreRadioSettings' comments) — done unconditionally, even if no
		// radio happens to be connected right now, since "no clients" always
		// means "not remote active" regardless.
		OnAllClientsGone: func() {
			remoteActive.Store(false)
			conn := rm.current()
			if conn == nil {
				return
			}
			log.Println("radio: no browser clients left, restoring shack-normal PROC/MIC input/TX-EQ/RX-EQ/TX monitor/band scope mode")
			restoreRadioSettings(conn)
			if err := conn.Send("##VP0"); err != nil {
				log.Printf("main: stopping the idle VoIP stream failed: %v", err)
			} else {
				log.Println("audio: no browser clients, VoIP stream stopped")
			}
		},
		// The counterpart (Nutzer-Wunsch, 2026-10-14): remote-operation
		// overrides apply only once someone is ACTUALLY here, not just
		// because the radio happens to be connected — see remoteActive's own
		// comment above. Fires on every 0->1 client transition, including
		// the very first client this process ever sees (not only ones
		// following an actual OnAllClientsGone restore). Mirrors the steps
		// connectRadio runs once at login (go applyTXSource / go
		// applyProcSettings / onModeChanged's forceTXEQOff/forceRXEQOff) —
		// onModeChanged is called directly rather than only resetting
		// eqChecked/eqRxChecked the way connectRadio does, because st.Mode()
		// is already known here (the radio's been connected and reporting
		// for a while) — connectRadio's fresh-dial case has to wait for the
		// first OM0 reply instead since the mode isn't known yet at that
		// point.
		OnFirstClientConnected: func() {
			remoteActive.Store(true)
			conn := rm.current()
			if conn == nil {
				return
			}
			log.Println("radio: first browser client connected, applying remote-operation PROC/MIC input/TX-EQ/RX-EQ/TX monitor/band scope mode")
			// A fresh VoIP stream for the new listener (off/on cycle, so it
			// also starts clean if it was still running, e.g. a page reload).
			go func() {
				if err := resetRXAudio(); err != nil {
					log.Printf("audio: starting the VoIP stream for the new client failed: %v", err)
				} else {
					log.Println("audio: VoIP stream started fresh for the first browser client")
				}
			}()
			go applyTXSource(conn)
			go applyProcSettings(conn)
			go forceTXMonOff(conn)
			go applyBandScopeCenter(conn)
			onModeChanged()
		},
	}

	txAudio := web.TXAudio{
		Sender:     txm.current,
		NewDecoder: audio.NewOpusDecoder,
		Relay:      broadcastRXAudio,
	}
	srv := web.New(h, st, controls, web.AudioHubs{PCM: pcmHub, Opus: opusHub}, txAudio, waterfallHub)

	// Graceful shutdown on Ctrl-C/SIGTERM. Without this, killing the process
	// (there was no signal handling at all before) leaves the OS to just
	// reap the CAT TCP socket — which closes it, but never sends "##VP0" to
	// tell the radio to stop its RTP audio stream first. Live-reported
	// (2026-09-30): the radio keeps blindly firing RTP packets at the now-
	// dead UDP destination (RX audio is decoupled from the CAT session) —
	// every one of those gets an ICMP
	// "port unreachable" back once nothing's listening, and the TS-890's own
	// network stack apparently can't handle that flood for long: it stopped
	// responding to even plain ping until power-cycled. Sending "##VP0"
	// before exiting stops that stream cleanly, the same toggle already used
	// by the RX-audio reset button elsewhere in this file.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Println("shutting down...")
		if conn := rm.current(); conn != nil {
			restoreRadioSettings(conn)
			if err := conn.Send("##VP0"); err != nil {
				log.Printf("shutdown: stopping RX audio stream: %v", err)
			}
			conn.Close()
		}
		os.Exit(0)
	}()

	if *noTLS {
		log.Printf("web interface on http://%s (no TLS: RX audio only works from literally \"localhost\")", *webAddr)
		log.Fatal(http.ListenAndServe(*webAddr, srv.Handler()))
	}

	cert, err := web.EnsureSelfSignedCert(*certFile, *keyFile)
	if err != nil {
		log.Fatalf("setting up TLS certificate: %v", err)
	}

	httpsSrv := &http.Server{
		Addr:      *webAddr,
		Handler:   srv.Handler(),
		TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}},
		// net/http logs "TLS handshake error" to the default logger for
		// every failed handshake, including totally routine ones for a
		// self-signed cert: a browser/OS reconnecting before the one-time
		// certificate warning is accepted, or a stray probe from something
		// else on the LAN. Filtered out here since it's noise, not
		// something actionable — everything else still logs normally.
		ErrorLog: log.New(tlsHandshakeErrorFilter{out: os.Stderr}, "", log.LstdFlags),
	}
	log.Printf("web interface on https://%s (self-signed cert — accept the browser's one-time warning)", *webAddr)
	log.Fatal(httpsSrv.ListenAndServeTLS("", ""))
}
