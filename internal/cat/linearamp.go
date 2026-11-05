package cat

import (
	"fmt"
	"strings"
)

// Linear amplifier ON/OFF menu item (Kenwood PC Command Reference,
// confirmed by a user-supplied screenshot, 2026-11-05):
//   LA1<n>;   set/answer, n: 0 = Linear Amplifier OFF, 1 = ON, 9 = reset to
//             initial value (set-only, not used here)
//   LA1;      query

// EncodeLinearAmpQuery builds the "LA1" query command.
func EncodeLinearAmpQuery() string { return "LA1" }

// EncodeLinearAmp builds the "LA1<n>" set command: 0 = OFF, 1 = ON.
func EncodeLinearAmp(on bool) string {
	if on {
		return "LA11"
	}
	return "LA10"
}

// ParseLinearAmp parses an "LA1<n>" answer.
func ParseLinearAmp(msg string) (bool, error) {
	if len(msg) != 4 || !strings.HasPrefix(msg, "LA1") || (msg[3] != '0' && msg[3] != '1') {
		return false, fmt.Errorf("not a linear amplifier message: %q", msg)
	}
	return msg[3] == '1', nil
}
