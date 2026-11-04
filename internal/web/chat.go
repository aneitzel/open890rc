package web

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"
)

// Chat between the browsers connected to this server (Nutzer-Wunsch 2026-11-03): short messages with time and name,
// plus a "NAME hat sich verbunden" line when somebody arrives. Kept in memory only (the last chatKeep entries, gone
// at a restart), sent to every new client on connect, broadcast over the normal /ws hub.
// How long after a change the history is written out. Several changes inside this time share one write, which keeps the
// writes (SD card on the Pi) down to a few per day; a clean shutdown writes at once (ChatFlush). A variable for tests.
var chatSaveDelay = 30 * time.Second

const (
	chatKeep      = 50
	chatMaxRunes  = 200
	chatMinGap    = 500 * time.Millisecond // per client, against flooding
	chatLeaveDelay = 20 * time.Second       // a leave is announced only if the name has not come back by then (reload, phone screen off/on)
	chatJoinQuiet = 2 * time.Minute        // a name that reconnects (phone screen off/on) does not announce itself again
)

type chatEntry struct {
	Seq  uint64 `json:"seq"`
	T    int64  `json:"t"`    // unix milliseconds
	Kind string `json:"kind"` // "msg", "join" or "leave"
	Name string `json:"name"`
	Text string `json:"text,omitempty"`
}

// chatNameOf is how a client is called in the chat: name and login ("André Neitzel (HB9INA)", or just the login when no
// name is set) for users who logged in, otherwise (local network, no login) the short host name, and the address when
// there is none.
func chatNameOf(c clientInfo) string {
	if c.User != "" {
		if c.Name != "" {
			return c.Name + " (" + c.User + ")"
		}
		return c.User
	}
	if c.Host != "" {
		if i := strings.IndexByte(c.Host, '.'); i > 0 {
			return c.Host[:i]
		}
		return c.Host
	}
	return c.IP
}

func (s *Server) chatClientName(id uint64) (string, bool) {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()
	c, ok := s.clients[id]
	if !ok {
		return "", false
	}
	return chatNameOf(*c), true
}

// chatStore is where the history is kept between runs (the "chat" section of the shared config file, wired up in main).
type chatStore struct {
	load func() ([]byte, bool)
	save func([]byte) error
}

// chatSaved is the persisted form: the log plus the sequence counter, so numbering goes on after a restart.
type chatSaved struct {
	Seq uint64      `json:"seq"`
	Log []chatEntry `json:"log"`
}

// SetChatStore connects the history to its storage and loads what an earlier run left (nil funcs = memory only).
func (s *Server) SetChatStore(load func() ([]byte, bool), save func([]byte) error) {
	s.chatMu.Lock()
	defer s.chatMu.Unlock()
	s.chatStore = &chatStore{load: load, save: save}
	data, ok := load()
	if !ok {
		return
	}
	var saved chatSaved
	if err := json.Unmarshal(data, &saved); err != nil {
		log.Printf("chat: ignoring unreadable saved history: %v", err)
		return
	}
	if len(saved.Log) > chatKeep {
		saved.Log = saved.Log[len(saved.Log)-chatKeep:]
	}
	s.chatLog = saved.Log
	s.chatSeq = saved.Seq
	for _, e := range saved.Log { // never hand out a number a kept line already has
		if e.Seq > s.chatSeq {
			s.chatSeq = e.Seq
		}
	}
}

// chatDirtyLocked notes an unsaved change and, if no write is pending, schedules one chatSaveDelay from now.
func (s *Server) chatDirtyLocked() {
	if s.chatStore == nil {
		return
	}
	s.chatDirty = true
	if s.chatTimer == nil {
		s.chatTimer = time.AfterFunc(chatSaveDelay, func() { s.ChatFlush() })
	}
}

// ChatFlush writes the history out if something changed since the last write. Called by the timer and at shutdown.
func (s *Server) ChatFlush() {
	s.chatMu.Lock()
	if s.chatTimer != nil {
		s.chatTimer.Stop()
		s.chatTimer = nil
	}
	if s.chatStore == nil || !s.chatDirty {
		s.chatMu.Unlock()
		return
	}
	data, err := json.Marshal(chatSaved{Seq: s.chatSeq, Log: s.chatLog})
	save := s.chatStore.save
	s.chatDirty = false
	s.chatMu.Unlock()
	if err != nil {
		log.Printf("chat: saving history: %v", err)
		return
	}
	if err := save(data); err != nil {
		log.Printf("chat: saving history: %v", err)
		s.chatMu.Lock()
		s.chatDirty = true // try again with the next change or at shutdown
		s.chatMu.Unlock()
	}
}

// chatEnabled: an admin can switch the whole chat off (stored with the users file, default on).
func chatEnabled() bool {
	auth.mu.Lock()
	defer auth.mu.Unlock()
	return !auth.chatOff
}

func chatConfigPayload() []byte {
	payload, _ := json.Marshal(map[string]any{"type": "chatConfig", "enabled": chatEnabled()})
	return payload
}

// handleChatEnabled: GET returns {enabled}, POST {enabled} switches the chat on/off for everybody (admin only, see the
// route) and tells all connected browsers so they show or hide it at once.
func (s *Server) handleChatEnabled(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"enabled": chatEnabled()})
	case http.MethodPost:
		var req struct {
			Enabled bool `json:"enabled"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		auth.mu.Lock()
		auth.chatOff = !req.Enabled
		err := auth.saveLocked()
		auth.mu.Unlock()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "Speichern fehlgeschlagen: " + err.Error()})
			return
		}
		s.hub.Broadcast(chatConfigPayload())
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// chatAdd stores an entry and tells everybody.
func (s *Server) chatAdd(kind, name, text string) {
	if !chatEnabled() {
		return
	}
	s.chatMu.Lock()
	s.chatSeq++
	e := chatEntry{Seq: s.chatSeq, T: time.Now().UnixMilli(), Kind: kind, Name: name, Text: text}
	s.chatLog = append(s.chatLog, e)
	if len(s.chatLog) > chatKeep {
		s.chatLog = s.chatLog[len(s.chatLog)-chatKeep:]
	}
	s.chatDirtyLocked()
	s.chatMu.Unlock()
	payload, _ := json.Marshal(struct {
		Type string `json:"type"`
		chatEntry
	}{"chat", e})
	s.hub.Broadcast(payload)
}

// chatPost handles a message typed by client id (the name always comes from the server, never from the browser).
func (s *Server) chatPost(id uint64, text string) {
	if !chatEnabled() {
		return
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	if r := []rune(text); len(r) > chatMaxRunes {
		text = string(r[:chatMaxRunes])
	}
	name, ok := s.chatClientName(id)
	if !ok {
		return
	}
	now := time.Now()
	s.chatMu.Lock()
	if s.chatLastPost == nil {
		s.chatLastPost = map[uint64]time.Time{}
	}
	if now.Sub(s.chatLastPost[id]) < chatMinGap {
		s.chatMu.Unlock()
		return
	}
	s.chatLastPost[id] = now
	s.chatMu.Unlock()
	s.chatAdd("msg", name, text)
}

// chatJoin announces a newly connected client (called once its host name is known).
func (s *Server) chatJoin(id uint64) {
	if !chatEnabled() {
		return
	}
	name, ok := s.chatClientName(id)
	if !ok {
		return
	}
	now := time.Now()
	s.chatMu.Lock()
	if s.chatLastJoin == nil {
		s.chatLastJoin = map[string]time.Time{}
	}
	if last, seen := s.chatLastJoin[name]; seen && now.Sub(last) < chatJoinQuiet {
		s.chatLastJoin[name] = now
		s.chatMu.Unlock()
		return
	}
	s.chatLastJoin[name] = now
	s.chatMu.Unlock()
	s.chatAdd("join", name, "")
}

// chatLeave announces that a client went away, but only when no other connection of the same name exists after
// chatLeaveDelay (a reload or a phone waking up again is not a leave). Call it while the client is still registered.
func (s *Server) chatLeave(id uint64) {
	name, ok := s.chatClientName(id)
	if !ok || !chatEnabled() {
		return
	}
	time.AfterFunc(chatLeaveDelay, func() {
		s.clientsMu.Lock()
		for cid, c := range s.clients {
			if cid != id && chatNameOf(*c) == name {
				s.clientsMu.Unlock()
				return
			}
		}
		s.clientsMu.Unlock()
		s.chatMu.Lock()
		delete(s.chatLastJoin, name) // coming back after a leave announces itself again
		s.chatMu.Unlock()
		s.chatAdd("leave", name, "")
	})
}

// chatDelete removes one line (by sequence number) from the log and tells all browsers to drop it.
func (s *Server) chatDelete(seq uint64) {
	s.chatMu.Lock()
	found := false
	for i, e := range s.chatLog {
		if e.Seq == seq {
			s.chatLog = append(s.chatLog[:i:i], s.chatLog[i+1:]...)
			found = true
			s.chatDirtyLocked()
			break
		}
	}
	s.chatMu.Unlock()
	if !found {
		return
	}
	payload, _ := json.Marshal(map[string]any{"type": "chatDeleted", "seq": seq})
	s.hub.Broadcast(payload)
}

// chatClear removes the whole history (numbering goes on, so lines sent later cannot be mistaken for deleted ones) and
// tells all browsers to empty their window.
func (s *Server) chatClear() {
	s.chatMu.Lock()
	had := len(s.chatLog) > 0
	s.chatLog = nil
	if had {
		s.chatDirtyLocked()
	}
	s.chatMu.Unlock()
	payload, _ := json.Marshal(map[string]any{"type": "chatCleared"})
	s.hub.Broadcast(payload)
}

// chatForget drops the rate-limit entry of a client that left.
func (s *Server) chatForget(id uint64) {
	s.chatMu.Lock()
	delete(s.chatLastPost, id)
	s.chatMu.Unlock()
}

// chatHistoryPayload is the {"type":"chatHistory","list":[...]} message for a client that just connected.
func (s *Server) chatHistoryPayload() []byte {
	s.chatMu.Lock()
	list := append([]chatEntry{}, s.chatLog...)
	s.chatMu.Unlock()
	payload, _ := json.Marshal(map[string]any{"type": "chatHistory", "list": list})
	return payload
}
