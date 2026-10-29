package web

import (
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"open890rc/internal/hub"
	"open890rc/internal/state"
)

// TestTXAudioActive covers the distinction onPCM (main.go) relies on to
// avoid muting listeners during a TX Message send (Nutzer-Report,
// 2026-10-29): TXAudioActive must be true only while a real mic relay owner
// is claimed and has been heard from recently, false both before any claim
// and again once that owner has gone quiet past claimTXAudio's own 500ms
// takeover window (a TX Message never claims at all, so it must read false
// throughout).
func TestTXAudioActive(t *testing.T) {
	srv := New(hub.New(), state.New(), Controls{}, AudioHubs{}, TXAudio{}, hub.New())

	if srv.TXAudioActive() {
		t.Fatal("TXAudioActive() = true before any claim, want false")
	}

	c := &websocket.Conn{}
	if !srv.claimTXAudio(c) {
		t.Fatal("claimTXAudio on a free server should succeed")
	}
	if !srv.TXAudioActive() {
		t.Fatal("TXAudioActive() = false right after a claim, want true")
	}

	// Simulate the owner having gone quiet past the 500ms takeover window
	// (same threshold claimTXAudio itself uses) without a clean release —
	// e.g. a dropped connection.
	srv.txOwnerMu.Lock()
	srv.txOwnerLast = time.Now().Add(-600 * time.Millisecond)
	srv.txOwnerMu.Unlock()
	if srv.TXAudioActive() {
		t.Fatal("TXAudioActive() = true for an owner stale past the takeover window, want false")
	}

	srv.releaseTXAudio(c)
	if srv.TXAudioActive() {
		t.Fatal("TXAudioActive() = true after releaseTXAudio, want false")
	}
}
