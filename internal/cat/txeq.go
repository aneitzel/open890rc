package cat

import (
	"fmt"
	"strings"
)

// TX equalizer ("EQT0", Kenwood PC Command Reference): EQT0 query, EQT00 = OFF,
// EQT01 = ON, answer "EQT0<P1>". The setting applies to the SELECTED TRANSMIT
// MODE only, and the radio neither reads nor sets it while the mode is CW, FSK or
// PSK. ("EQT1" is the equalizer EFFECT, a different command.)

// EncodeTXEQ builds the "EQT00"/"EQT01" set command.
func EncodeTXEQ(on bool) string {
	if on {
		return "EQT01"
	}
	return "EQT00"
}

// ParseTXEQ parses an "EQT0<P1>" answer (not the "EQT1" effect command).
func ParseTXEQ(msg string) (bool, error) {
	if len(msg) != 5 || !strings.HasPrefix(msg, "EQT0") || (msg[4] != '0' && msg[4] != '1') {
		return false, fmt.Errorf("not a TX equalizer message: %q", msg)
	}
	return msg[4] == '1', nil
}

// TXEQApplies reports whether the TX equalizer exists in this mode (voice and
// data modes; not CW, FSK, PSK).
func TXEQApplies(mode string) bool {
	switch mode {
	case "LSB", "USB", "AM", "FM", "LSB-D", "USB-D", "AM-D", "FM-D":
		return true
	}
	return false
}

// RXEQApplies reports whether the RX equalizer exists in this mode. The
// Kenwood reference only says EQR0/EQR1 apply to "the selected receive mode",
// without listing an exclusion for CW/FSK/PSK the way it does for EQT0 — this
// reuses TXEQApplies' mode list as the best available assumption (same
// underlying voice/data-mode-only equalizer hardware), not independently
// confirmed against the radio.
func RXEQApplies(mode string) bool { return TXEQApplies(mode) }

// Effect commands: "EQT1" (TX) and "EQR1" (RX) select one of 9 effects, 0..8
// (High Boost 1/2, Formant Pass, Bass Boost 1/2, Conventional/Flat, User 1-3).
const maxEQEffect = 8

// EncodeTXEQEffect builds "EQT1<n>".
func EncodeTXEQEffect(n int) (string, error) {
	if n < 0 || n > maxEQEffect {
		return "", fmt.Errorf("TX equalizer effect %d out of range 0-%d", n, maxEQEffect)
	}
	return fmt.Sprintf("EQT1%d", n), nil
}

// ParseTXEQEffect parses an "EQT1<n>" answer.
func ParseTXEQEffect(msg string) (int, error) { return parseEQEffect(msg, "EQT1") }

// Reception equalizer ("EQR0" on/off, "EQR1" effect), valid for the selected
// receive mode.

// EncodeRXEQ builds "EQR00"/"EQR01".
func EncodeRXEQ(on bool) string {
	if on {
		return "EQR01"
	}
	return "EQR00"
}

// ParseRXEQ parses an "EQR0<P1>" answer.
func ParseRXEQ(msg string) (bool, error) {
	if len(msg) != 5 || !strings.HasPrefix(msg, "EQR0") || (msg[4] != '0' && msg[4] != '1') {
		return false, fmt.Errorf("not an RX equalizer message: %q", msg)
	}
	return msg[4] == '1', nil
}

// EncodeRXEQEffect builds "EQR1<n>".
func EncodeRXEQEffect(n int) (string, error) {
	if n < 0 || n > maxEQEffect {
		return "", fmt.Errorf("RX equalizer effect %d out of range 0-%d", n, maxEQEffect)
	}
	return fmt.Sprintf("EQR1%d", n), nil
}

// ParseRXEQEffect parses an "EQR1<n>" answer.
func ParseRXEQEffect(msg string) (int, error) { return parseEQEffect(msg, "EQR1") }

func parseEQEffect(msg, prefix string) (int, error) {
	if len(msg) != 5 || !strings.HasPrefix(msg, prefix) || msg[4] < '0' || msg[4] > '0'+maxEQEffect {
		return 0, fmt.Errorf("not an equalizer effect message (%s): %q", prefix, msg)
	}
	return int(msg[4] - '0'), nil
}
