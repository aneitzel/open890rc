package web

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func req(method, remote, body string, hdr map[string]string) *http.Request {
	r := httptest.NewRequest(method, "/x", strings.NewReader(body))
	r.RemoteAddr = remote
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	return r
}

func TestIsLAN(t *testing.T) {
	cases := []struct {
		remote string
		hdr    map[string]string
		want   bool
	}{
		{"192.168.1.174:5000", nil, true},
		{"10.1.2.3:5000", nil, true},
		{"127.0.0.1:5000", nil, true},
		{"[fe80::1]:5000", nil, true},
		{"[fd12:3456::1]:5000", nil, true},
		{"100.81.240.25:5000", nil, false},                                            // Tailscale IPv4 (CGNAT)
		{"[fd7a:115c:a1e0::1234]:5000", nil, false},                                   // Tailscale IPv6
		{"84.115.200.44:5000", nil, false},                                            // Internet
		{"127.0.0.1:5000", map[string]string{"X-Forwarded-For": "100.64.1.2"}, false}, // proxy in front, remote client
		{"127.0.0.1:5000", map[string]string{"X-Forwarded-For": "192.168.1.5"}, true},
		{"84.115.200.44:5000", map[string]string{"X-Forwarded-For": "192.168.1.5"}, false}, // forged header ignored
	}
	for _, c := range cases {
		if got := isLAN(req("GET", c.remote, "", c.hdr)); got != c.want {
			t.Errorf("isLAN(%s %v) = %v, want %v", c.remote, c.hdr, got, c.want)
		}
	}
}

func TestPasswordHash(t *testing.T) {
	h, err := hashPassword("geheim123")
	if err != nil {
		t.Fatal(err)
	}
	if !checkPassword(h, "geheim123") || checkPassword(h, "falsch") || checkPassword("müll", "x") {
		t.Fatal("password check wrong")
	}
}

func TestLoginFlow(t *testing.T) {
	SetUsersFile(filepath.Join(t.TempDir(), "users.json"))
	admin := map[string]string{"X-Requested-With": "open890rc"}

	// LAN admin creates a user
	w := httptest.NewRecorder()
	requireAdmin(handleUsers)(w, req("POST", "192.168.1.10:1", `{"name":"andre","password":"secret1"}`, admin))
	if w.Code != 200 {
		t.Fatalf("add user: %d %s", w.Code, w.Body)
	}
	// remote client cannot manage users
	w = httptest.NewRecorder()
	requireAdmin(handleUsers)(w, req("GET", "100.81.1.1:1", "", nil))
	if w.Code != http.StatusForbidden {
		t.Fatalf("remote admin call: %d", w.Code)
	}
	// LAN POST without the custom header is refused
	w = httptest.NewRecorder()
	requireAdmin(handleUsers)(w, req("POST", "192.168.1.10:1", `{"name":"x","password":"secret1"}`, nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing header: %d", w.Code)
	}

	protected := requireAuth(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	w = httptest.NewRecorder()
	protected(w, req("GET", "100.81.1.1:1", "", nil))
	if w.Code != 401 {
		t.Fatalf("remote without login: %d", w.Code)
	}
	w = httptest.NewRecorder()
	protected(w, req("GET", "192.168.1.10:1", "", nil))
	if w.Code != 200 {
		t.Fatalf("lan without login: %d", w.Code)
	}

	// remote login with wrong, then right password
	w = httptest.NewRecorder()
	handleLogin(w, req("POST", "100.81.1.1:1", `{"user":"andre","pass":"nope"}`, nil))
	if w.Code != 401 {
		t.Fatalf("wrong password: %d", w.Code)
	}
	w = httptest.NewRecorder()
	handleLogin(w, req("POST", "100.81.1.1:1", `{"user":"andre","pass":"secret1"}`, nil))
	if w.Code != 200 || len(w.Result().Cookies()) == 0 {
		t.Fatalf("login: %d", w.Code)
	}
	cookie := w.Result().Cookies()[0]
	r := req("GET", "100.81.1.1:1", "", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	protected(w, r)
	if w.Code != 200 {
		t.Fatalf("remote with session: %d", w.Code)
	}

	// lockout after 5 wrong tries from one address
	for i := 0; i < maxLoginFailures; i++ {
		w = httptest.NewRecorder()
		handleLogin(w, req("POST", "84.1.1.1:1", `{"user":"andre","pass":"bad"}`, nil))
	}
	w = httptest.NewRecorder()
	handleLogin(w, req("POST", "84.1.1.1:1", `{"user":"andre","pass":"secret1"}`, nil))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("lockout: %d", w.Code)
	}
}

func TestAdminFlag(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users.json")
	SetUsersFile(path)
	hdr := map[string]string{"X-Requested-With": "open890rc"}
	for _, body := range []string{
		`{"name":"boss","password":"secret1","admin":true}`,
		`{"name":"guest","password":"secret2"}`,
	} {
		w := httptest.NewRecorder()
		requireAdmin(handleUsers)(w, req("POST", "192.168.1.10:1", body, hdr))
		if w.Code != 200 {
			t.Fatalf("add user: %d %s", w.Code, w.Body)
		}
	}
	login := func(user, pass string) *http.Cookie {
		w := httptest.NewRecorder()
		handleLogin(w, req("POST", "100.81.1.1:1", `{"user":"`+user+`","pass":"`+pass+`"}`, nil))
		if w.Code != 200 || len(w.Result().Cookies()) == 0 {
			t.Fatalf("login %s: %d", user, w.Code)
		}
		return w.Result().Cookies()[0]
	}
	call := func(c *http.Cookie, method string) int {
		r := req(method, "100.81.1.1:1", "", hdr)
		r.AddCookie(c)
		w := httptest.NewRecorder()
		requireAdmin(handleUsers)(w, r)
		return w.Code
	}
	if code := call(login("boss", "secret1"), "GET"); code != 200 {
		t.Fatalf("remote admin: %d", code)
	}
	if code := call(login("guest", "secret2"), "GET"); code != http.StatusForbidden {
		t.Fatalf("remote normal user: %d", code)
	}
	// the flag survives a reload of the users file
	SetUsersFile(path)
	if !auth.admins["boss"] || auth.admins["guest"] {
		t.Fatalf("admin flags after reload: %v", auth.admins)
	}
}

func TestRenameUser(t *testing.T) {
	SetUsersFile(filepath.Join(t.TempDir(), "users.json"))
	hdr := map[string]string{"X-Requested-With": "open890rc"}
	post := func(body string) int {
		w := httptest.NewRecorder()
		requireAdmin(handleUsers)(w, req("POST", "192.168.1.10:1", body, hdr))
		return w.Code
	}
	if c := post(`{"name":"old","displayName":"Alt","password":"secret1","admin":true,"create":true}`); c != 200 {
		t.Fatalf("create: %d", c)
	}
	if c := post(`{"name":"old","password":"secret1","create":true}`); c != http.StatusConflict {
		t.Fatalf("create existing: %d", c)
	}
	if c := post(`{"name":"neu","oldName":"old","displayName":"Neu","admin":true}`); c != 200 {
		t.Fatalf("rename: %d", c)
	}
	if _, ok := auth.users["old"]; ok {
		t.Fatal("old login still there")
	}
	if auth.names["neu"] != "Neu" || !auth.admins["neu"] || auth.admins["old"] {
		t.Fatalf("rename lost data: %v %v", auth.names, auth.admins)
	}
	// the password moved along
	w := httptest.NewRecorder()
	handleLogin(w, req("POST", "100.81.1.1:1", `{"user":"neu","pass":"secret1"}`, nil))
	if w.Code != 200 {
		t.Fatalf("login with renamed user: %d", w.Code)
	}
	if c := post(`{"name":"neu","oldName":"missing"}`); c != http.StatusNotFound {
		t.Fatalf("rename of unknown user: %d", c)
	}
	post(`{"name":"other","password":"secret2","create":true}`)
	if c := post(`{"name":"other","oldName":"neu"}`); c != http.StatusConflict {
		t.Fatalf("rename onto existing: %d", c)
	}
}

func TestPAFlag(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users.json")
	SetUsersFile(path)
	hdr := map[string]string{"X-Requested-With": "open890rc"}
	for _, body := range []string{
		`{"name":"pauser","password":"secret1","pa":true,"create":true}`,
		`{"name":"plain","password":"secret2","create":true}`,
		`{"name":"boss","password":"secret3","admin":true,"create":true}`,
	} {
		w := httptest.NewRecorder()
		requireAdmin(handleUsers)(w, req("POST", "192.168.1.10:1", body, hdr))
		if w.Code != 200 {
			t.Fatalf("add user: %d %s", w.Code, w.Body)
		}
	}
	remote := func(user, pass string) bool {
		w := httptest.NewRecorder()
		handleLogin(w, req("POST", "100.81.1.1:1", `{"user":"`+user+`","pass":"`+pass+`"}`, nil))
		if w.Code != 200 || len(w.Result().Cookies()) == 0 {
			t.Fatalf("login %s: %d", user, w.Code)
		}
		r := req("GET", "100.81.1.1:1", "", nil)
		r.AddCookie(w.Result().Cookies()[0])
		return hasPA(r)
	}
	if !remote("pauser", "secret1") || remote("plain", "secret2") || !remote("boss", "secret3") {
		t.Fatal("PA access: want pauser yes, plain no, admin yes")
	}
	if !hasPA(req("GET", "192.168.1.10:1", "", nil)) || hasPA(req("GET", "100.81.1.1:1", "", nil)) {
		t.Fatal("PA access: LAN yes, anonymous remote no")
	}
	SetUsersFile(path) // survives a reload
	if !auth.pas["pauser"] || auth.pas["plain"] {
		t.Fatalf("pa flags after reload: %v", auth.pas)
	}
}
