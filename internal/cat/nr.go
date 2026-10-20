package cat

import (
	"fmt"
	"strconv"
	"strings"
)

// Noise reduction settings (Kenwood PC Command Reference):
//   RL1   NR1 level, 2 digits 01-10 (99 = initial value, set only)
//   RL2   NR2 time constant, 2 digits 00 (2 ms) - 09 (20 ms) (99 = initial value, set only)
// The on/off command NR is in cat.go (EncodeNR/ParseNR).

// NRSettingRange returns the allowed range of the given NR setting (1 = NR1
// level, 2 = NR2 time constant).
func NRSettingRange(which int) (min, max int) {
	if which == 2 {
		return 0, 9
	}
	return 1, 10
}

// EncodeNRSetting builds "RL1<nn>" / "RL2<nn>".
func EncodeNRSetting(which, v int) (string, error) {
	if which != 1 && which != 2 {
		return "", fmt.Errorf("invalid noise reduction %d", which)
	}
	lo, hi := NRSettingRange(which)
	if v < lo || v > hi {
		return "", fmt.Errorf("NR%d setting %d out of range %d-%d", which, v, lo, hi)
	}
	return fmt.Sprintf("RL%d%02d", which, v), nil
}

// ParseNRSetting parses an "RL1<nn>" / "RL2<nn>" answer.
func ParseNRSetting(msg string) (which, v int, err error) {
	if len(msg) != 5 || (!strings.HasPrefix(msg, "RL1") && !strings.HasPrefix(msg, "RL2")) {
		return 0, 0, fmt.Errorf("not a noise reduction setting message: %q", msg)
	}
	v, err = strconv.Atoi(msg[3:])
	if err != nil {
		return 0, 0, fmt.Errorf("bad noise reduction setting %q: %w", msg, err)
	}
	return int(msg[2] - '0'), v, nil
}
