package web

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Access control. Browsers on the local network (private/loopback/link-local
// addresses, see isLAN) need no login and count as admins: they may manage the
// users and see the settings; a user of the users file can carry an admin flag
// for the same rights after login. Everybody else (Tailscale, Internet) must log in with a user from the
// users file before any of the WebSocket endpoints answers. The users file holds
// PBKDF2 password hashes, never the passwords.
const (
	pbkdf2Iterations = 210000
	sessionLifetime  = 12 * time.Hour // TODO: make configurable
	maxLoginFailures = 5
	loginLockout     = time.Minute
	sessionCookie    = "open890rc_session"
)

var validUserName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,8}$`)

type authState struct {
	mu     sync.Mutex
	path   string
	users  map[string]string // name -> "pbkdf2$iter$salt$hash"
	names  map[string]string // name -> free-text display name ("André Neitzel")
	admins map[string]bool   // name -> admin flag (settings + user management)
	pas    map[string]bool   // name -> may see/use the PA
	// noTX is a DENY list, the opposite polarity of admins/pas: most users
	// may transmit, so absence here (the Go zero value for a missing map
	// key) means "may transmit" — only users explicitly marked here are
	// restricted to listening (Nutzer-Wunsch 2026-10-18). Keeping it this
	// way round, instead of a "txs" grant list like pas, also means an
	// existing users file from before this flag existed needs no migration:
	// every user already in it keeps transmitting exactly as before.
	noTX     map[string]bool
	loginMsg string // text above the login fields ("" = default)
	sessions map[string]session
	fails    map[string]*failState // by client address
}

type session struct {
	user    string
	expires time.Time
}

type failState struct {
	count int
	until time.Time
}

var auth = &authState{users: map[string]string{}, names: map[string]string{}, admins: map[string]bool{}, pas: map[string]bool{}, noTX: map[string]bool{}, sessions: map[string]session{}, fails: map[string]*failState{}}

// SetUsersFile points the access control at its users file and loads it.
func SetUsersFile(path string) {
	auth.mu.Lock()
	defer auth.mu.Unlock()
	auth.path = path
	auth.users = map[string]string{}
	auth.names = map[string]string{}
	auth.admins = map[string]bool{}
	auth.pas = map[string]bool{}
	auth.noTX = map[string]bool{}
	data, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("auth: reading %s: %v", path, err)
		}
		return
	}
	var f struct {
		Users  map[string]string `json:"users"`
		Names  map[string]string `json:"names"`
		Admins map[string]bool   `json:"admins"`
		PA     map[string]bool   `json:"pa"`
		NoTX   map[string]bool   `json:"noTx"`
		Login  string            `json:"loginMessage"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		log.Printf("auth: parsing %s: %v", path, err)
		return
	}
	if f.Users != nil {
		auth.users = f.Users
	}
	if f.Names != nil {
		auth.names = f.Names
	}
	if f.Admins != nil {
		auth.admins = f.Admins
	}
	if f.PA != nil {
		auth.pas = f.PA
	}
	if f.NoTX != nil {
		auth.noTX = f.NoTX
	}
	auth.loginMsg = f.Login
}

// displayName is the free-text name of a user ("" if none was entered).
func (a *authState) displayName(user string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.names[user]
}

func (a *authState) saveLocked() error {
	if a.path == "" {
		return errors.New("no users file configured")
	}
	data, err := json.MarshalIndent(map[string]any{"users": a.users, "names": a.names, "admins": a.admins, "pa": a.pas, "noTx": a.noTX, "loginMessage": a.loginMsg}, "", "  ")
	if err != nil {
		return err
	}
	tmp := a.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, a.path)
}

func hashPassword(pw string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, pw, salt, pbkdf2Iterations, 32)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("pbkdf2$%d$%s$%s", pbkdf2Iterations, base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

func checkPassword(stored, pw string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter < 1 {
		return false
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(parts[2])
	want, err2 := base64.RawStdEncoding.DecodeString(parts[3])
	if err1 != nil || err2 != nil {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, pw, salt, iter, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// tailscaleULA is Tailscale's IPv6 range: formally a private (ULA) range, but
// reachable from far outside the home network, so it does not count as LAN.
var tailscaleULA = &net.IPNet{IP: net.ParseIP("fd7a:115c:a1e0::"), Mask: net.CIDRMask(48, 128)}

// isLAN reports whether the request comes from the local network (see clientIP
// for which address that is behind a local proxy).
func isLAN(r *http.Request) bool {
	ip := net.ParseIP(clientIP(r))
	if ip == nil {
		return false
	}
	if ip4 := ip.To4(); ip4 != nil {
		ip = ip4
	}
	if tailscaleULA.Contains(ip) {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

func newToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (a *authState) validSession(r *http.Request) bool {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	s, ok := a.sessions[c.Value]
	if !ok {
		return false
	}
	if time.Now().After(s.expires) {
		delete(a.sessions, c.Value)
		return false
	}
	return true
}

// sessionUser is the user name of the request's login session ("" if none, e.g.
// for local-network clients, which do not log in).
func (a *authState) sessionUser(r *http.Request) string {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if s, ok := a.sessions[c.Value]; ok && time.Now().Before(s.expires) {
		return s.user
	}
	return ""
}

// isAdmin: LAN clients and logged-in users with the admin flag.
func isAdmin(r *http.Request) bool {
	if isLAN(r) {
		return true
	}
	user := auth.sessionUser(r)
	if user == "" {
		return false
	}
	auth.mu.Lock()
	defer auth.mu.Unlock()
	return auth.admins[user]
}

// hasPA: who sees and may use the PA — LAN clients, admins, and users with the
// PA flag. Everybody else gets no PA display and the server drops their PA commands.
func hasPA(r *http.Request) bool {
	if isLAN(r) {
		return true
	}
	user := auth.sessionUser(r)
	if user == "" {
		return false
	}
	auth.mu.Lock()
	defer auth.mu.Unlock()
	return auth.admins[user] || auth.pas[user]
}

// hasTX: who may transmit (TX button, PTT, TUNE, the microphone) — LAN
// clients, admins, and any logged-in user NOT on the noTX deny list. The
// opposite default from hasPA/isAdmin: most users can transmit, so a
// not-logged-in request is the only case that's denied outright here; a
// logged-in user needs an explicit noTX entry to lose TX, not an explicit
// grant to have it. Everybody else gets the TX controls hidden/disabled and
// the server drops their setTX/setTune and refuses /audio-tx-ws.
func hasTX(r *http.Request) bool {
	if isLAN(r) {
		return true
	}
	user := auth.sessionUser(r)
	if user == "" {
		return false
	}
	auth.mu.Lock()
	defer auth.mu.Unlock()
	if auth.admins[user] {
		return true
	}
	return !auth.noTX[user]
}

// requireAuth lets LAN clients through; everybody else needs a valid session.
func requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if isLAN(r) || auth.validSession(r) {
			next(w, r)
			return
		}
		http.Error(w, "login required", http.StatusUnauthorized)
	}
}

// requireTX: /audio-tx-ws itself (not just the setTX control message) is
// gated too, so a listen-only user's browser can't even open a mic-audio
// socket to the server in the first place.
func requireTX(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !hasTX(r) {
			http.Error(w, "no TX access", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

// requireAdmin: user management is for LAN clients and admin-flagged users. The custom header keeps
// foreign web pages from triggering these calls (it forces a CORS preflight).
func requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isAdmin(r) {
			http.Error(w, "admin only", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Header.Get("X-Requested-With") != "open890rc" {
			http.Error(w, "missing header", http.StatusBadRequest)
			return
		}
		next(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// handleAuthStatus tells the page whether it has to show the login mask (not on
// the LAN) and whether it is an admin (on the LAN, or logged in as an admin user).
func handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	lan := isLAN(r)
	auth.mu.Lock()
	msg := auth.loginMsg
	auth.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"loginRequired": !lan, "admin": isAdmin(r), "pa": hasPA(r), "tx": hasTX(r), "loginMessage": msg})
}

// handleLoginMessage: GET returns the text shown above the login fields, POST
// {message} sets it (empty = back to the built-in default). Admin only.
func handleLoginMessage(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		auth.mu.Lock()
		msg := auth.loginMsg
		auth.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"message": msg})
	case http.MethodPost:
		var req struct {
			Message string `json:"message"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		msg := strings.TrimSpace(strings.ReplaceAll(req.Message, "\r", ""))
		lines := strings.Split(msg, "\n")
		if len(lines) > 4 || len([]rune(msg)) > 300 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Login Nachricht: höchstens 4 Zeilen, 300 Zeichen"})
			return
		}
		auth.mu.Lock()
		auth.loginMsg = msg
		err := auth.saveLocked()
		auth.mu.Unlock()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "Speichern fehlgeschlagen: " + err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	if isLAN(r) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	var req struct {
		User string `json:"user"`
		Pass string `json:"pass"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	addr := clientIP(r)
	now := time.Now()
	auth.mu.Lock()
	f := auth.fails[addr]
	if f != nil && now.Before(f.until) {
		wait := int(f.until.Sub(now).Seconds()) + 1
		auth.mu.Unlock()
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "Zu viele Fehlversuche", "retryAfter": wait})
		return
	}
	stored, known := auth.users[req.User]
	auth.mu.Unlock()
	// hash even for an unknown user so timing does not reveal which names exist
	ok := known && checkPassword(stored, req.Pass)
	if !known {
		_ = checkPassword("pbkdf2$1$AAAA$AAAA", req.Pass)
	}

	auth.mu.Lock()
	defer auth.mu.Unlock()
	if !ok {
		if f == nil {
			f = &failState{}
			auth.fails[addr] = f
		}
		f.count++
		if f.count >= maxLoginFailures {
			f.count = 0
			f.until = time.Now().Add(loginLockout)
			log.Printf("auth: %s locked out for %v after %d failed logins", addr, loginLockout, maxLoginFailures)
		}
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Benutzer oder Passwort falsch"})
		return
	}
	delete(auth.fails, addr)
	token := newToken()
	auth.sessions[token] = session{user: req.User, expires: time.Now().Add(sessionLifetime)}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: token, Path: "/", HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
		MaxAge:   int(sessionLifetime.Seconds()),
	})
	log.Printf("auth: %s logged in from %s", req.User, addr)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		auth.mu.Lock()
		delete(auth.sessions, c.Value)
		auth.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Path: "/", MaxAge: -1})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleUsers: GET lists the users ({name, displayName}), POST {name, displayName,
// password} adds a user or changes an existing one (a password is required for a
// new user, optional afterwards), DELETE ?name= removes one. (Admin only.)
func handleUsers(w http.ResponseWriter, r *http.Request) {
	type userRow struct {
		Name        string `json:"name"`
		DisplayName string `json:"displayName"`
		Admin       bool   `json:"admin"`
		PA          bool   `json:"pa"`
		TX          bool   `json:"tx"`
	}
	fail := func(status int, msg string) { writeJSON(w, status, map[string]any{"error": msg}) }
	switch r.Method {
	case http.MethodGet:
		auth.mu.Lock()
		rows := make([]userRow, 0, len(auth.users))
		for n := range auth.users {
			rows = append(rows, userRow{Name: n, DisplayName: auth.names[n], Admin: auth.admins[n], PA: auth.pas[n], TX: !auth.noTX[n]})
		}
		auth.mu.Unlock()
		sort.Slice(rows, func(i, j int) bool { return rows[i].Name < rows[j].Name })
		writeJSON(w, http.StatusOK, map[string]any{"users": rows})
	case http.MethodPost:
		var req struct {
			Name        string `json:"name"`
			DisplayName string `json:"displayName"`
			Password    string `json:"password"`
			Admin       bool   `json:"admin"`
			PA          bool   `json:"pa"`
			// Pointer, unlike Admin/PA: nil (omitted) must mean "allowed",
			// matching noTX's own default-allow polarity — a plain bool
			// would silently deny any caller that leaves "tx" out, the
			// opposite of hasTX's documented default. The browser's own
			// edit form always sends an explicit true/false either way.
			TX      *bool  `json:"tx"`
			OldName string `json:"oldName"` // set when the login is renamed
			Create  bool   `json:"create"`  // new user: refuse an existing login
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if !validUserName.MatchString(req.Name) {
			fail(http.StatusBadRequest, "User: 1-8 Zeichen (Buchstaben, Ziffern, . _ -)")
			return
		}
		display := strings.TrimSpace(req.DisplayName)
		if len([]rune(display)) > 40 {
			fail(http.StatusBadRequest, "Name: höchstens 40 Zeichen")
			return
		}
		auth.mu.Lock()
		_, newExists := auth.users[req.Name]
		_, oldExists := auth.users[req.OldName]
		auth.mu.Unlock()
		rename := req.OldName != "" && req.OldName != req.Name
		exists := newExists
		if rename {
			if !oldExists {
				fail(http.StatusNotFound, "Benutzer nicht gefunden")
				return
			}
			if newExists {
				fail(http.StatusConflict, "Login existiert bereits")
				return
			}
			exists = true // carries the old user's password over
		} else if req.Create && newExists {
			fail(http.StatusConflict, "Login existiert bereits")
			return
		}
		if !exists && len(req.Password) < 6 {
			fail(http.StatusBadRequest, "Passwort: mindestens 6 Zeichen")
			return
		}
		if req.Password != "" && len(req.Password) < 6 {
			fail(http.StatusBadRequest, "Passwort: mindestens 6 Zeichen")
			return
		}
		var hash string
		if req.Password != "" {
			var err error
			if hash, err = hashPassword(req.Password); err != nil {
				http.Error(w, "hashing failed", http.StatusInternalServerError)
				return
			}
		}
		auth.mu.Lock()
		if rename {
			stored, ok := auth.users[req.OldName]
			if _, taken := auth.users[req.Name]; !ok || taken {
				auth.mu.Unlock()
				fail(http.StatusConflict, "Umbenennen nicht möglich")
				return
			}
			auth.users[req.Name] = stored
			delete(auth.users, req.OldName)
			delete(auth.names, req.OldName)
			delete(auth.admins, req.OldName)
			delete(auth.pas, req.OldName)
			delete(auth.noTX, req.OldName)
			for t, sess := range auth.sessions {
				if sess.user == req.OldName {
					delete(auth.sessions, t)
				}
			}
		}
		if hash != "" {
			auth.users[req.Name] = hash
			// sessions of this user end with the password change
			for t, s := range auth.sessions {
				if s.user == req.Name {
					delete(auth.sessions, t)
				}
			}
		}
		if display != "" {
			auth.names[req.Name] = display
		} else {
			delete(auth.names, req.Name)
		}
		if req.Admin {
			auth.admins[req.Name] = true
		} else {
			delete(auth.admins, req.Name)
		}
		if req.PA {
			auth.pas[req.Name] = true
		} else {
			delete(auth.pas, req.Name)
		}
		if req.TX == nil || *req.TX {
			delete(auth.noTX, req.Name) // may transmit (default, or explicitly so): no deny entry needed
		} else {
			auth.noTX[req.Name] = true
		}
		err := auth.saveLocked()
		auth.mu.Unlock()
		if err != nil {
			fail(http.StatusInternalServerError, "Speichern fehlgeschlagen: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case http.MethodDelete:
		name := r.URL.Query().Get("name")
		auth.mu.Lock()
		delete(auth.users, name)
		delete(auth.names, name)
		delete(auth.admins, name)
		delete(auth.pas, name)
		delete(auth.noTX, name)
		for t, s := range auth.sessions {
			if s.user == name {
				delete(auth.sessions, t)
			}
		}
		err := auth.saveLocked()
		auth.mu.Unlock()
		if err != nil {
			fail(http.StatusInternalServerError, "Speichern fehlgeschlagen: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
