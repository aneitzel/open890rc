package cat

import (
	"fmt"
	"strconv"
	"strings"
)

// Manual notch filter (formats taken from open890, not yet checked against the PC Command Reference):
//   NT<n>       notch on/off, 0 = off, 1 = on
//   NW<n>       notch width, 0 = narrow, 1 = mid, 2 = wide
//   BP<nnn>     notch frequency, 3 digits 000-255 (position along the audio scope)

// NotchPosMax is the highest notch position value.
const NotchPosMax = 255

// EncodeNotch builds "NT0" / "NT1".
func EncodeNotch(on bool) string {
	if on {
		return "NT1"
	}
	return "NT0"
}

// ParseNotch parses an "NT<n>" answer.
func ParseNotch(msg string) (bool, error) {
	if len(msg) != 3 || !strings.HasPrefix(msg, "NT") || (msg[2] != '0' && msg[2] != '1') {
		return false, fmt.Errorf("not a notch message: %q", msg)
	}
	return msg[2] == '1', nil
}

// EncodeNotchWidth builds "NW0" (narrow), "NW1" (mid) or "NW2" (wide).
func EncodeNotchWidth(w int) (string, error) {
	if w < 0 || w > 2 {
		return "", fmt.Errorf("notch width %d out of range 0-2", w)
	}
	return fmt.Sprintf("NW%d", w), nil
}

// ParseNotchWidth parses an "NW<n>" answer.
func ParseNotchWidth(msg string) (int, error) {
	if len(msg) != 3 || !strings.HasPrefix(msg, "NW") || msg[2] < '0' || msg[2] > '2' {
		return 0, fmt.Errorf("not a notch width message: %q", msg)
	}
	return int(msg[2] - '0'), nil
}

// EncodeNotchPos builds "BP<nnn>".
func EncodeNotchPos(pos int) (string, error) {
	if pos < 0 || pos > NotchPosMax {
		return "", fmt.Errorf("notch position %d out of range 0-%d", pos, NotchPosMax)
	}
	return fmt.Sprintf("BP%03d", pos), nil
}

// ParseNotchPos parses a "BP<nnn>" answer.
func ParseNotchPos(msg string) (int, error) {
	if len(msg) < 3 || !strings.HasPrefix(msg, "BP") {
		return 0, fmt.Errorf("not a notch position message: %q", msg)
	}
	v, err := strconv.Atoi(msg[2:])
	if err != nil || v < 0 || v > NotchPosMax {
		return 0, fmt.Errorf("bad notch position %q", msg)
	}
	return v, nil
}
