// Package web serves the browser frontend and a WebSocket endpoint that
// streams radio state to it.
package web

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"go.bug.st/serial"

	"open890rc/internal/audio"
	"open890rc/internal/hub"
	"open890rc/internal/state"
)

func init() {
	// The Home Screen web app manifest (static/manifest.webmanifest) would
	// otherwise be served as text/plain.
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
}

//go:embed static
var staticFiles embed.FS

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// This serves a LAN-only tool with no auth of its own yet, so any
	// origin on the network is accepted.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Controls are the radio-mutating actions a browser client can trigger.
type Controls struct {
	Connect           func(req ConnectRequest) error
	SetKnsAuto        func(enabled bool) error
	RadioPower        func(on bool) error
	SetKnsMac         func(mac string) error
	SetFrequency      func(hz int) error
	SetMode           func(mode string) error
	SetBand           func(band string) error
	SetAGC            func(value string) error
	SetNR             func(value int) error
	SetATT            func(value int) error
	SetPRE            func(value int) error
	SetRIT            func(enabled bool) error
	RITStep           func(up bool) error
	RITClear          func() error
	SetXIT            func(enabled bool) error
	SetNB             func(which int, enabled bool) error
	SetRFGain         func(value int) error
	SetSquelch        func(value int) error
	SetBC             func(value int) error
	SetVFO            func(vfo string) error
	SetNRSetting      func(which, v int) error
	SetNBLevel        func(which, level int) error
	SetNBType         func(typeB bool) error
	SetNBDepth        func(v int) error
	SetNBWidth        func(v int) error
	SetTXEQ           func(on bool) error
	SetTXEQEffect     func(effect int) error
	SetRXEQ           func(on bool) error
	SetRXEQEffect     func(effect int) error
	SetTXMonitor      func(on bool) error
	SetTXMonitorLevel func(level int) error
	SetProc           func(enabled bool) error
	SetProcType       func(hard bool) error
	SetAnt            func(ant string) error
	SetPower          func(value int) error
	SetMicGain        func(value int) error
	SetProcLevelIn    func(value int) error
	SetProcLevelOut   func(value int) error
	SetIFFilter       func(filter string) error
	SetTuner          func(enabled bool) error
	SetTune           func() error
	SetMeterMode      func(mode string) error
	SetTX             func(transmitting bool) error
	SetAudioWidth     func(widthHz int) error
	SetShift          func(hz int) error
	SetJitterBuffer   func(ms int) error
	SetVoipInLevel    func(level int) error
	SetVoipOutLevel   func(level int) error
	SetAPF            func(on bool) error
	SetAPFShift       func(hz int) error
	SetAPFBandwidth   func(idx int) error
	SetSSBFilterMode  func(hiLoCut bool) error
	SetAPFGain        func(gain int) error
	SetLoCut          func(hz int) error
	SetHiCut          func(hz int) error
	SetScopeRate      func(rate string) error
	SetScopeSpan      func(hz int) error
	ResetRXAudio      func() error
	SetVoipAutoSync   func(enabled bool, minutes int) error
	Disconnect        func() error
	// OnAllClientsGone is called once, clientIdleRestoreDelay after the last
	// connected /ws client disconnected, if the server is STILL clientless at
	// that point (a client reconnecting within the delay cancels it — see
	// Server.scheduleIdleRestore/cancelIdleRestore). The KNS connection itself
	// is not touched here, only whatever the caller wants reverted on it. nil
	// disables the whole feature (no timer is ever started).
	OnAllClientsGone func()
	// OnFirstClientConnected is called whenever the connected-client count
	// goes from 0 to 1 (Nutzer-Wunsch, 2026-10-14: remote-operation overrides
	// belong to "someone is actually using this remotely", not to the radio
	// connection existing at all — a server start/auto-connect with nobody
	// watching should leave the radio exactly as the local operator left it).
	// Unlike the old OnClientReturned this fires on EVERY such transition,
	// not only ones that follow an actual OnAllClientsGone — including the
	// very first client ever, even if OnAllClientsGone never ran this
	// process lifetime.
	OnFirstClientConnected func()
	// SPE Expert PA (serial). ConnectAmp with port "" disconnects.
	ConnectAmp      func(port string) error
	SetAmpAuto      func(port string, enabled bool) error
	SetAmpTxTimeout func(seconds int) error
	SetAmpMaxPower  func(watts int) error
	AmpPowerOn      func() error
	AmpPowerOff     func() error
	AmpToggleOper   func() error
	AmpCycleLevel   func() error
	AmpTune         func() error
}

// ConnectRequest is what a browser client's setup dialog supplies to (re)dial
// a physical radio.
type ConnectRequest struct {
	Host     string
	Port     int
	VoipPort int
	User     string
	Pass     string
	Admin    bool
	Timeout  time.Duration // optional: TCP connect timeout (0 = default); login gets a longer one then; never set by browsers
	Auto     bool          // "KNS auto connect": remember these settings and reconnect on server start
}

// AudioHubs are the fan-out hubs for each audio delivery mode a browser
// client can request from /audio-ws. Opus is nil if it isn't available.
type AudioHubs struct {
	PCM  *hub.Hub
	Opus *hub.Hub
}

// TXAudio provides what /audio-tx-ws needs to relay the browser's mic audio
// to the radio: the currently active UDP sender (nil if no radio is
// connected — swapped out by the caller on reconnect, possibly to a
// different host), a constructor for a fresh Opus decoder per connection
// (decoder state isn't safe to share across connections), and Relay, which
// echoes the same mic audio (pre-attenuation, i.e. at normal RX-ish volume,
// not the radio's own quiet mic-line level) into the RX audio hubs so every
// other connected client hears the transmitting client speak — the link is
// simplex, so there's no real RX audio to talk over while someone sends
// anyway (Nutzer-Wunsch, 2026-10-14). nil disables the relay.
type TXAudio struct {
	Sender     func() *audio.TXSender
	NewDecoder func() (*audio.OpusDecoder, error)
	Relay      func(pcmLE []byte)
}

// Server serves the static frontend and the /ws state stream.
type Server struct {
	hub       *hub.Hub
	state     *state.State
	controls  Controls
	audio     AudioHubs
	txAudio   TXAudio
	waterfall *hub.Hub

	clientsMu sync.Mutex
	clients   map[uint64]*clientInfo // connected /ws clients, by connection id

	idleMu    sync.Mutex
	idleTimer *time.Timer // pending OnAllClientsGone call, nil if none scheduled

	txOwnerMu   sync.Mutex
	txOwner     *websocket.Conn // TX audio socket currently feeding the sender
	txOwnerLast time.Time
}

// clientIdleRestoreDelay is the grace period after the last /ws client
// disconnects before Controls.OnAllClientsGone fires (Nutzer-Wunsch,
// 2026-10-14: the Pi stays connected to the radio nearly around the clock —
// a normal page reload or a flaky connection briefly dropping to zero
// clients must not immediately revert PROC/MIC input/TX-EQ, only a genuinely
// empty shack for a while should).
const clientIdleRestoreDelay = 15 * time.Second

// scheduleIdleRestore (re)starts the idle timer; called with the clients map
// already confirmed empty. A client reconnecting before it fires cancels it
// via cancelIdleRestore, so flapping around the zero-client boundary (a
// reload, a brief network blip) never reaches the radio.
func (s *Server) scheduleIdleRestore() {
	if s.controls.OnAllClientsGone == nil {
		return
	}
	s.idleMu.Lock()
	defer s.idleMu.Unlock()
	if s.idleTimer != nil {
		s.idleTimer.Stop()
	}
	s.idleTimer = time.AfterFunc(clientIdleRestoreDelay, func() {
		s.clientsMu.Lock()
		stillEmpty := len(s.clients) == 0
		s.clientsMu.Unlock()
		if !stillEmpty {
			return // a client slipped back in right as the timer fired
		}
		s.idleMu.Lock()
		s.idleTimer = nil
		s.idleMu.Unlock()
		s.controls.OnAllClientsGone()
	})
}

// cancelIdleRestore stops a pending timer (if any) — called on every client
// add, not just ones following an actual OnAllClientsGone (see addClient,
// which separately calls OnFirstClientConnected for the 0->1 transition).
func (s *Server) cancelIdleRestore() {
	s.idleMu.Lock()
	if s.idleTimer != nil {
		s.idleTimer.Stop()
		s.idleTimer = nil
	}
	s.idleMu.Unlock()
}

// claimTXAudio lets one TX audio socket at a time feed the radio: a second
// client's audio would interleave with the speaker's. The owner changes only
// after it has been silent for a moment.
func (s *Server) claimTXAudio(c *websocket.Conn) bool {
	s.txOwnerMu.Lock()
	defer s.txOwnerMu.Unlock()
	now := time.Now()
	if s.txOwner == nil || s.txOwner == c || now.Sub(s.txOwnerLast) > 500*time.Millisecond {
		s.txOwner = c
		s.txOwnerLast = now
		return true
	}
	return false
}

func (s *Server) releaseTXAudio(c *websocket.Conn) {
	s.txOwnerMu.Lock()
	if s.txOwner == c {
		s.txOwner = nil
	}
	s.txOwnerMu.Unlock()
}

// New creates a Server backed by the given hub, state, controls, audio hubs,
// and waterfall (band scope) hub.
func New(h *hub.Hub, st *state.State, controls Controls, audioHubs AudioHubs, txAudio TXAudio, waterfall *hub.Hub) *Server {
	return &Server{hub: h, state: st, controls: controls, audio: audioHubs, txAudio: txAudio, waterfall: waterfall, clients: map[uint64]*clientInfo{}}
}

// clientMessage is the JSON shape browser clients send over the WebSocket.
type clientMessage struct {
	Type       string  `json:"type"`
	Hz         int     `json:"hz"`
	Mode       string  `json:"mode"`
	Band       string  `json:"band"`
	AGC        string  `json:"agc"`
	Value      int     `json:"value"`
	Which      int     `json:"which"`
	Enabled    bool    `json:"enabled"`
	Ant        string  `json:"ant"`
	Host       string  `json:"host"`
	Port       int     `json:"port"`
	VoipPort   int     `json:"voipPort"`
	User       string  `json:"user"`
	Pass       string  `json:"pass"`
	Admin      bool    `json:"admin"`
	Auto       bool    `json:"auto"`
	T          float64 `json:"t"`
	Mac        string  `json:"mac"`
	Filter     string  `json:"filter"`
	Rate       string  `json:"rate"`
	SerialPort string  `json:"serialPort"`
	Before     float64 `json:"before"` // rxTrim: backlog before the cut, seconds
	After      float64 `json:"after"`  // rxTrim: backlog after the cut, seconds
	N          int     `json:"n"`      // rxTrim: how many cuts this page has made so far
	Codec      string  `json:"codec"`  // audioCodec: "pcm"/"opus" while RX audio plays, "" once stopped
}

// rxTrimTotal counts the browser-side RX audio buffer cuts reported by all
// clients since the server started (see the "rxTrim" message).
var rxTrimTotal atomic.Int64

// serverError is a one-off message sent back to just the client whose
// request failed (e.g. a wrong password on "connect"), as opposed to the
// state snapshots broadcast to everyone.
type serverError struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// handleClientMessage applies a message from one browser client. errCh
// carries any error that client alone should be told about (right now, just
// a failed "connect") back to handleWS's single writer goroutine — a second
// writer here would race the broadcast writes already happening on the same
// connection.
func (s *Server) handleClientMessage(data []byte, id uint64, errCh chan<- []byte, remote string, paOK, txOK bool) {
	var msg clientMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		log.Printf("web: invalid client message: %v", err)
		return
	}

	// PA commands only from clients that may see/use the PA (LAN, admins, PA flag)
	if !paOK && (strings.HasPrefix(msg.Type, "amp") || msg.Type == "connectAmp" || msg.Type == "setAmpAuto" || msg.Type == "setAmpTxTimeout" || msg.Type == "setAmpMaxPower") {
		log.Printf("web: %s ignored: client %s has no PA access", msg.Type, remote)
		return
	}

	// setTX/setTune key the transmitter — only from clients allowed to
	// transmit (LAN, admins, any user not on the noTX deny list). The
	// client also hides/disables the TX and TUNE controls and never opens
	// the microphone for such a user, this is the actual enforcement for
	// anyone who bypasses that (Nutzer-Wunsch 2026-10-18).
	if !txOK && (msg.Type == "setTX" || msg.Type == "setTune") {
		log.Printf("web: %s ignored: client %s has no TX access", msg.Type, remote)
		return
	}

	var err error
	switch msg.Type {
	case "connect":
		err = s.controls.Connect(ConnectRequest{
			Host:     msg.Host,
			Port:     msg.Port,
			VoipPort: msg.VoipPort,
			User:     msg.User,
			Pass:     msg.Pass,
			Admin:    msg.Admin,
			Auto:     msg.Auto,
		})
		// Acknowledged explicitly (not inferred from Snapshot.Connected):
		// that flag stays true from whatever connection already existed even
		// when THIS request fails, so the browser can't use it to tell "my
		// attempt just succeeded" from "some earlier connection is still up".
		ackType := "connectOk"
		message := ""
		if err != nil {
			ackType = "connectError"
			message = err.Error()
		}
		if payload, marshalErr := json.Marshal(serverError{Type: ackType, Message: message}); marshalErr == nil {
			errCh <- payload
		}
	case "audioCodec":
		s.setClientCodec(id, msg.Codec)
		return
	case "rxTrim":
		// The browser's RX audio ring buffer dropped its oldest samples because
		// the backlog ran past its limit (see pcm-player-processor.js): logged so
		// we can see later how often that happens.
		total := rxTrimTotal.Add(1)
		log.Printf("rx audio: browser buffer trimmed %.2fs -> %.2fs (%s; #%d on this page, #%d since server start; client %s)",
			msg.Before, msg.After, msg.Mode, msg.N, total, remote)
		return
	case "ping":
		// Latency probe: echo the client's own timestamp straight back so it
		// can measure the round trip. Dropped if the client's queue is full.
		if payload, marshalErr := json.Marshal(map[string]any{"type": "pong", "t": msg.T}); marshalErr == nil {
			select {
			case errCh <- payload:
			default:
			}
		}
	case "radioPower":
		// Can take a while (wake-on-lan + waiting for the radio to boot), so
		// run off the client's read loop and report the outcome afterwards.
		enabled := msg.Enabled
		go func() {
			err := s.controls.RadioPower(enabled)
			ackType, message := "powerOk", ""
			if err != nil {
				ackType, message = "powerError", err.Error()
				log.Printf("web: radioPower failed: %v", err)
			}
			if payload, marshalErr := json.Marshal(serverError{Type: ackType, Message: message}); marshalErr == nil {
				select {
				case errCh <- payload:
				case <-time.After(2 * time.Second):
				}
			}
		}()
		return
	case "setKnsMac":
		err = s.controls.SetKnsMac(msg.Mac)
	case "setKnsAuto":
		err = s.controls.SetKnsAuto(msg.Enabled)
	case "setFreq":
		err = s.controls.SetFrequency(msg.Hz)
	case "setMode":
		err = s.controls.SetMode(msg.Mode)
	case "setBand":
		err = s.controls.SetBand(msg.Band)
	case "setAGC":
		err = s.controls.SetAGC(msg.AGC)
	case "setNR":
		err = s.controls.SetNR(msg.Value)
	case "setATT":
		err = s.controls.SetATT(msg.Value)
	case "setPRE":
		err = s.controls.SetPRE(msg.Value)
	case "setRit":
		err = s.controls.SetRIT(msg.Enabled)
	case "ritStep":
		err = s.controls.RITStep(msg.Enabled)
	case "ritClear":
		err = s.controls.RITClear()
	case "setXit":
		err = s.controls.SetXIT(msg.Enabled)
	case "setNB":
		err = s.controls.SetNB(msg.Which, msg.Enabled)
	case "setRFGain":
		err = s.controls.SetRFGain(msg.Value)
	case "setSquelch":
		err = s.controls.SetSquelch(msg.Value)
	case "setBC":
		err = s.controls.SetBC(msg.Value)
	case "setVfo":
		vfo := "A"
		if msg.Value == 1 {
			vfo = "B"
		}
		err = s.controls.SetVFO(vfo)
	case "setNr1Level":
		err = s.controls.SetNRSetting(1, msg.Value)
	case "setNr2Tc":
		err = s.controls.SetNRSetting(2, msg.Value)
	case "setNb1Level":
		err = s.controls.SetNBLevel(1, msg.Value)
	case "setNb2Level":
		err = s.controls.SetNBLevel(2, msg.Value)
	case "setNbType":
		err = s.controls.SetNBType(msg.Enabled)
	case "setNbDepth":
		err = s.controls.SetNBDepth(msg.Value)
	case "setNbWidth":
		err = s.controls.SetNBWidth(msg.Value)
	case "setTxEq":
		err = s.controls.SetTXEQ(msg.Enabled)
	case "setTxEqEffect":
		err = s.controls.SetTXEQEffect(msg.Value)
	case "setRxEq":
		err = s.controls.SetRXEQ(msg.Enabled)
	case "setRxEqEffect":
		err = s.controls.SetRXEQEffect(msg.Value)
	case "setTxMonitor":
		err = s.controls.SetTXMonitor(msg.Enabled)
	case "setTxMonitorLevel":
		err = s.controls.SetTXMonitorLevel(msg.Value)
	case "setProc":
		err = s.controls.SetProc(msg.Enabled)
	case "setProcType":
		err = s.controls.SetProcType(msg.Enabled)
	case "setAnt":
		err = s.controls.SetAnt(msg.Ant)
	case "setPower":
		err = s.controls.SetPower(msg.Value)
	case "setMicGain":
		err = s.controls.SetMicGain(msg.Value)
	case "setProcLevelIn":
		err = s.controls.SetProcLevelIn(msg.Value)
	case "setProcLevelOut":
		err = s.controls.SetProcLevelOut(msg.Value)
	case "setIFFilter":
		err = s.controls.SetIFFilter(msg.Filter)
	case "setTuner":
		err = s.controls.SetTuner(msg.Enabled)
	case "setMeterMode":
		err = s.controls.SetMeterMode(msg.Mode)
	case "setTune":
		err = s.controls.SetTune()
	case "setTX":
		err = s.controls.SetTX(msg.Enabled)
	case "setAudioWidth":
		err = s.controls.SetAudioWidth(msg.Value)
	case "setApf":
		err = s.controls.SetAPF(msg.Enabled)
	case "setSsbFilterMode":
		err = s.controls.SetSSBFilterMode(msg.Enabled)
	case "setApfBw":
		err = s.controls.SetAPFBandwidth(msg.Value)
	case "setApfGain":
		err = s.controls.SetAPFGain(msg.Value)
	case "setApfShift":
		err = s.controls.SetAPFShift(msg.Value)
	case "setJitterBuffer":
		err = s.controls.SetJitterBuffer(msg.Value)
	case "setVoipInLevel":
		err = s.controls.SetVoipInLevel(msg.Value)
	case "setVoipOutLevel":
		err = s.controls.SetVoipOutLevel(msg.Value)
	case "setShift":
		err = s.controls.SetShift(msg.Value)
	case "setLoCut":
		err = s.controls.SetLoCut(msg.Value)
	case "setHiCut":
		err = s.controls.SetHiCut(msg.Value)
	case "setScopeRate":
		err = s.controls.SetScopeRate(msg.Rate)
	case "setScopeSpan":
		err = s.controls.SetScopeSpan(msg.Value)
	case "setVoipAutoSync":
		err = s.controls.SetVoipAutoSync(msg.Enabled, msg.Value)
	case "resetRxAudio":
		err = s.controls.ResetRXAudio()
	case "disconnect":
		err = s.controls.Disconnect()
	case "connectAmp", "setAmpAuto":
		if msg.Type == "connectAmp" {
			err = s.controls.ConnectAmp(msg.SerialPort)
		} else {
			err = s.controls.SetAmpAuto(msg.SerialPort, msg.Enabled)
		}
		ackType, message := "ampOk", ""
		if err != nil {
			ackType, message = "ampError", err.Error()
		}
		if payload, marshalErr := json.Marshal(serverError{Type: ackType, Message: message}); marshalErr == nil {
			errCh <- payload
		}
	case "setAmpTxTimeout":
		err = s.controls.SetAmpTxTimeout(msg.Value)
	case "setAmpMaxPower":
		err = s.controls.SetAmpMaxPower(msg.Value)
	case "ampPowerOn":
		err = s.controls.AmpPowerOn()
	case "ampPowerOff":
		err = s.controls.AmpPowerOff()
	case "ampToggleOperate":
		err = s.controls.AmpToggleOper()
	case "ampTune":
		err = s.controls.AmpTune()
	case "ampCycleLevel":
		err = s.controls.AmpCycleLevel()
	default:
		log.Printf("web: unknown client message type %q", msg.Type)
		return
	}

	if err != nil {
		log.Printf("web: %s failed: %v", msg.Type, err)
		// PA commands (power, operate, tune, level) tell the browser about a
		// failure, which shows it in the status line.
		if strings.HasPrefix(msg.Type, "amp") {
			if payload, marshalErr := json.Marshal(serverError{Type: "ampCmdError", Message: err.Error()}); marshalErr == nil {
				select {
				case errCh <- payload:
				default:
				}
			}
		}
	}
}

// Handler returns the HTTP handler for the frontend and WebSocket endpoint.
func (s *Server) Handler() http.Handler {
	sub, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Fatalf("web: embedding static files: %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(sub)))
	mux.HandleFunc("/ws", requireAuth(s.handleWS))
	mux.HandleFunc("/serial-ports", requireAuth(s.handleSerialPorts))
	mux.HandleFunc("/audio-ws", requireAuth(s.handleAudioWS))
	mux.HandleFunc("/audio-tx-ws", requireAuth(requireTX(s.handleTXAudioWS)))
	mux.HandleFunc("/waterfall-ws", requireAuth(s.handleWaterfallWS))
	mux.HandleFunc("/ca.crt", handleCACert)
	mux.HandleFunc("/auth/status", handleAuthStatus)
	mux.HandleFunc("/auth/login", handleLogin)
	mux.HandleFunc("/auth/logout", handleLogout)
	mux.HandleFunc("/api/users", requireAdmin(handleUsers))
	mux.HandleFunc("/api/login-message", requireAdmin(handleLoginMessage))
	mux.HandleFunc("/debug-ws", handleDebugWS)
	return mux
}

// streamHubFrames subscribes to h and writes every broadcast frame to conn
// (as messageType) until the connection dies or the client closes it.
// Shared by handleWaterfallWS and handleAudioWS, which used to each run
// their own copy of this loop with neither a read nor a write deadline —
// found live, 2026-10-16: on a stalled connection (a flaky Wi-Fi hop
// between the Pi and a browser, not uncommon here — see the WLAN power-save
// notes elsewhere in this codebase) conn.WriteMessage blocks with nothing
// to time it out, so nobody drains the hub's channel, and the hub's own
// non-blocking Broadcast silently drops every frame meant for that client
// ("packets dropped for slow browser clients" in the server log) until the
// OS network stack eventually notices the dead TCP connection on its own,
// which with no deadline set can take a very long time (observed: a solid
// 12 minutes of 100% Opus loss after one such Wi-Fi hiccup) — heard as the
// RX audio "clapping"/dropping out. Mirrors the ping/pong read-deadline
// pattern handleWS already uses for the control socket (wsPingInterval/
// wsReadTimeout) and adds a write deadline, so a stalled client is detected
// and dropped within seconds instead of staying a silent zombie subscriber.
func streamHubFrames(conn *websocket.Conn, h *hub.Hub, messageType int) {
	ch := h.Subscribe()
	defer h.Unsubscribe(ch)

	_ = conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(wsReadTimeout)) })
	done := make(chan struct{})
	go func() {
		for {
			if _, _, err := conn.NextReader(); err != nil {
				conn.Close()
				close(done)
				return
			}
		}
	}()

	pingTicker := time.NewTicker(wsPingInterval)
	defer pingTicker.Stop()

	for {
		select {
		case <-done:
			return
		case <-pingTicker.C:
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(wsPingWriteWait)); err != nil {
				return
			}
		case frame, ok := <-ch:
			if !ok {
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
			if err := conn.WriteMessage(messageType, frame); err != nil {
				return
			}
		}
	}
}

// handleWaterfallWS streams band scope lines (see cat.ParseBandScopeLine) to
// a client as binary frames, one per line, each cat.BandScopeLineBytes long.
func (s *Server) handleWaterfallWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("web: waterfall websocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()
	streamHubFrames(conn, s.waterfall, websocket.BinaryMessage)
}

// handleAudioWS streams one audio delivery mode's binary frames to a
// client: /audio-ws?codec=pcm for raw low-latency PCM (the default) or
// /audio-ws?codec=opus for the lower-bandwidth encoded stream.
func (s *Server) handleAudioWS(w http.ResponseWriter, r *http.Request) {
	audioHub := s.audio.PCM
	if r.URL.Query().Get("codec") == "opus" {
		audioHub = s.audio.Opus
	}
	if audioHub == nil {
		http.Error(w, "audio codec not available", http.StatusServiceUnavailable)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("web: audio websocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()
	streamHubFrames(conn, audioHub, websocket.BinaryMessage)
}

// handleTXAudioWS relays one browser client's mic audio to the radio:
// /audio-tx-ws?codec=pcm for raw little-endian 16-bit PCM (the wire format
// between browser and server; unrelated to the radio's own very different
// TX format, which audio.TXSender handles) or /audio-tx-ws?codec=opus for
// WebCodecs-encoded frames, decoded here before relaying. Silently drops
// audio if no radio is currently connected, rather than erroring — the
// browser can't always know that instantly, and dropping is harmless.
func (s *Server) handleTXAudioWS(w http.ResponseWriter, r *http.Request) {
	var opusDec *audio.OpusDecoder
	if r.URL.Query().Get("codec") == "opus" {
		var err error
		opusDec, err = s.txAudio.NewDecoder()
		if err != nil {
			log.Printf("web: creating opus decoder for TX audio: %v", err)
			http.Error(w, "opus not available", http.StatusServiceUnavailable)
			return
		}
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("web: TX audio websocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()
	defer s.releaseTXAudio(conn)

	framer := audio.NewTXFramer()

	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if msgType != websocket.BinaryMessage {
			continue
		}

		sender := s.txAudio.Sender()
		if sender == nil {
			continue
		}
		if !s.claimTXAudio(conn) {
			continue
		}

		samples, err := decodeTXSamples(data, opusDec)
		if err != nil {
			log.Printf("web: decoding TX audio failed: %v", err)
			continue
		}

		framer.Push(samples, func(frame []int16) {
			if err := sender.Send(frame); err != nil {
				log.Printf("web: sending TX audio failed: %v", err)
			}
			if s.txAudio.Relay != nil {
				s.txAudio.Relay(pcmBytesLE(frame))
			}
		})
	}
}

// decodeTXSamples decodes one incoming WS frame into PCM samples: through
// opusDec if given, otherwise interpreted directly as little-endian 16-bit
// PCM (the browser<->server wire convention for the "pcm" codec).
func decodeTXSamples(data []byte, opusDec *audio.OpusDecoder) ([]int16, error) {
	if opusDec != nil {
		return opusDec.Decode(data)
	}
	samples := make([]int16, len(data)/2)
	for i := range samples {
		samples[i] = int16(data[i*2]) | int16(data[i*2+1])<<8
	}
	return samples, nil
}

// pcmBytesLE is decodeTXSamples' mirror: encodes samples back to
// little-endian 16-bit PCM, the same wire format the RX audio hubs (and
// their Opus encoder) already expect — used to feed a transmitting client's
// mic audio into TXAudio.Relay.
func pcmBytesLE(samples []int16) []byte {
	out := make([]byte, len(samples)*2)
	for i, s := range samples {
		out[i*2] = byte(s)
		out[i*2+1] = byte(s >> 8)
	}
	return out
}

// clientIP is the address of the browser behind a request. A direct connection
// gives its own address. When the request comes from this machine itself (a local
// reverse proxy such as `tailscale serve`), the proxy's forwarding headers name
// the real client (X-Forwarded-For: first entry, else X-Real-IP) — those headers
// are only believed in that case, since any direct client could forge them.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if first := strings.TrimSpace(strings.Split(xff, ",")[0]); first != "" {
				return first
			}
		}
		if xr := strings.TrimSpace(r.Header.Get("X-Real-IP")); xr != "" {
			return xr
		}
	}
	return host
}

const (
	wsPingInterval  = 15 * time.Second
	wsReadTimeout   = 45 * time.Second
	wsWriteTimeout  = 5 * time.Second
	wsPingWriteWait = 5 * time.Second
)

var clientNoticeSeq atomic.Uint64

// clientInfo is one connected /ws client as listed in the Traffic window.
type clientInfo struct {
	ID    uint64 `json:"id"`
	User  string `json:"user,omitempty"` // login name (clients outside the local network)
	Name  string `json:"name,omitempty"` // that user's display name
	IP    string `json:"ip"`
	Host  string `json:"host,omitempty"`
	Codec string `json:"codec,omitempty"` // "pcm"/"opus" while this client's RX audio plays, "" otherwise — self-reported, see "audioCodec" below
	Since int64  `json:"since"`           // unix milliseconds
}

func (s *Server) addClient(id uint64, ip, user, name string) {
	s.clientsMu.Lock()
	first := len(s.clients) == 0
	s.clients[id] = &clientInfo{ID: id, User: user, Name: name, IP: ip, Since: time.Now().UnixMilli()}
	s.clientsMu.Unlock()
	s.hub.Broadcast(s.clientsPayload())
	// Any client arriving cancels a pending idle restore.
	s.cancelIdleRestore()
	if first && s.controls.OnFirstClientConnected != nil {
		s.controls.OnFirstClientConnected()
	}
}

func (s *Server) removeClient(id uint64) {
	s.clientsMu.Lock()
	delete(s.clients, id)
	empty := len(s.clients) == 0
	s.clientsMu.Unlock()
	s.hub.Broadcast(s.clientsPayload())
	if empty {
		s.scheduleIdleRestore()
	}
}

func (s *Server) setClientHost(id uint64, host string) {
	s.clientsMu.Lock()
	if c, ok := s.clients[id]; ok {
		c.Host = host
	}
	s.clientsMu.Unlock()
	s.hub.Broadcast(s.clientsPayload())
}

// setClientCodec records which RX audio codec a client is currently playing
// (Nutzer-Wunsch, 2026-10-16: visible per client in the client list, since
// different clients can each pick PCM or Opus independently over their own
// /audio-ws connection — a connection the server has no own way to tie back
// to this client's /ws entry, so the browser self-reports it via the
// "audioCodec" message instead, same pattern as setClientHost above).
func (s *Server) setClientCodec(id uint64, codec string) {
	s.clientsMu.Lock()
	if c, ok := s.clients[id]; ok {
		c.Codec = codec
	}
	s.clientsMu.Unlock()
	s.hub.Broadcast(s.clientsPayload())
}

// clientsPayload is the {"type":"clients","list":[...]} message, oldest first.
func (s *Server) clientsPayload() []byte {
	s.clientsMu.Lock()
	list := make([]clientInfo, 0, len(s.clients))
	for _, c := range s.clients {
		list = append(list, *c)
	}
	s.clientsMu.Unlock()
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	payload, _ := json.Marshal(map[string]any{"type": "clients", "list": list})
	return payload
}

var (
	hostNameMu    sync.Mutex
	hostNameCache = map[string]string{}
)

// lookupHostName resolves a client address to a host name by reverse DNS (with
// Tailscale's MagicDNS that gives the device name), or "" when it cannot be
// resolved quickly. Results, including failures, are cached per address so a
// reconnecting client does not repeat a slow lookup. Loopback is not looked up.
func lookupHostName(ip string) string {
	if parsed := net.ParseIP(ip); parsed == nil || parsed.IsLoopback() {
		return ""
	}
	hostNameMu.Lock()
	name, ok := hostNameCache[ip]
	hostNameMu.Unlock()
	if ok {
		return name
	}
	ctx, cancel := context.WithTimeout(context.Background(), 800*time.Millisecond)
	defer cancel()
	if names, err := net.DefaultResolver.LookupAddr(ctx, ip); err == nil && len(names) > 0 {
		name = strings.TrimSuffix(names[0], ".")
	}
	if name == "" {
		// no reverse DNS entry (typical for phones): ask the device itself by mDNS
		mctx, mcancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		name = mdnsReverse(mctx, ip)
		mcancel()
	}
	hostNameMu.Lock()
	hostNameCache[ip] = name
	hostNameMu.Unlock()
	return name
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("web: websocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	// Register this client (shown in the Traffic window's client list) and tell
	// the others. The address is the one the server sees: behind a reverse
	// proxy/tunnel that is the proxy's, unless it forwards the real one.
	paOK := hasPA(r)
	txOK := hasTX(r)
	ip := clientIP(r)
	id := clientNoticeSeq.Add(1)
	user := auth.sessionUser(r)
	userName := auth.displayName(user)
	s.addClient(id, ip, user, userName)
	defer s.removeClient(id)
	// The reverse lookup of the host name may take a moment, so it (and the
	// "client connected" notice) is done from a goroutine. By then this client is
	// subscribed, so its own copy of the notice is recognised and skipped in the
	// writer loop (the id makes the payload unique per connection: two clients
	// behind the same address must not be mistaken for each other).
	var selfNotice atomic.Pointer[[]byte]
	go func() {
		msg := map[string]any{"type": "clientConnected", "ip": ip, "id": id}
		if user != "" {
			msg["user"] = user
			if userName != "" {
				msg["name"] = userName
			}
		}
		if name := lookupHostName(ip); name != "" {
			msg["host"] = name
			s.setClientHost(id, name)
		}
		if payload, marshalErr := json.Marshal(msg); marshalErr == nil {
			selfNotice.Store(&payload)
			s.hub.Broadcast(payload)
		}
	}()

	ch := s.hub.Subscribe()
	defer s.hub.Unsubscribe(ch)

	snap, err := json.Marshal(s.state.Snapshot())
	if err != nil {
		log.Printf("web: marshaling initial state: %v", err)
		return
	}
	if err := conn.WriteMessage(websocket.TextMessage, snap); err != nil {
		return
	}
	// This client's own id (to mark "you" in the list) and the current client list.
	if idMsg, e := json.Marshal(map[string]any{"type": "clientId", "id": id}); e == nil {
		_ = conn.WriteMessage(websocket.TextMessage, idMsg)
	}
	_ = conn.WriteMessage(websocket.TextMessage, s.clientsPayload())

	// errCh carries one-off messages meant for just this client (a failed
	// "connect", right now) into the same writer loop below as the broadcast
	// channel, so this connection only ever has one goroutine writing to it —
	// gorilla/websocket doesn't allow concurrent writers on one connection.
	errCh := make(chan []byte, 4)

	// done closes when the reader sees the connection end, so the writer loop
	// below (and with it the client list entry) goes away at once, not only at
	// the next broadcast it fails to write.
	done := make(chan struct{})
	// Dead connections (laptop asleep, Wi-Fi gone, no close frame) would otherwise
	// stay "connected" — and in the client list — until TCP gives up, which can
	// take very long. The server pings every wsPingInterval (the browser answers
	// by itself, no JS involved) and drops a connection that stayed silent for
	// wsReadTimeout.
	_ = conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(wsReadTimeout)) })
	go func() {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				conn.Close()
				close(done)
				return
			}
			_ = conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
			s.handleClientMessage(data, id, errCh, conn.RemoteAddr().String(), paOK, txOK)
		}
	}()
	pingTicker := time.NewTicker(wsPingInterval)
	defer pingTicker.Stop()

	for {
		select {
		case <-done:
			return
		case <-pingTicker.C:
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(wsPingWriteWait)); err != nil {
				return
			}
		case msg, ok := <-ch:
			if !ok {
				return
			}
			if own := selfNotice.Load(); own != nil && bytes.Equal(msg, *own) {
				continue // the "client connected" notice about this very connection
			}
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case msg := <-errCh:
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		}
	}
}

// handleSerialPorts lists the serial ports this machine offers, for the
// setup dialog's PA port picker. On macOS the /dev/tty.* twins of each
// /dev/cu.* device are dropped — cu.* is the one to use for outgoing
// connections like this.
func (s *Server) handleSerialPorts(w http.ResponseWriter, r *http.Request) {
	ports, err := serial.GetPortsList()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]string, 0, len(ports))
	for _, p := range ports {
		if strings.HasPrefix(p, "/dev/tty.") {
			continue
		}
		out = append(out, p)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}
