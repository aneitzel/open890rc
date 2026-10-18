package cat

import (
	"encoding/hex"
	"fmt"
)

// Band scope (panadapter/waterfall) protocol, reverse-engineered from
// open890's lib/open890/tcp_client.ex and lib/open890/extract.ex — no
// official documentation for this, same as the rest of this file's
// undocumented-command territory.
//
// Enabling the stream: "DD01"/"DD02"/"DD03" (source comments in open890
// label these high-cycle/medium-cycle/low-cycle respectively — i.e. how
// often the radio pushes a new scope line, not a data-quality setting).
// Sent once to start; open890 has no observed "stop" command, so once
// enabled the radio just keeps sending until the connection closes.
//
// Data arrives on the SAME TCP connection as every other CAT message,
// framed like any other semicolon-terminated message but prefixed "##DD2"
// followed by 640 bytes of scope data, ASCII hex-encoded (2 chars/byte, so
// 1280 hex characters after the prefix). Each byte is a relative signal
// level, 0-255, with open890 treating anything below 7 as effective noise
// floor/black and 140 as its practical full-scale ceiling — there is no
// documented conversion to an absolute dBm figure.
//
// Span/mode aren't in the data payload at all; they're independent state
// via "BS3" (scope mode: 0=center/1=fixed/2=auto-scroll) and "BS4" (span,
// see bandScopeSpans below). BS3 is forced to center while a browser client
// is around (2026-10-18, see applyBandScopeCenter in cmd/open890rc/main.go)
// — the waterfall's VFO line and click-to-tune both assume center mode, see
// waterfall.js's own comment — and put back to whatever the radio had once
// the last client leaves. Everything else in the BS* family (ref level,
// attenuation, averaging) stays at whatever the radio's own front panel
// already has configured, same policy as other settings we don't yet expose.

// BandScopeLineBytes is the number of signal-level bytes per scope line.
const BandScopeLineBytes = 640

// bandScopeRates maps our own friendly names to the radio's DD0x enable
// commands. Order here has no significance — it's just a lookup table.
var bandScopeRates = map[string]string{
	"high":   "DD01",
	"medium": "DD02",
	"low":    "DD03",
}

// EncodeBandScopeRate builds the command to (re)start the band scope stream
// at the given rate ("high", "medium", or "low").
func EncodeBandScopeRate(rate string) (string, error) {
	cmd, ok := bandScopeRates[rate]
	if !ok {
		return "", fmt.Errorf("unknown band scope rate %q", rate)
	}
	return cmd, nil
}

// bandScopeSpans is BS4's index-to-Hz lookup, per open890's
// Extract.band_scope_span/1.
var bandScopeSpans = []int{5_000, 10_000, 20_000, 30_000, 50_000, 100_000, 200_000, 500_000}

// EncodeBandScopeSpan builds the "BS4" command selecting the closest
// available span to targetHz.
func EncodeBandScopeSpan(targetHz int) string {
	return fmt.Sprintf("BS4%d", nearestPassbandIndex(bandScopeSpans, targetHz))
}

// ParseBandScopeSpan parses a "BS4<digit>" message into the span in Hz.
func ParseBandScopeSpan(msg string) (int, error) {
	if len(msg) != 4 || msg[:3] != "BS4" {
		return 0, fmt.Errorf("not a BS4 message: %q", msg)
	}
	idx := int(msg[3] - '0')
	if idx < 0 || idx >= len(bandScopeSpans) {
		return 0, fmt.Errorf("BS4 index out of range: %q", msg)
	}
	return bandScopeSpans[idx], nil
}

// EncodeBandScopeMode builds the "BS3" command selecting the scope mode:
// 0=center, 1=fixed, 2=auto-scroll.
func EncodeBandScopeMode(mode int) string {
	return fmt.Sprintf("BS3%d", mode)
}

// ParseBandScopeMode parses a "BS3<digit>" message into the mode (0=center,
// 1=fixed, 2=auto-scroll).
func ParseBandScopeMode(msg string) (int, error) {
	if len(msg) != 4 || msg[:3] != "BS3" {
		return 0, fmt.Errorf("not a BS3 message: %q", msg)
	}
	mode := int(msg[3] - '0')
	if mode < 0 || mode > 2 {
		return 0, fmt.Errorf("BS3 mode out of range: %q", msg)
	}
	return mode, nil
}

// ParseBandScopeLine decodes a "##DD2<hex>" message into raw signal-level
// bytes. ok is false if msg isn't a band scope data message at all (the
// caller should fall back to normal state-message handling in that case),
// or true with whatever bytes were decoded — the caller decides whether an
// unexpected length (short/truncated read, or a future radio firmware
// change) is worth ignoring vs using as-is.
func ParseBandScopeLine(msg string) (line []byte, ok bool) {
	const prefix = "##DD2"
	if len(msg) < len(prefix) || msg[:len(prefix)] != prefix {
		return nil, false
	}
	out, err := hex.DecodeString(msg[len(prefix):])
	if err != nil {
		return nil, false
	}
	return out, true
}
