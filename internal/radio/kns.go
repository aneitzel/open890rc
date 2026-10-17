// Package radio implements the KNS (Kenwood Network System) LAN protocol
// used by the TS-890S: a TCP control channel carrying semicolon-terminated
// ASCII commands, plus login/keepalive handling.
package radio

import (
	"fmt"
	"strings"
)

// Credentials holds the KNS login for the radio's Network Control user.
type Credentials struct {
	Username string
	Password string
	IsAdmin  bool
}

// loginString builds the payload for "##ID", matching the radio's expected
// format: <adminCode><userLen 2 digits><passLen 2 digits><username><password>.
// adminCode is "0" for admin, "1" for standard user (per KNS.User in open890).
func (c Credentials) loginString() string {
	admin := "1"
	if c.IsAdmin {
		admin = "0"
	}
	return fmt.Sprintf("%s%02d%02d%s%s", admin, len(c.Username), len(c.Password), c.Username, c.Password)
}

// splitMessages splits a raw KNS byte stream on ";" and returns the complete
// messages plus whatever incomplete tail should be buffered for the next read.
func splitMessages(buffered string) (complete []string, rest string) {
	parts := strings.Split(buffered, ";")
	rest = parts[len(parts)-1]
	for _, p := range parts[:len(parts)-1] {
		if p != "" {
			complete = append(complete, p)
		}
	}
	return complete, rest
}
