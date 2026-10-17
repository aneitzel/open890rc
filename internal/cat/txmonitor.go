package cat

import (
	"fmt"
	"strconv"
	"strings"
)

// TX Monitor ("MO0" on/off, "ML" level, Kenwood PC Command Reference):
// MO0 query, MO00 = OFF, MO01 = ON, answer "MO0<P1>". ML query, ML<P1> sets/
// answers a 3-digit level, P1 000-020.

// EncodeTXMonitor builds the "MO00"/"MO01" set command.
func EncodeTXMonitor(on bool) string {
	if on {
		return "MO01"
	}
	return "MO00"
}

// ParseTXMonitor parses an "MO0<P1>" answer.
func ParseTXMonitor(msg string) (bool, error) {
	if len(msg) != 4 || !strings.HasPrefix(msg, "MO0") || (msg[3] != '0' && msg[3] != '1') {
		return false, fmt.Errorf("not a TX monitor message: %q", msg)
	}
	return msg[3] == '1', nil
}

const maxTXMonitorLevel = 20

// EncodeTXMonitorLevel builds the "ML<3-digit>" set command, P1 000-020.
func EncodeTXMonitorLevel(level int) (string, error) {
	if level < 0 || level > maxTXMonitorLevel {
		return "", fmt.Errorf("TX monitor level %d out of range 0-%d", level, maxTXMonitorLevel)
	}
	return fmt.Sprintf("ML%03d", level), nil
}

// ParseTXMonitorLevel parses an "ML<P1>" answer (3 digits).
func ParseTXMonitorLevel(msg string) (int, error) {
	if len(msg) != 5 || !strings.HasPrefix(msg, "ML") {
		return 0, fmt.Errorf("not a TX monitor level message: %q", msg)
	}
	v, err := strconv.Atoi(msg[2:])
	if err != nil {
		return 0, fmt.Errorf("not a TX monitor level message: %q", msg)
	}
	return v, nil
}
