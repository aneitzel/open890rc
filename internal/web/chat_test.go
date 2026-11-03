package web

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"open890rc/internal/hub"
	"open890rc/internal/state"
)

func TestChatNameOf(t *testing.T) {
	cases := []struct {
		c    clientInfo
		want string
	}{
		{clientInfo{User: "HB9INA", Host: "mac.local", IP: "192.168.1.5"}, "HB9INA"},
		{clientInfo{User: "HB9INA", Name: "André Neitzel", Host: "mac.local", IP: "192.168.1.5"}, "André Neitzel (HB9INA)"},
		{clientInfo{Host: "iphone-von-andre.fritz.box", IP: "192.168.1.6"}, "iphone-von-andre"},
		{clientInfo{Host: "pi", IP: "192.168.1.7"}, "pi"},
		{clientInfo{IP: "192.168.1.8"}, "192.168.1.8"},
	}
	for _, tc := range cases {
		if got := chatNameOf(tc.c); got != tc.want {
			t.Errorf("chatNameOf(%+v) = %q, want %q", tc.c, got, tc.want)
		}
	}
}

func TestChatPostJoinHistory(t *testing.T) {
	srv := New(hub.New(), state.New(), Controls{}, AudioHubs{}, TXAudio{}, hub.New())
	srv.clients[1] = &clientInfo{ID: 1, User: "AAA", IP: "10.0.0.1"}
	srv.clients[2] = &clientInfo{ID: 2, IP: "10.0.0.2", Host: "laptop.lan"}

	srv.chatJoin(1)
	srv.chatJoin(1) // reconnect inside the quiet window: no second announcement
	srv.chatJoin(2)
	srv.chatPost(1, "  hallo  ")
	srv.chatPost(1, "zu schnell") // inside chatMinGap
	srv.chatPost(2, "")           // empty
	srv.chatPost(99, "unbekannt") // not a connected client
	if len(srv.chatLog) != 3 {
		t.Fatalf("log has %d entries, want 3 (join AAA, join laptop, msg): %+v", len(srv.chatLog), srv.chatLog)
	}
	if e := srv.chatLog[2]; e.Kind != "msg" || e.Name != "AAA" || e.Text != "hallo" {
		t.Errorf("message entry = %+v", e)
	}
	if srv.chatLog[1].Name != "laptop" || srv.chatLog[1].Kind != "join" {
		t.Errorf("join entry = %+v", srv.chatLog[1])
	}

	// the log keeps only the last chatKeep entries, sequence numbers keep counting
	for i := 0; i < chatKeep+10; i++ {
		srv.chatAdd("msg", "X", "n")
	}
	if len(srv.chatLog) != chatKeep {
		t.Errorf("log length %d, want %d", len(srv.chatLog), chatKeep)
	}
	if last := srv.chatLog[len(srv.chatLog)-1].Seq; last != uint64(3+chatKeep+10) {
		t.Errorf("last seq %d", last)
	}

	// rate limit lifts after the gap
	srv.chatMu.Lock()
	srv.chatLastPost[1] = time.Now().Add(-time.Second)
	srv.chatMu.Unlock()
	before := srv.chatLog[len(srv.chatLog)-1].Seq
	srv.chatPost(1, "wieder")
	if srv.chatLog[len(srv.chatLog)-1].Seq != before+1 {
		t.Error("message after the gap was not accepted")
	}
}

func TestChatEnabledSwitch(t *testing.T) {
	SetUsersFile(t.TempDir() + "/users.json")
	t.Cleanup(func() { SetUsersFile("") })
	srv := New(hub.New(), state.New(), Controls{}, AudioHubs{}, TXAudio{}, hub.New())
	srv.clients[1] = &clientInfo{ID: 1, User: "AAA", IP: "10.0.0.1"}

	post := func(enabled bool) {
		req := httptest.NewRequest(http.MethodPost, "/api/chat-enabled", strings.NewReader(fmt.Sprintf(`{"enabled":%v}`, enabled)))
		rec := httptest.NewRecorder()
		srv.handleChatEnabled(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("POST enabled=%v: status %d %s", enabled, rec.Code, rec.Body.String())
		}
	}
	if !chatEnabled() {
		t.Fatal("chat should be on by default")
	}
	post(false)
	if chatEnabled() {
		t.Fatal("chat still on after switching off")
	}
	srv.chatJoin(1)
	srv.chatPost(1, "hallo")
	if len(srv.chatLog) != 0 {
		t.Errorf("chat log has %d entries while the chat is off", len(srv.chatLog))
	}
	// the setting survives a reload of the users file
	SetUsersFile(auth.path)
	if chatEnabled() {
		t.Error("switched-off chat came back on after reloading the users file")
	}
	post(true)
	srv.chatPost(1, "wieder da")
	if len(srv.chatLog) != 1 {
		t.Errorf("chat log has %d entries after switching on again, want 1", len(srv.chatLog))
	}
}

func TestChatDeleteAdminOnly(t *testing.T) {
	h := hub.New()
	srv := New(h, state.New(), Controls{}, AudioHubs{}, TXAudio{}, hub.New())
	srv.clients[1] = &clientInfo{ID: 1, User: "AAA", IP: "10.0.0.1"}
	srv.chatAdd("msg", "AAA", "eins")
	srv.chatAdd("msg", "AAA", "zwei")
	srv.chatAdd("msg", "AAA", "drei")
	ch := h.Subscribe()
	defer h.Unsubscribe(ch)

	del := []byte(`{"type":"chatDelete","seq":2}`)
	srv.handleClientMessage(del, 1, nil, "x", true, true, false) // not an admin: ignored
	if len(srv.chatLog) != 3 {
		t.Fatalf("a non-admin deleted a line: %+v", srv.chatLog)
	}
	srv.handleClientMessage(del, 1, nil, "x", false, false, true) // admin
	if len(srv.chatLog) != 2 || srv.chatLog[0].Seq != 1 || srv.chatLog[1].Seq != 3 {
		t.Fatalf("log after delete: %+v", srv.chatLog)
	}
	select {
	case msg := <-ch:
		if string(msg) != `{"seq":2,"type":"chatDeleted"}` {
			t.Errorf("broadcast = %s", msg)
		}
	case <-time.After(time.Second):
		t.Error("no chatDeleted broadcast")
	}
	srv.handleClientMessage(del, 1, nil, "x", false, false, true) // already gone: no second broadcast
	select {
	case msg := <-ch:
		t.Errorf("unexpected broadcast for an already deleted line: %s", msg)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestChatPersistence(t *testing.T) {
	old := chatSaveDelay
	chatSaveDelay = 50 * time.Millisecond
	t.Cleanup(func() { chatSaveDelay = old })

	var stored []byte
	var saves int
	var mu sync.Mutex
	load := func() ([]byte, bool) { mu.Lock(); defer mu.Unlock(); return stored, stored != nil }
	save := func(b []byte) error {
		mu.Lock()
		defer mu.Unlock()
		stored = append([]byte(nil), b...)
		saves++
		return nil
	}

	srv := New(hub.New(), state.New(), Controls{}, AudioHubs{}, TXAudio{}, hub.New())
	srv.SetChatStore(load, save)
	srv.chatAdd("msg", "AAA", "eins")
	srv.chatAdd("msg", "AAA", "zwei")
	srv.chatAdd("msg", "AAA", "drei")
	srv.chatDelete(2)
	time.Sleep(10 * time.Millisecond)
	mu.Lock()
	if saves != 0 {
		mu.Unlock()
		t.Fatal("written before the delay is over")
	}
	mu.Unlock()
	time.Sleep(150 * time.Millisecond)
	mu.Lock()
	if saves != 1 {
		mu.Unlock()
		t.Fatalf("%d writes for a burst of changes, want 1", saves)
	}
	mu.Unlock()
	srv.ChatFlush() // nothing changed since: no write
	mu.Lock()
	if saves != 1 {
		mu.Unlock()
		t.Fatalf("flush without a change wrote again (%d)", saves)
	}
	mu.Unlock()

	// a change right before shutdown is written by the flush, not lost
	srv.chatAdd("msg", "AAA", "vier")
	srv.ChatFlush()
	mu.Lock()
	if saves != 2 {
		mu.Unlock()
		t.Fatalf("flush did not write the pending change (%d)", saves)
	}
	mu.Unlock()

	// a new server (restart) gets the log back and numbering goes on
	srv2 := New(hub.New(), state.New(), Controls{}, AudioHubs{}, TXAudio{}, hub.New())
	srv2.SetChatStore(load, save)
	if len(srv2.chatLog) != 3 || srv2.chatLog[0].Text != "eins" || srv2.chatLog[1].Text != "drei" || srv2.chatLog[2].Text != "vier" {
		t.Fatalf("restored log: %+v", srv2.chatLog)
	}
	srv2.chatAdd("msg", "BBB", "fuenf")
	if last := srv2.chatLog[len(srv2.chatLog)-1].Seq; last != 5 {
		t.Errorf("sequence after restart = %d, want 5 (1,3,4 kept, 2 deleted, 4 was the last handed out)", last)
	}
	srv2.ChatFlush()
}

func TestChatClearAdminOnly(t *testing.T) {
	h := hub.New()
	srv := New(h, state.New(), Controls{}, AudioHubs{}, TXAudio{}, hub.New())
	srv.chatAdd("msg", "AAA", "eins")
	srv.chatAdd("msg", "AAA", "zwei")
	ch := h.Subscribe()
	defer h.Unsubscribe(ch)

	clear := []byte(`{"type":"chatClear"}`)
	srv.handleClientMessage(clear, 1, nil, "x", true, true, false) // not an admin: ignored
	if len(srv.chatLog) != 2 {
		t.Fatalf("a non-admin cleared the chat: %+v", srv.chatLog)
	}
	srv.handleClientMessage(clear, 1, nil, "x", false, false, true)
	if len(srv.chatLog) != 0 {
		t.Fatalf("log after clear: %+v", srv.chatLog)
	}
	select {
	case msg := <-ch:
		if string(msg) != `{"type":"chatCleared"}` {
			t.Errorf("broadcast = %s", msg)
		}
	case <-time.After(time.Second):
		t.Error("no chatCleared broadcast")
	}
	srv.chatAdd("msg", "AAA", "neu")
	if got := srv.chatLog[0].Seq; got != 3 {
		t.Errorf("first line after a clear has seq %d, want 3 (numbering goes on)", got)
	}
}
