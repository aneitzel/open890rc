package cat

import (
	"fmt"
	"strconv"
	"strings"
)

// Voice message memory ("TX Messages" in our UI): six recordable channels
// played back for calling CQ etc. in a contest. From the official TS-890 PC
// Command Reference (screenshots from the operator, 2026-10-27) — not in
// open890 at all, nothing there to cross-check against.
//
// PB0 gates everything else: the reference notes P1-PB6 all refuse ("?")
// while the Voice Message List display is off. We switch it on the moment a
// browser opens the TX Messages overlay and back off when it closes — same
// "only while someone's looking" policy as the ALC/ID meter (wantMeter in
// main.go), and with the same known limitation: one shared on/off for every
// client, not tracked per client (see that file's own TODO on this).

// EncodePBListDisplay builds the "PB0<P1>" set command (P1: 0 off, 1 on).
func EncodePBListDisplay(on bool) string {
	if on {
		return "PB01"
	}
	return "PB00"
}

// ParsePBListDisplay parses a "PB0<P1>" answer/readback.
func ParsePBListDisplay(msg string) (bool, error) {
	if !strings.HasPrefix(msg, "PB0") || len(msg) != 4 {
		return false, fmt.Errorf("not a PB0 message: %q", msg)
	}
	switch msg[3] {
	case '0':
		return false, nil
	case '1':
		return true, nil
	}
	return false, fmt.Errorf("invalid PB0 value in %q", msg)
}

// Voice message playback operations (PB1 P2), straight from the reference.
const (
	VoiceMsgOpStop        = 0
	VoiceMsgOpPlay        = 1 // listen locally, does not transmit
	VoiceMsgOpPause       = 2
	VoiceMsgOpFastForward = 3
	VoiceMsgOpRewind      = 4
	VoiceMsgOpSend        = 5 // "Begin Transmission Playback" - actually keys the transmitter
	VoiceMsgOpRepeatWait  = 6 // response only, never sent by us
)

// EncodePBPlayback builds the "PB1<channel 1-6><op>" set command.
func EncodePBPlayback(channel, op int) (string, error) {
	if channel < 1 || channel > 6 {
		return "", fmt.Errorf("voice message channel %d out of range 1-6", channel)
	}
	if op < VoiceMsgOpStop || op > VoiceMsgOpSend {
		return "", fmt.Errorf("voice message operation %d out of range 0-5", op)
	}
	return fmt.Sprintf("PB1%d%d", channel, op), nil
}

// ParsePBPlayback parses a "PB1<channel><op><elapsed 000-100>" answer.
func ParsePBPlayback(msg string) (channel, op, elapsedSec int, err error) {
	if !strings.HasPrefix(msg, "PB1") || len(msg) != 8 {
		return 0, 0, 0, fmt.Errorf("not a PB1 status message: %q", msg)
	}
	channel, err = strconv.Atoi(msg[3:4])
	if err != nil {
		return 0, 0, 0, fmt.Errorf("parsing PB1 channel in %q: %w", msg, err)
	}
	op, err = strconv.Atoi(msg[4:5])
	if err != nil {
		return 0, 0, 0, fmt.Errorf("parsing PB1 op in %q: %w", msg, err)
	}
	elapsedSec, err = strconv.Atoi(msg[5:8])
	if err != nil {
		return 0, 0, 0, fmt.Errorf("parsing PB1 elapsed time in %q: %w", msg, err)
	}
	return channel, op, elapsedSec, nil
}

// EncodePBRegistrationQuery builds the "PB2<channel>" read command.
func EncodePBRegistrationQuery(channel int) (string, error) {
	if channel < 1 || channel > 6 {
		return "", fmt.Errorf("voice message channel %d out of range 1-6", channel)
	}
	return "PB2" + strconv.Itoa(channel), nil
}

// ParsePBRegistration parses a "PB2<channel><registered 0/1><seconds 000-100>"
// answer: whether a channel has a recording on it, and its length.
func ParsePBRegistration(msg string) (channel int, registered bool, seconds int, err error) {
	if !strings.HasPrefix(msg, "PB2") || len(msg) != 8 {
		return 0, false, 0, fmt.Errorf("not a PB2 status message: %q", msg)
	}
	channel, err = strconv.Atoi(msg[3:4])
	if err != nil {
		return 0, false, 0, fmt.Errorf("parsing PB2 channel in %q: %w", msg, err)
	}
	switch msg[4] {
	case '0':
		registered = false
	case '1':
		registered = true
	default:
		return 0, false, 0, fmt.Errorf("invalid PB2 registration digit in %q", msg)
	}
	seconds, err = strconv.Atoi(msg[5:8])
	if err != nil {
		return 0, false, 0, fmt.Errorf("parsing PB2 seconds in %q: %w", msg, err)
	}
	return channel, registered, seconds, nil
}

// EncodePBRepeat builds the "PB3<channel><0/1>" set command.
func EncodePBRepeat(channel int, on bool) (string, error) {
	if channel < 1 || channel > 6 {
		return "", fmt.Errorf("voice message channel %d out of range 1-6", channel)
	}
	v := "0"
	if on {
		v = "1"
	}
	return "PB3" + strconv.Itoa(channel) + v, nil
}

// EncodePBRepeatQuery builds the "PB3<channel>" read command.
func EncodePBRepeatQuery(channel int) (string, error) {
	if channel < 1 || channel > 6 {
		return "", fmt.Errorf("voice message channel %d out of range 1-6", channel)
	}
	return "PB3" + strconv.Itoa(channel), nil
}

// ParsePBRepeat parses a "PB3<channel><0/1>" answer/readback.
func ParsePBRepeat(msg string) (channel int, on bool, err error) {
	if !strings.HasPrefix(msg, "PB3") || len(msg) != 5 {
		return 0, false, fmt.Errorf("not a PB3 message: %q", msg)
	}
	channel, err = strconv.Atoi(msg[3:4])
	if err != nil {
		return 0, false, fmt.Errorf("parsing PB3 channel in %q: %w", msg, err)
	}
	switch msg[4] {
	case '0':
		return channel, false, nil
	case '1':
		return channel, true, nil
	}
	return 0, false, fmt.Errorf("invalid PB3 value in %q", msg)
}

// EncodePBNameQuery builds the "PB4<channel>" read command.
func EncodePBNameQuery(channel int) (string, error) {
	if channel < 1 || channel > 6 {
		return "", fmt.Errorf("voice message channel %d out of range 1-6", channel)
	}
	return "PB4" + strconv.Itoa(channel), nil
}

// ParsePBName parses a "PB4<channel><space><name up to 30 chars>" answer —
// the same shape whether it's a plain read or the echo of EncodePBName's set.
func ParsePBName(msg string) (channel int, name string, err error) {
	if !strings.HasPrefix(msg, "PB4") || len(msg) < 4 {
		return 0, "", fmt.Errorf("not a PB4 message: %q", msg)
	}
	channel, err = strconv.Atoi(msg[3:4])
	if err != nil {
		return 0, "", fmt.Errorf("parsing PB4 channel in %q: %w", msg, err)
	}
	if len(msg) <= 5 {
		return channel, "", nil
	}
	// msg[4] is documented as always a space; the name is whatever follows.
	name = strings.TrimRight(msg[5:], " ")
	return channel, name, nil
}

// EncodePBName builds the "PB4<channel><space><name>" set command. The
// reference caps names at 30 characters and refuses to rename an
// unregistered channel (same as PB2/PB3 above) — not re-checked here, the
// radio is the authority and answers "?" if we get either wrong.
func EncodePBName(channel int, name string) (string, error) {
	if channel < 1 || channel > 6 {
		return "", fmt.Errorf("voice message channel %d out of range 1-6", channel)
	}
	if len(name) > 30 {
		return "", fmt.Errorf("voice message name %q longer than the radio's 30-character limit", name)
	}
	return "PB4" + strconv.Itoa(channel) + " " + name, nil
}

// Voice message recording sound source (PB5 P1).
const (
	VoiceMsgSourceMic  = 0
	VoiceMsgSourceACC2 = 1
	VoiceMsgSourceUSB  = 2
	VoiceMsgSourceLAN  = 3
)

// EncodePBRecordingSource builds the "PB5<P1>" set command. No corresponding
// Parse function: a dropdown to choose this used to exist (Nutzer-Wunsch
// 2026-10-27, since reverted — "macht keinen Sinn, wenn man mit dem Tool
// aufnimmt kommt der Ton immer von LAN") — the REC button now just sends
// this (always VoiceMsgSourceLAN) right before starting a recording,
// fire-and-forget, nothing reads the echoed confirmation back.
func EncodePBRecordingSource(source int) (string, error) {
	if source < VoiceMsgSourceMic || source > VoiceMsgSourceLAN {
		return "", fmt.Errorf("voice message recording source %d out of range 0-3", source)
	}
	return "PB5" + strconv.Itoa(source), nil
}

// ParsePBRecordingRemaining parses a "PB6<remaining 000-100>" answer
// (seconds of recording time left across all channels combined) — read-only,
// no set form exists.
func ParsePBRecordingRemaining(msg string) (int, error) {
	if !strings.HasPrefix(msg, "PB6") || len(msg) != 6 {
		return 0, fmt.Errorf("not a PB6 message: %q", msg)
	}
	v, err := strconv.Atoi(msg[3:6])
	if err != nil {
		return 0, fmt.Errorf("parsing PB6 remaining time in %q: %w", msg, err)
	}
	return v, nil
}

// RE ("Recording Function") actually starts/stops a recording — a SEPARATE
// command family from PB0-PB6 above, not "PB"-prefixed, and its own
// reference text names no restriction tied to PB0 (unlike PB1-PB6, which
// explicitly refuse while the Voice Message List display is off). It has NO
// channel parameter at all, which the reference doesn't explain by itself —
// resolved by the manual's own step-by-step recording procedure (Nutzer-
// Screenshot, 2026-10-28, "Aufzeichnen einer Sprachnachricht"): recording a
// voice message is TWO separate physical button holds — first HOLD the
// target channel's own F-key (F2-F7), which arms that channel, THEN
// separately HOLD an on-screen F4 [REC] key (a context-only soft key shown
// inside the Voice Message screen, NOT the physical REC button on the front
// panel — Nutzer-Klarstellung 2026-10-28: "TX Messages werden nicht über die
// REC Taste vorne an der Front aufgenommen") to actually capture; releasing
// it stops and saves. RE maps to that second hold (channel-less because the
// channel was already selected by the first hold, done here via LM, see
// below) — SetVoiceMsgRecording (main.go) sends both together. Not
// live-verified against the real radio yet.
const (
	VoiceMsgRecOpStop            = 0
	VoiceMsgRecOpRecord          = 1 // begin manual recording / recording in progress
	VoiceMsgRecOpFullTimeStorage = 2 // setting only, per the reference
	VoiceMsgRecOpQuickPlayback   = 3 // begin quick playback / playback in progress
	VoiceMsgRecOpPauseRecord     = 4 // pause manual recording / resume recording
	VoiceMsgRecOpPauseQuickPlay  = 5 // pause quick playback / resume playback
	VoiceMsgRecOpRecordFailed    = 6 // response only
	VoiceMsgRecOpPlaybackFailed  = 7 // response only
)

// EncodeVoiceMsgRecording builds the "RE<P1>" set command. Only operations
// actually meant to be sent (0/1/4 — stop/record/pause — the reference's own
// "setting only" and "response only" notes rule the rest out for us).
func EncodeVoiceMsgRecording(op int) (string, error) {
	switch op {
	case VoiceMsgRecOpStop, VoiceMsgRecOpRecord, VoiceMsgRecOpPauseRecord:
		return "RE" + strconv.Itoa(op), nil
	}
	return "", fmt.Errorf("voice message recording operation %d not settable", op)
}

// ParseVoiceMsgRecording parses an "RE<P1><progress 000-100>" answer/readback.
func ParseVoiceMsgRecording(msg string) (op, progress int, err error) {
	if !strings.HasPrefix(msg, "RE") || len(msg) != 6 {
		return 0, 0, fmt.Errorf("not an RE status message: %q", msg)
	}
	op, err = strconv.Atoi(msg[2:3])
	if err != nil {
		return 0, 0, fmt.Errorf("parsing RE op in %q: %w", msg, err)
	}
	progress, err = strconv.Atoi(msg[3:6])
	if err != nil {
		return 0, 0, fmt.Errorf("parsing RE progress in %q: %w", msg, err)
	}
	return op, progress, nil
}

// LM ("Voice Message Recording") is a SEPARATE command family from RE above,
// and — unlike RE — DOES carry a channel parameter (Nutzer-Screenshot,
// 2026-10-27). Used for Delete (P2=3) and, since 2026-10-28, for the first
// of the manual's two recording holds (see RE's own comment above): LM
// <channel>2 arms a specific channel for recording (the CAT equivalent of
// holding that channel's F-key) and LM<channel>0 releases it again —
// SetVoiceMsgRecording (main.go) sends this, then a short pause, then RE1
// (the second hold) to start, and RE0 then this in reverse to stop.
const (
	VoiceMsgLMOpStop      = 0 // recording ends or stops
	VoiceMsgLMOpReady     = 1 // recording is ready (response only)
	VoiceMsgLMOpRecording = 2 // recording starts or while recording
	VoiceMsgLMOpDelete    = 3 // delete
)

// EncodeVoiceMsgChannelOp builds the "LM<channel 1-6><op 0-3>" set command.
func EncodeVoiceMsgChannelOp(channel, op int) (string, error) {
	if channel < 1 || channel > 6 {
		return "", fmt.Errorf("voice message channel %d out of range 1-6", channel)
	}
	if op < VoiceMsgLMOpStop || op > VoiceMsgLMOpDelete {
		return "", fmt.Errorf("voice message LM operation %d out of range 0-3", op)
	}
	return fmt.Sprintf("LM%d%d", channel, op), nil
}

// EncodeVoiceMsgDelete is EncodeVoiceMsgChannelOp(channel, VoiceMsgLMOpDelete).
func EncodeVoiceMsgDelete(channel int) (string, error) {
	return EncodeVoiceMsgChannelOp(channel, VoiceMsgLMOpDelete)
}

// EncodeVoiceMsgRecordStart/Stop are EncodeVoiceMsgChannelOp(channel,
// VoiceMsgLMOpRecording/Stop) — arms/releases a specific channel for
// recording, the first of the manual's two holds (see RE's own comment
// above for the full two-step procedure). VoiceMsgLMOpReady (1) is never
// sent, only ever a response.
func EncodeVoiceMsgRecordStart(channel int) (string, error) {
	return EncodeVoiceMsgChannelOp(channel, VoiceMsgLMOpRecording)
}
func EncodeVoiceMsgRecordStop(channel int) (string, error) {
	return EncodeVoiceMsgChannelOp(channel, VoiceMsgLMOpStop)
}

// ParseVoiceMsgChannelOp parses an "LM<channel><op><elapsed 000-100>" answer.
func ParseVoiceMsgChannelOp(msg string) (channel, op, elapsedSec int, err error) {
	if !strings.HasPrefix(msg, "LM") || len(msg) != 7 {
		return 0, 0, 0, fmt.Errorf("not an LM status message: %q", msg)
	}
	channel, err = strconv.Atoi(msg[2:3])
	if err != nil {
		return 0, 0, 0, fmt.Errorf("parsing LM channel in %q: %w", msg, err)
	}
	op, err = strconv.Atoi(msg[3:4])
	if err != nil {
		return 0, 0, 0, fmt.Errorf("parsing LM op in %q: %w", msg, err)
	}
	elapsedSec, err = strconv.Atoi(msg[4:7])
	if err != nil {
		return 0, 0, 0, fmt.Errorf("parsing LM elapsed time in %q: %w", msg, err)
	}
	return channel, op, elapsedSec, nil
}
