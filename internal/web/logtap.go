package web

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// LogTap is an io.Writer that keeps the last log lines of the server (the output
// that also goes to its console / journal) and hands new ones to subscribers —
// the "Debug" tab of the user management shows them live.
type LogTap struct {
	mu      sync.Mutex
	lines   []string
	partial string
	subs    map[chan string]struct{}
}

const logTapKeep = 1000

// DebugLog is the server-wide tap; main points the standard logger at it.
var DebugLog = &LogTap{subs: map[chan string]struct{}{}}

func (t *LogTap) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	data := t.partial + string(p)
	t.partial = ""
	for {
		i := -1
		for k := 0; k < len(data); k++ {
			if data[k] == '\n' {
				i = k
				break
			}
		}
		if i < 0 {
			break
		}
		line := data[:i]
		data = data[i+1:]
		t.lines = append(t.lines, line)
		if len(t.lines) > logTapKeep {
			t.lines = t.lines[len(t.lines)-logTapKeep:]
		}
		for ch := range t.subs {
			select {
			case ch <- line:
			default: // a slow viewer loses lines rather than blocking the server
			}
		}
	}
	t.partial = data
	return len(p), nil
}

// subscribe returns the lines kept so far and a channel for the following ones.
func (t *LogTap) subscribe() ([]string, chan string, func()) {
	t.mu.Lock()
	defer t.mu.Unlock()
	ch := make(chan string, 512)
	t.subs[ch] = struct{}{}
	history := append([]string(nil), t.lines...)
	return history, ch, func() {
		t.mu.Lock()
		delete(t.subs, ch)
		t.mu.Unlock()
	}
}

// handleDebugWS streams the server log to a local-network (admin) browser: first
// the lines kept so far, then batches of new ones every 250 ms.
func handleDebugWS(w http.ResponseWriter, r *http.Request) {
	if !isAdmin(r) {
		http.Error(w, "admin only", http.StatusForbidden)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	history, ch, cancel := DebugLog.subscribe()
	defer cancel()

	send := func(lines []string) bool {
		payload, _ := json.Marshal(map[string]any{"lines": lines})
		return conn.WriteMessage(websocket.TextMessage, payload) == nil
	}
	if !send(history) {
		return
	}
	done := make(chan struct{})
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				close(done)
				return
			}
		}
	}()
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	var batch []string
	for {
		select {
		case <-done:
			return
		case line := <-ch:
			batch = append(batch, line)
		case <-tick.C:
			if len(batch) > 0 {
				if !send(batch) {
					return
				}
				batch = batch[:0]
			}
		}
	}
}
