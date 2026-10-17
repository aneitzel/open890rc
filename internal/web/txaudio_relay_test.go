package web

import (
	"net"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"open890rc/internal/audio"
	"open890rc/internal/hub"
	"open890rc/internal/state"
)

// TestTXAudioRelay is an end-to-end check of the simplex "mix a
// transmitting client's mic audio into the RX audio stream" feature
// (Nutzer-Wunsch, 2026-10-14, replacing the earlier plan of a separate
// monitor channel): a listening client on /audio-ws must receive, byte for
// byte, the same PCM a transmitting client sends on /audio-tx-ws — wired
// exactly like main.go wires TXAudio.Relay to the real pcmHub.Broadcast, not
// a mock. It also confirms the pre-existing radio-bound path (Sender.Send)
// still fires unchanged alongside the new relay.
func TestTXAudioRelay(t *testing.T) {
	// A real TXSender needs a real UDP destination; a local throwaway
	// listener stands in for "the radio".
	radioConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatalf("listening for fake radio UDP: %v", err)
	}
	defer radioConn.Close()
	radioPort := radioConn.LocalAddr().(*net.UDPAddr).Port

	sender, err := audio.NewTXSender("127.0.0.1", radioPort)
	if err != nil {
		t.Fatalf("audio.NewTXSender: %v", err)
	}
	defer sender.Close()

	pcmHub := hub.New()
	srv := New(hub.New(), state.New(), Controls{}, AudioHubs{PCM: pcmHub}, TXAudio{
		Sender:     func() *audio.TXSender { return sender },
		NewDecoder: audio.NewOpusDecoder,
		Relay:      pcmHub.Broadcast, // exactly how main.go wires broadcastRXAudio in
	}, hub.New())

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	wsBase := "ws" + strings.TrimPrefix(ts.URL, "http")

	// A second, otherwise uninvolved browser just listening to RX audio.
	listener, _, err := websocket.DefaultDialer.Dial(wsBase+"/audio-ws?codec=pcm", nil)
	if err != nil {
		t.Fatalf("dialing /audio-ws: %v", err)
	}
	defer listener.Close()

	sendWS, _, err := websocket.DefaultDialer.Dial(wsBase+"/audio-tx-ws?codec=pcm", nil)
	if err != nil {
		t.Fatalf("dialing /audio-tx-ws: %v", err)
	}
	defer sendWS.Close()

	// One exact TXFrameSamples (320) frame of a simple ramp, little-endian —
	// the same wire convention the browser's "pcm" codec uses.
	samples := make([]int16, audio.TXFrameSamples)
	for i := range samples {
		samples[i] = int16(i*7 - 1000)
	}
	payload := make([]byte, len(samples)*2)
	for i, s := range samples {
		payload[i*2] = byte(s)
		payload[i*2+1] = byte(s >> 8)
	}
	if err := sendWS.WriteMessage(websocket.BinaryMessage, payload); err != nil {
		t.Fatalf("writing TX audio frame: %v", err)
	}

	listener.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, got, err := listener.ReadMessage()
	if err != nil {
		t.Fatalf("listening client never received the relayed mic audio: %v", err)
	}
	if len(got) != len(payload) {
		t.Fatalf("relayed frame length = %d, want %d", len(got), len(payload))
	}
	for i := range payload {
		if got[i] != payload[i] {
			t.Fatalf("relayed byte %d = %d, want %d (relay must be a faithful little-endian copy of the sent samples)", i, got[i], payload[i])
		}
	}

	// The pre-existing path to the radio must still work unchanged.
	radioConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 2000)
	n, _, err := radioConn.ReadFromUDP(buf)
	if err != nil {
		t.Fatalf("expected an RTP packet at the fake radio, got: %v", err)
	}
	if n < 12 {
		t.Fatalf("RTP packet too short: %d bytes", n)
	}
	t.Logf("listening client received %d bytes, radio received %d bytes", len(got), n)
}
