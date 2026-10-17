package web

import (
	"net/http"
	"testing"
)

func TestClientIP(t *testing.T) {
	mk := func(remote string, hdr map[string]string) *http.Request {
		r, _ := http.NewRequest("GET", "/ws", nil)
		r.RemoteAddr = remote
		for k, v := range hdr {
			r.Header.Set(k, v)
		}
		return r
	}
	cases := []struct {
		name string
		r    *http.Request
		want string
	}{
		{"direct", mk("100.81.240.25:56005", nil), "100.81.240.25"},
		{"direct forged header ignored", mk("100.81.240.25:56005", map[string]string{"X-Forwarded-For": "1.2.3.4"}), "100.81.240.25"},
		{"proxy xff", mk("127.0.0.1:59244", map[string]string{"X-Forwarded-For": "100.64.1.2, 10.0.0.1"}), "100.64.1.2"},
		{"proxy real-ip", mk("[::1]:5000", map[string]string{"X-Real-IP": "100.64.9.9"}), "100.64.9.9"},
		{"local no header", mk("127.0.0.1:59244", nil), "127.0.0.1"},
	}
	for _, c := range cases {
		if got := clientIP(c.r); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}
