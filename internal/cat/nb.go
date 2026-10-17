package cat

import (
	"fmt"
	"strconv"
	"strings"
)

// Noise blanker settings (Kenwood PC Command Reference):
//   NL1 / NL2   NB1 / NB2 level, 3 digits: NB1 001-020, NB2 001-010 (999 = initial value, set only)
//   NBT         NB2 type, 0 = Type A, 1 = Type B
//   NBD         NB2 type B depth, 3 digits 001-020 (999 = initial value, set only)
//   NBW         NB2 type B width, 3 digits 001-020 (999 = initial value, set only)
// The on/off commands NB1/NB2 are in cat.go (EncodeNB/ParseNB).

// NBLevelMax is the highest level of the given blanker (1 or 2).
func NBLevelMax(which int) int {
	if which == 2 {
		return 10
	}
	return 20
}

// EncodeNBLevel builds "NL1<nnn>" / "NL2<nnn>".
func EncodeNBLevel(which, level int) (string, error) {
	if which != 1 && which != 2 {
		return "", fmt.Errorf("invalid noise blanker %d", which)
	}
	if level < 1 || level > NBLevelMax(which) {
		return "", fmt.Errorf("NB%d level %d out of range 1-%d", which, level, NBLevelMax(which))
	}
	return fmt.Sprintf("NL%d%03d", which, level), nil
}

// ParseNBLevel parses an "NL1<nnn>" / "NL2<nnn>" answer.
func ParseNBLevel(msg string) (which, level int, err error) {
	if len(msg) != 6 || (!strings.HasPrefix(msg, "NL1") && !strings.HasPrefix(msg, "NL2")) {
		return 0, 0, fmt.Errorf("not a noise blanker level message: %q", msg)
	}
	level, err = strconv.Atoi(msg[3:])
	if err != nil {
		return 0, 0, fmt.Errorf("bad noise blanker level %q: %w", msg, err)
	}
	return int(msg[2] - '0'), level, nil
}

// EncodeNBType builds "NBT0" (Type A) / "NBT1" (Type B) for noise blanker 2.
func EncodeNBType(typeB bool) string {
	if typeB {
		return "NBT1"
	}
	return "NBT0"
}

// ParseNBType parses an "NBT<n>" answer: true = Type B.
func ParseNBType(msg string) (bool, error) {
	if len(msg) != 4 || !strings.HasPrefix(msg, "NBT") || (msg[3] != '0' && msg[3] != '1') {
		return false, fmt.Errorf("not a noise blanker type message: %q", msg)
	}
	return msg[3] == '1', nil
}

// NBDepthMax / NBWidthMax: range 1-20 for both of noise blanker 2's type B settings.
const NBDepthMax = 20

// EncodeNBDepth builds "NBD<nnn>".
func EncodeNBDepth(v int) (string, error) { return encodeNB3("NBD", "depth", v) }

// ParseNBDepth parses an "NBD<nnn>" answer.
func ParseNBDepth(msg string) (int, error) { return parseNB3(msg, "NBD") }

// EncodeNBWidth builds "NBW<nnn>".
func EncodeNBWidth(v int) (string, error) { return encodeNB3("NBW", "width", v) }

// ParseNBWidth parses an "NBW<nnn>" answer.
func ParseNBWidth(msg string) (int, error) { return parseNB3(msg, "NBW") }

func encodeNB3(prefix, name string, v int) (string, error) {
	if v < 1 || v > NBDepthMax {
		return "", fmt.Errorf("NB2 %s %d out of range 1-%d", name, v, NBDepthMax)
	}
	return fmt.Sprintf("%s%03d", prefix, v), nil
}

func parseNB3(msg, prefix string) (int, error) {
	if len(msg) != 6 || !strings.HasPrefix(msg, prefix) {
		return 0, fmt.Errorf("not a %s message: %q", prefix, msg)
	}
	v, err := strconv.Atoi(msg[3:])
	if err != nil {
		return 0, fmt.Errorf("bad %s value %q: %w", prefix, msg, err)
	}
	return v, nil
}
