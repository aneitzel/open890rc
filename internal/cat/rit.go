package cat

import (
	"fmt"
	"strconv"
	"strings"
)

// RIT/XIT (from the open890 Elixir reference, lib/open890/connection_commands.ex
// + lib/open890/extract.ex — the TS-890 PC Command Reference itself hasn't been
// checked for this one yet, unlike most other commands in this package):
//   RT0 / RT1   RIT off/on, query "RT" -> "RT0"/"RT1"
//   XT0 / XT1   XIT off/on, query "XT" -> "XT0"/"XT1" — independent on/off
//               switch from RIT, but shares the SAME offset value: there is
//               only one adjustable offset (RU/RD/RC/RF below), RIT routes
//               it to RX and XIT routes it to TX, either or both at once.
//   RU          RIT/XIT offset up by one step (bare command, no query form)
//   RD          RIT/XIT offset down by one step (bare command)
//   RC          RIT/XIT clear, resets the offset to 0 (bare command)
//   RF          RIT/XIT offset readback: "RF" + sign digit (0 = +, 1 = -) +
//               Hz digits, e.g. "RF00150" = +150 Hz. open890 never sets RIT
//               itself (its UI only does RU/RD/RC, see rit_xit.ex), so RU/RD
//               act on whichever of RIT/XIT the radio currently has selected
//               — there is no separate "set the exact offset" command, same
//               as a real encoder knob with no absolute position.
// Digit width of RF's Hz value isn't pinned down above (open890's own parser
// doesn't check it, just strips the sign and parses whatever's left) — not
// yet live-verified against the real radio.

// EncodeRIT builds "RT0"/"RT1".
func EncodeRIT(enabled bool) string {
	if enabled {
		return "RT1"
	}
	return "RT0"
}

// ParseRIT parses an "RT0"/"RT1" answer.
func ParseRIT(msg string) (bool, error) {
	if len(msg) != 3 || !strings.HasPrefix(msg, "RT") || (msg[2] != '0' && msg[2] != '1') {
		return false, fmt.Errorf("not a RIT message: %q", msg)
	}
	return msg[2] == '1', nil
}

// EncodeXIT builds "XT0"/"XT1".
func EncodeXIT(enabled bool) string {
	if enabled {
		return "XT1"
	}
	return "XT0"
}

// ParseXIT parses an "XT0"/"XT1" answer.
func ParseXIT(msg string) (bool, error) {
	if len(msg) != 3 || !strings.HasPrefix(msg, "XT") || (msg[2] != '0' && msg[2] != '1') {
		return false, fmt.Errorf("not a XIT message: %q", msg)
	}
	return msg[2] == '1', nil
}

// ParseRITOffset parses an "RF<sign><digits>" answer into a signed Hz offset.
func ParseRITOffset(msg string) (int, error) {
	if len(msg) < 4 || !strings.HasPrefix(msg, "RF") || (msg[2] != '0' && msg[2] != '1') {
		return 0, fmt.Errorf("not a RIT/XIT offset message: %q", msg)
	}
	hz, err := strconv.Atoi(msg[3:])
	if err != nil {
		return 0, fmt.Errorf("bad RIT/XIT offset %q: %w", msg, err)
	}
	if msg[2] == '1' {
		hz = -hz
	}
	return hz, nil
}
