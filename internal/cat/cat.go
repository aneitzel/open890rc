// Package cat parses and encodes the Kenwood CAT commands used by the
// TS-890S, translating between the radio's ASCII wire format and Go values.
package cat

import (
	"fmt"
	"strconv"
	"strings"
)

// VFO identifies which VFO a frequency/mode command refers to.
type VFO string

const (
	VFOA VFO = "A"
	VFOB VFO = "B"
)

// ParseFrequency parses an "FA"/"FB" message (e.g. "FA00014074000") into the
// VFO it addresses and the frequency in Hz.
func ParseFrequency(msg string) (VFO, int, error) {
	var vfo VFO
	var digits string

	switch {
	case strings.HasPrefix(msg, "FA"):
		vfo, digits = VFOA, msg[2:]
	case strings.HasPrefix(msg, "FB"):
		vfo, digits = VFOB, msg[2:]
	default:
		return "", 0, fmt.Errorf("not a frequency message: %q", msg)
	}

	hz, err := strconv.Atoi(digits)
	if err != nil {
		return "", 0, fmt.Errorf("parsing frequency digits %q: %w", digits, err)
	}
	return vfo, hz, nil
}

// EncodeFrequency builds an "FA"/"FB" command to set the given VFO to hz
// Hertz, using the radio's 11-digit zero-padded format (e.g. "FA00014074000").
func EncodeFrequency(vfo VFO, hz int) (string, error) {
	if hz < 0 || hz > 99_999_999_999 {
		return "", fmt.Errorf("frequency %d Hz out of range for an 11-digit field", hz)
	}

	prefix := "FA"
	if vfo == VFOB {
		prefix = "FB"
	}
	return fmt.Sprintf("%s%011d", prefix, hz), nil
}

// modeNames maps the TS-890's single-character operating mode code (as used
// in the "OM" command) to a display name.
var modeNames = map[byte]string{
	'1': "LSB",
	'2': "USB",
	'3': "CW",
	'4': "FM",
	'5': "AM",
	'6': "FSK",
	'7': "CW-R",
	'9': "FSK-R",
	'A': "PSK",
	'B': "PSK-R",
	'C': "LSB-D",
	'D': "USB-D",
	'E': "FM-D",
	'F': "AM-D",
}

// modeCodes is the reverse of modeNames, letting a mode be requested by its
// display name.
var modeCodes = func() map[string]byte {
	m := make(map[string]byte, len(modeNames))
	for code, name := range modeNames {
		m[name] = code
	}
	return m
}()

// EncodeMode builds an "OM0"/"OM1" command to set the given receiver's
// operating mode by display name (e.g. "USB", "CW-R").
func EncodeMode(receiver int, mode string) (string, error) {
	code, ok := modeCodes[mode]
	if !ok {
		return "", fmt.Errorf("unknown mode %q", mode)
	}

	prefix := "OM0"
	if receiver == 1 {
		prefix = "OM1"
	}
	return fmt.Sprintf("%s%c", prefix, code), nil
}

// ParseMode parses an "OM0"/"OM1" message (main/sub receiver operating mode)
// into the receiver index (0 or 1) and a display name for the mode.
func ParseMode(msg string) (receiver int, mode string, err error) {
	switch {
	case strings.HasPrefix(msg, "OM0"):
		receiver = 0
	case strings.HasPrefix(msg, "OM1"):
		receiver = 1
	default:
		return 0, "", fmt.Errorf("not a mode message: %q", msg)
	}

	code := strings.TrimSpace(msg[3:])
	if code == "" {
		return receiver, "", nil
	}

	name, ok := modeNames[code[0]]
	if !ok {
		return 0, "", fmt.Errorf("unknown mode code %q in %q", code, msg)
	}
	return receiver, name, nil
}

// bandNames are the TS-890's band register names ("BU" command), indexed by
// their register code (0-10).
var bandNames = []string{
	"1.8", "3.5", "7", "10", "14", "18", "21", "24", "28", "50", "GEN",
}

// EncodeBand builds a "BU0"/"BU1" command to switch the given VFO's band
// register to a band by name (e.g. "7", "GEN"). This recalls that band's
// last-used frequency and mode, the same as pressing the band button on the
// radio.
func EncodeBand(vfo VFO, band string) (string, error) {
	for i, name := range bandNames {
		if name != band {
			continue
		}
		prefix := "BU0"
		if vfo == VFOB {
			prefix = "BU1"
		}
		return fmt.Sprintf("%s%02d", prefix, i), nil
	}
	return "", fmt.Errorf("unknown band %q", band)
}

// bandRanges give each band's approximate edges in Hz, wide enough to cover
// both IARU regions, used only to label the current band for display.
var bandRanges = []struct {
	name          string
	lowHz, highHz int
}{
	{"1.8", 1_800_000, 2_000_000},
	{"3.5", 3_500_000, 4_000_000},
	{"7", 7_000_000, 7_300_000},
	{"10", 10_100_000, 10_150_000},
	{"14", 14_000_000, 14_350_000},
	{"18", 18_068_000, 18_168_000},
	{"21", 21_000_000, 21_450_000},
	{"24", 24_890_000, 24_990_000},
	{"28", 28_000_000, 29_700_000},
	{"50", 50_000_000, 54_000_000},
}

// BandForFrequency returns which band name's range contains hz, or "GEN" if
// it falls outside all of them (general coverage).
//
// This is used instead of parsing the radio's own "BU0"/"BU1" band-register
// reports: those turned out to not reliably reflect the band just selected
// (observed skewed by one register slot in either direction against real
// hardware), while deriving the band from the already-reliable frequency
// avoids that flakiness entirely.
func BandForFrequency(hz int) string {
	for _, b := range bandRanges {
		if hz >= b.lowHz && hz <= b.highHz {
			return b.name
		}
	}
	return "GEN"
}

// EncodeActiveReceiver builds the "FR0"/"FR1" command that makes VFO A / VFO B the
// active (receive) VFO. As in open890, only FR is sent: without split the radio
// transmits on the VFO it receives on.
func EncodeActiveReceiver(vfo VFO) (string, error) {
	switch vfo {
	case VFOA:
		return "FR0", nil
	case VFOB:
		return "FR1", nil
	}
	return "", fmt.Errorf("unknown VFO %q", vfo)
}

// ParseActiveReceiver parses an "FR0"/"FR1" message into the VFO that is now
// the active (main) receiver.
func ParseActiveReceiver(msg string) (VFO, error) {
	switch msg {
	case "FR0":
		return VFOA, nil
	case "FR1":
		return VFOB, nil
	default:
		return "", fmt.Errorf("not an active receiver message: %q", msg)
	}
}

// The S/ALC/SWR meters all report on the same raw 0-70ish needle-deflection
// scale the radio's own front-panel meter uses; parsing just strips the
// message's fixed prefix and reads the rest as an integer.
func parseMeter(msg, prefix string) (int, error) {
	if !strings.HasPrefix(msg, prefix) {
		return 0, fmt.Errorf("not a %q meter message: %q", prefix, msg)
	}
	val, err := strconv.Atoi(msg[len(prefix):])
	if err != nil {
		return 0, fmt.Errorf("parsing meter value in %q: %w", msg, err)
	}
	return val, nil
}

// ParseBusy parses a "BY"-prefixed message (the squelch/busy indicator) into
// whether the receiver currently has a signal above squelch. Only the
// message's last character matters, matching the radio's own encoding.
func ParseBusy(msg string) (bool, error) {
	if !strings.HasPrefix(msg, "BY") {
		return false, fmt.Errorf("not a busy message: %q", msg)
	}
	return msg[len(msg)-1] == '1', nil
}

// ParseTX parses a "TX0"/"TX1"/"TX2"/"RX" message into whether the radio is
// currently transmitting.
func ParseTX(msg string) (bool, error) {
	switch msg {
	case "TX0", "TX1", "TX2":
		return true, nil
	case "RX":
		return false, nil
	default:
		return false, fmt.Errorf("not a TX/RX message: %q", msg)
	}
}

// ParseSMeter parses an "SM"-prefixed message into the raw S-meter reading.
func ParseSMeter(msg string) (int, error) { return parseMeter(msg, "SM") }

// ParseSWRMeter parses an "RM2"-prefixed message into the raw SWR reading.
// The radio only streams these once SWR monitoring is enabled (command
// "RM21").
func ParseSWRMeter(msg string) (int, error) { return parseMeter(msg, "RM2") }

// ParseALCMeter parses an "RM1"-prefixed message into the raw ALC reading.
// The radio only streams these once ALC monitoring is enabled ("RM11").
func ParseALCMeter(msg string) (int, error) { return parseMeter(msg, "RM1") }

// ParseIDMeter parses an "RM4"-prefixed message into the raw drain-current
// reading (0-70). Streamed once "RM41" is sent.
func ParseIDMeter(msg string) (int, error) { return parseMeter(msg, "RM4") }

// ParseRFGain parses an "RG"-prefixed message into its 0-255 value.
func ParseRFGain(msg string) (int, error) { return parseMeter(msg, "RG") }

// ParseSquelch parses an "SQ"-prefixed message into its 0-255 value.
func ParseSquelch(msg string) (int, error) { return parseMeter(msg, "SQ") }

func encodeGain(prefix string, value int) (string, error) {
	if value < 0 || value > 255 {
		return "", fmt.Errorf("gain value %d out of range 0-255", value)
	}
	return fmt.Sprintf("%s%03d", prefix, value), nil
}

// EncodeRFGain builds an "RG" command to set the RF gain, 0-255.
func EncodeRFGain(value int) (string, error) { return encodeGain("RG", value) }

// EncodeSquelch builds an "SQ" command to set the squelch level, 0-255.
func EncodeSquelch(value int) (string, error) { return encodeGain("SQ", value) }

// AGC display values, matching the radio's "GC" command levels.
const (
	AGCOff  = "OFF"
	AGCSlow = "S"
	AGCMed  = "M"
	AGCFast = "F"
)

var agcCodes = map[string]byte{
	AGCOff:  '0',
	AGCSlow: '1',
	AGCMed:  '2',
	AGCFast: '3',
}

var agcNames = map[byte]string{
	'0': AGCOff,
	'1': AGCSlow,
	'2': AGCMed,
	'3': AGCFast,
}

// EncodeAGC builds a "GC" command for one of AGCOff/AGCSlow/AGCMed/AGCFast.
func EncodeAGC(value string) (string, error) {
	code, ok := agcCodes[value]
	if !ok {
		return "", fmt.Errorf("unknown AGC value %q", value)
	}
	return fmt.Sprintf("GC%c", code), nil
}

// ParseAGC parses a "GC0".."GC3" message into one of
// AGCOff/AGCSlow/AGCMed/AGCFast.
func ParseAGC(msg string) (string, error) {
	if !strings.HasPrefix(msg, "GC") || len(msg) < 3 {
		return "", fmt.Errorf("not an AGC message: %q", msg)
	}
	name, ok := agcNames[msg[2]]
	if !ok {
		return "", fmt.Errorf("unknown AGC code in %q", msg)
	}
	return name, nil
}

// EncodeNR builds an "NR" command: 0 (off), 1 (NR1), or 2 (NR2).
func EncodeNR(value int) (string, error) {
	if value < 0 || value > 2 {
		return "", fmt.Errorf("invalid NR value %d", value)
	}
	return fmt.Sprintf("NR%d", value), nil
}

// ParseNR parses an "NR" message into 0 (off), 1 (NR1), or 2 (NR2).
func ParseNR(msg string) (int, error) {
	if !strings.HasPrefix(msg, "NR") {
		return 0, fmt.Errorf("not an NR message: %q", msg)
	}
	return strconv.Atoi(msg[2:])
}

// EncodeATT builds an "RA" command: 0 (off), 1 (6dB), 2 (12dB), or 3 (18dB).
func EncodeATT(value int) (string, error) {
	if value < 0 || value > 3 {
		return "", fmt.Errorf("invalid ATT value %d", value)
	}
	return fmt.Sprintf("RA%d", value), nil
}

// ParseATT parses an "RA" message into 0 (off), 1 (6dB), 2 (12dB), or 3
// (18dB).
func ParseATT(msg string) (int, error) {
	if !strings.HasPrefix(msg, "RA") {
		return 0, fmt.Errorf("not an RA message: %q", msg)
	}
	return strconv.Atoi(msg[2:])
}

// EncodePRE builds a "PA" (preamp) command: 0 (off), 1, or 2.
func EncodePRE(value int) (string, error) {
	if value < 0 || value > 2 {
		return "", fmt.Errorf("invalid PRE value %d", value)
	}
	return fmt.Sprintf("PA%d", value), nil
}

// ParsePRE parses a "PA" message into 0 (off), 1, or 2.
func ParsePRE(msg string) (int, error) {
	if !strings.HasPrefix(msg, "PA") {
		return 0, fmt.Errorf("not a PA message: %q", msg)
	}
	return strconv.Atoi(msg[2:])
}

// EncodeNB builds an "NB1"/"NB2" command to enable/disable that noise
// blanker (the two are independent toggles, unlike NR).
func EncodeNB(which int, enabled bool) (string, error) {
	if which != 1 && which != 2 {
		return "", fmt.Errorf("invalid noise blanker %d", which)
	}
	val := "0"
	if enabled {
		val = "1"
	}
	return fmt.Sprintf("NB%d%s", which, val), nil
}

// ParseNB parses an "NB1"/"NB2" message into which blanker it addresses and
// whether it's enabled.
func ParseNB(msg string) (which int, enabled bool, err error) {
	switch {
	case strings.HasPrefix(msg, "NB1"):
		which = 1
	case strings.HasPrefix(msg, "NB2"):
		which = 2
	default:
		return 0, false, fmt.Errorf("not a noise blanker message: %q", msg)
	}

	rest := msg[3:]
	if rest == "" {
		return 0, false, fmt.Errorf("noise blanker message missing state: %q", msg)
	}
	return which, rest[0] == '1', nil
}

// EncodeMicGain builds an "MG" command to set the microphone gain, 0-100.
func EncodeMicGain(value int) (string, error) {
	if value < 0 || value > 100 {
		return "", fmt.Errorf("mic gain %d out of range 0-100", value)
	}
	return fmt.Sprintf("MG%03d", value), nil
}

// ParseMicGain parses an "MG"-prefixed message into its 0-100 value.
func ParseMicGain(msg string) (int, error) { return parseMeter(msg, "MG") }

// ProcLevels holds the speech processor's input and output levels, both
// 0-100. The radio's "PL" command always reports and sets both together
// (verified against the real radio: "PL100070" = input 100, output 70).
type ProcLevels struct {
	Input  int
	Output int
}

// EncodeProcLevels builds a "PL" command from both levels.
func EncodeProcLevels(levels ProcLevels) (string, error) {
	if levels.Input < 0 || levels.Input > 100 || levels.Output < 0 || levels.Output > 100 {
		return "", fmt.Errorf("proc level out of range 0-100: %+v", levels)
	}
	return fmt.Sprintf("PL%03d%03d", levels.Input, levels.Output), nil
}

// ParseProcLevels parses a "PL"-prefixed message into both levels.
func ParseProcLevels(msg string) (ProcLevels, error) {
	if !strings.HasPrefix(msg, "PL") || len(msg) < 8 {
		return ProcLevels{}, fmt.Errorf("not a proc levels message: %q", msg)
	}
	rest := msg[2:]
	input, err := strconv.Atoi(rest[0:3])
	if err != nil {
		return ProcLevels{}, fmt.Errorf("parsing proc input level in %q: %w", msg, err)
	}
	output, err := strconv.Atoi(rest[3:6])
	if err != nil {
		return ProcLevels{}, fmt.Errorf("parsing proc output level in %q: %w", msg, err)
	}
	return ProcLevels{Input: input, Output: output}, nil
}

// EncodeBC builds a "BC" command: 0 (off), 1 (BC1), or 2 (BC2). Beat
// Canceller, same off/1/2 exclusive shape as NR.
func EncodeBC(value int) (string, error) {
	if value < 0 || value > 2 {
		return "", fmt.Errorf("invalid BC value %d", value)
	}
	return fmt.Sprintf("BC%d", value), nil
}

// ParseBC parses a "BC" message into 0 (off), 1 (BC1), or 2 (BC2).
func ParseBC(msg string) (int, error) {
	if !strings.HasPrefix(msg, "BC") {
		return 0, fmt.Errorf("not a BC message: %q", msg)
	}
	return strconv.Atoi(msg[2:])
}

// EncodeProc builds a "PR00"/"PR01" command to disable/enable the speech
// processor, matching the radio's own 4-character format.
func EncodeProc(enabled bool) (string, error) {
	if enabled {
		return "PR01", nil
	}
	return "PR00", nil
}

// ParseProc parses a "PR0"-prefixed message into whether the speech
// processor is enabled. Must check the full "PR0" prefix, not just "PR":
// "PR1"-prefixed messages (ParseProcType, the effect type, a distinct
// command confirmed via the PC Command Reference) are the same length and
// also end in a 0/1 digit — a bare "PR" prefix check would wrongly match
// those too.
func ParseProc(msg string) (bool, error) {
	if !strings.HasPrefix(msg, "PR0") {
		return false, fmt.Errorf("not a PROC message: %q", msg)
	}
	return msg[len(msg)-1] == '1', nil
}

// EncodeProcType builds a "PR10"/"PR11" command to select the speech
// processor's effect curve (Kenwood PC Command Reference, "PR1" - "Speech
// Processor Effect Type"): false = Soft, true = Hard. A distinct command
// from EncodeProc/ParseProc ("PR0"-prefixed, processor on/off) despite
// sharing the "PR" family prefix.
func EncodeProcType(hard bool) (string, error) {
	if hard {
		return "PR11", nil
	}
	return "PR10", nil
}

// ParseProcType parses a "PR1"-prefixed message into whether the speech
// processor's effect type is Hard (false = Soft).
func ParseProcType(msg string) (bool, error) {
	if !strings.HasPrefix(msg, "PR1") {
		return false, fmt.Errorf("not a PROC effect type message: %q", msg)
	}
	return msg[len(msg)-1] == '1', nil
}

// Antenna holds the full "AN" command state: which antenna is selected plus
// the three extra RX-ANT/DRV/ANT-OUT toggles that ride along in the same
// command. Selecting an antenna must resend all four fields, so the current
// values of the other three need to be preserved from the radio's own report.
type Antenna struct {
	Selected      string // "1" or "2"
	RXAntEnabled  bool
	DRVEnabled    bool
	AntOutEnabled bool
}

// EncodeAntenna builds the "AN" command for the given antenna state.
func EncodeAntenna(a Antenna) (string, error) {
	if a.Selected != "1" && a.Selected != "2" {
		return "", fmt.Errorf("invalid antenna %q", a.Selected)
	}
	return fmt.Sprintf("AN%s%s%s%s", a.Selected, boolDigit(a.RXAntEnabled), boolDigit(a.DRVEnabled), boolDigit(a.AntOutEnabled)), nil
}

// ParseAntenna parses an "AN"-prefixed message into its four fields.
func ParseAntenna(msg string) (Antenna, error) {
	if !strings.HasPrefix(msg, "AN") || len(msg) < 6 {
		return Antenna{}, fmt.Errorf("not an antenna message: %q", msg)
	}
	rest := msg[2:]
	selected := "1"
	if rest[0] == '2' {
		selected = "2"
	}
	return Antenna{
		Selected:      selected,
		RXAntEnabled:  rest[1] == '1',
		DRVEnabled:    rest[2] == '1',
		AntOutEnabled: rest[3] == '1',
	}, nil
}

func boolDigit(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

// EncodePower builds a "PC" command to set the RF power level, 0-100 (watts
// on HF/6m, the TS-890's full range).
func EncodePower(value int) (string, error) {
	if value < 0 || value > 100 {
		return "", fmt.Errorf("power level %d out of range 0-100", value)
	}
	return fmt.Sprintf("PC%03d", value), nil
}

// ParsePower parses a "PC"-prefixed message into its 0-100 power level.
func ParsePower(msg string) (int, error) { return parseMeter(msg, "PC") }

// ifFilterCodes maps the three selectable IF (roofing) filter slots to the
// digit the "FL0" command uses, matching open890's FL00/FL01/FL02.
var ifFilterCodes = map[string]byte{"A": '0', "B": '1', "C": '2'}

// EncodeIFFilter builds an "FL0" command to select IF filter "A", "B", or "C".
func EncodeIFFilter(filter string) (string, error) {
	code, ok := ifFilterCodes[filter]
	if !ok {
		return "", fmt.Errorf("unknown IF filter %q", filter)
	}
	return fmt.Sprintf("FL0%c", code), nil
}

// ParseIFFilter parses an "FL0"-prefixed message into which IF filter (A/B/C)
// is currently selected. Distinct from "FL1"-prefixed messages, which report
// each filter's configured width in Hz rather than which one is active.
func ParseIFFilter(msg string) (string, error) {
	if !strings.HasPrefix(msg, "FL0") || len(msg) < 4 {
		return "", fmt.Errorf("not an IF filter message: %q", msg)
	}
	switch msg[3] {
	case '0':
		return "A", nil
	case '1':
		return "B", nil
	case '2':
		return "C", nil
	default:
		return "", fmt.Errorf("unknown IF filter code in %q", msg)
	}
}

// ParseIFFilterWidth parses an "FL1"-prefixed message into which IF filter
// (A/B/C) it describes and that filter's configured bandwidth in Hz.
// Distinct from "FL0"-prefixed messages, which report which filter is
// currently active rather than any filter's width. Verified live against the
// real radio: "FL1000600" -> filter A, last 4 digits "0600" * 10 = 6000 Hz.
func ParseIFFilterWidth(msg string) (filter string, widthHz int, err error) {
	if !strings.HasPrefix(msg, "FL1") || len(msg) < 9 {
		return "", 0, fmt.Errorf("not an IF filter width message: %q", msg)
	}
	switch msg[3] {
	case '0':
		filter = "A"
	case '1':
		filter = "B"
	case '2':
		filter = "C"
	default:
		return "", 0, fmt.Errorf("unknown IF filter code in %q", msg)
	}
	val, err := strconv.Atoi(msg[len(msg)-4:])
	if err != nil {
		return "", 0, fmt.Errorf("parsing filter width in %q: %w", msg, err)
	}
	return filter, val * 10, nil
}

// TunerState holds the antenna tuner's status bits, as reported by an
// "AC"-prefixed message.
type TunerState struct {
	RXEnabled    bool // tuner patched into the RX signal path
	TXEnabled    bool // tuner engaged for TX ("AT" on/off)
	TuningActive bool // a tune cycle is currently running
}

// EncodeTuner builds an "AC" command. The RX-enabled bit is always sent as 1
// regardless of its last reported value, matching open890: the radio's SET
// direction for this command doesn't behave as documented otherwise.
func EncodeTuner(txEnabled, tuningActive bool) string {
	return fmt.Sprintf("AC1%s%s", boolDigit(txEnabled), boolDigit(tuningActive))
}

// ParseTuner parses an "AC"-prefixed message into the tuner's status bits.
func ParseTuner(msg string) (TunerState, error) {
	if !strings.HasPrefix(msg, "AC") || len(msg) < 5 {
		return TunerState{}, fmt.Errorf("not a tuner message: %q", msg)
	}
	rest := msg[2:]
	return TunerState{
		RXEnabled:    rest[0] == '1',
		TXEnabled:    rest[1] == '1',
		TuningActive: rest[2] == '1',
	}, nil
}

// EncodeTX builds a "TX0"/"RX" command to manually key/unkey the
// transmitter, matching the radio's own SEND button (mic-source TX; there's
// no separate CAT command for the audio source itself).
func EncodeTX(transmitting bool) string {
	if transmitting {
		return "TX0"
	}
	return "RX"
}

// The audio (DSP) passband filter is entirely different from the roofing
// filter above: "SH0"/"SL0" report an INDEX into a mode-dependent lookup
// table, not a direct Hz value, and what that index even means (a width+
// shift pair, or two independent cut frequencies) depends on a menu setting
// ("EX00611"). Tables ported verbatim from open890's lib/open890/extract.ex,
// the only place this session found them documented; passband_id ranges and
// meanings verified live against the real radio (e.g. SH0028/SL035 in LSB
// with EX00611=1 resolves to width 3000 Hz / shift 1450 Hz).
var (
	ssbLoCutLookup = []int{0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000}
	ssbWidthLookup = []int{50, 80, 100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400, 2500, 2600, 2700, 2800, 2900, 3000}
	ssbHiCutLookup = []int{600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400, 2500, 2600, 2700, 2800, 2900, 3000, 3400, 4000, 5000}
	amLoCutLookup  = []int{0, 100, 200, 300}
	amHiCutLookup  = []int{2000, 2100, 2200, 2300, 2400, 2500, 2600, 2700, 2800, 2900, 3000, 3500, 4000, 5000}
	fmLoCutLookup  = []int{0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000}
	fmHiCutLookup  = []int{1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400, 2500, 2600, 2700, 2800, 2900, 3000, 3400, 4000, 5000}
	cwWidthLookup  = []int{50, 80, 100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, 900, 1000, 1500, 2000, 2500}
	fskWidthLookup = []int{250, 300, 350, 400, 450, 500, 1000, 1500}
	pskWidthLookup = []int{50, 80, 100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, 900, 1000, 1200, 1400, 1500, 1600, 1800, 2000, 2200, 2400, 2600, 2800, 3000}
)

func lookupClamped(table []int, index int) int {
	if index < 0 {
		index = 0
	}
	if index >= len(table) {
		index = len(table) - 1
	}
	return table[index]
}

// FilterMode is how the SSB passband controls are currently interpreted,
// configured on the radio via the "EX00611" menu item.
type FilterMode int

const (
	FilterModeHiLoCut FilterMode = iota
	FilterModeShiftWidth
)

// ParseSSBFilterMode parses an "EX00611" message (the SSB filter display
// mode menu item) into hi/lo-cut vs shift/width. The real wire format has a
// literal space before the value (verified live: "EX00611 001"), matching
// open890's parsing. 000 = hi/lo cut, 001 = shift/width (verified live).
func ParseSSBFilterMode(msg string) (FilterMode, error) {
	return parseFilterModeMsg(msg, "EX00611")
}

// ParseSSBDataFilterMode is the same for "EX00612", the menu item used in
// the data modes (LSB-D/USB-D).
func ParseSSBDataFilterMode(msg string) (FilterMode, error) {
	return parseFilterModeMsg(msg, "EX00612")
}

func parseFilterModeMsg(msg, prefix string) (FilterMode, error) {
	if !strings.HasPrefix(msg, prefix) {
		return 0, fmt.Errorf("not a %s message: %q", prefix, msg)
	}
	switch strings.TrimSpace(msg[len(prefix):]) {
	case "000":
		return FilterModeHiLoCut, nil
	case "001":
		return FilterModeShiftWidth, nil
	default:
		return 0, fmt.Errorf("unknown filter mode in %q", msg)
	}
}

// EncodeSSBFilterMode builds the menu command switching the SSB filter
// display between hi/lo cut and shift/width: "EX00611" for LSB/USB,
// "EX00612" for the data modes. Same literal space before the value as in
// the radio's own answers.
func EncodeSSBFilterMode(data bool, hiLoCut bool) string {
	item := "EX00611"
	if data {
		item = "EX00612"
	}
	if hiLoCut {
		return item + " 000"
	}
	return item + " 001"
}

// ParseFilterPassband parses an "SH0"/"SL0"-prefixed message into which side
// it reports (hi or lo) and the raw passband index. Note the two sides don't
// share a fixed digit width on the wire (verified live: "SH0028" vs "SL035"),
// so this parses the trailing digits as a plain integer rather than assuming
// a fixed field length.
func ParseFilterPassband(msg string) (isHi bool, passbandID int, err error) {
	var rest string
	switch {
	case strings.HasPrefix(msg, "SH0"):
		isHi, rest = true, msg[3:]
	case strings.HasPrefix(msg, "SL0"):
		isHi, rest = false, msg[3:]
	default:
		return false, 0, fmt.Errorf("not a filter passband message: %q", msg)
	}
	passbandID, err = strconv.Atoi(rest)
	if err != nil {
		return false, 0, fmt.Errorf("parsing passband index in %q: %w", msg, err)
	}
	return isHi, passbandID, nil
}

func calculateCWShift(passbandID int) int  { return 10*passbandID - 800 }
func calculateSSBShift(passbandID int) int { return 50*passbandID + 50 }

// FilterWidthShift resolves the audio (DSP) passband's current shape into a
// width and a shift, both in Hz, from the two raw passband indices ("SL0"
// gives loPassbandID, "SH0" gives hiPassbandID) and the current mode —
// mirroring open890's filter_lo_width/filter_hi_shift, since the radio
// itself never reports a direct Hz value for this filter. hasShift is false
// for FSK/PSK, which have no shift concept. For hi/lo-cut modes (AM, FM, and
// SSB when configured for hi/lo-cut instead of shift/width), the two cut
// frequencies are collapsed into a single width (their difference) and a
// shift (their midpoint) so the UI has one consistent "how wide, how
// centered" pair to show regardless of the radio's own display convention.
func FilterWidthShift(mode string, filterMode FilterMode, loPassbandID, hiPassbandID int) (widthHz, shiftHz int, hasShift bool) {
	switch mode {
	case "CW", "CW-R":
		return lookupClamped(cwWidthLookup, loPassbandID), calculateCWShift(hiPassbandID), true
	case "FSK", "FSK-R":
		return lookupClamped(fskWidthLookup, loPassbandID), 0, false
	case "PSK", "PSK-R":
		return lookupClamped(pskWidthLookup, loPassbandID), 0, false
	case "AM", "AM-D":
		// No real shift concept here (see AudioLoHiCut/AudioWidthRange) —
		// hasShift false (Nutzer-Wunsch, 2026-09-28: don't show a "Shift"
		// figure for modes that don't actually have one). Width alone
		// (hi-lo) is still a meaningful, real figure worth showing.
		lo, hi := lookupClamped(amLoCutLookup, loPassbandID), lookupClamped(amHiCutLookup, hiPassbandID)
		return hi - lo, (hi + lo) / 2, false
	case "FM", "FM-D":
		lo, hi := lookupClamped(fmLoCutLookup, loPassbandID), lookupClamped(fmHiCutLookup, hiPassbandID)
		return hi - lo, (hi + lo) / 2, false
	case "LSB", "USB", "LSB-D", "USB-D":
		if filterMode == FilterModeHiLoCut {
			// Same reasoning as AM/FM above: hi/lo-cut display mode has no
			// real shift either, only two independent cut frequencies.
			lo, hi := lookupClamped(ssbLoCutLookup, loPassbandID), lookupClamped(ssbHiCutLookup, hiPassbandID)
			return hi - lo, (hi + lo) / 2, false
		}
		return lookupClamped(ssbWidthLookup, loPassbandID), calculateSSBShift(hiPassbandID), true
	default:
		return 0, 0, false
	}
}

// AudioWidthRange returns the min/max WIDTH (Hz) achievable for the given
// mode/filter-mode, and whether width is settable there as a single value at
// all. False for AM/FM (and SSB in hi/lo-cut mode), which have no
// shift/width pair — those use independent lo-cut/hi-cut control instead
// (see AudioLoHiCut/AudioLoCutRange/AudioHiCutRange/EncodeLoCut/EncodeHiCut).
func AudioWidthRange(mode string, filterMode FilterMode) (minHz, maxHz int, settable bool) {
	switch mode {
	case "CW", "CW-R":
		return cwWidthLookup[0], cwWidthLookup[len(cwWidthLookup)-1], true
	case "FSK", "FSK-R":
		return fskWidthLookup[0], fskWidthLookup[len(fskWidthLookup)-1], true
	case "PSK", "PSK-R":
		return pskWidthLookup[0], pskWidthLookup[len(pskWidthLookup)-1], true
	case "LSB", "USB", "LSB-D", "USB-D":
		if filterMode == FilterModeShiftWidth {
			return ssbWidthLookup[0], ssbWidthLookup[len(ssbWidthLookup)-1], true
		}
		return 0, 0, false
	default:
		return 0, 0, false
	}
}

// AudioLoHiCut returns the current independent lo-cut/hi-cut Hz values for
// modes that have them (AM/FM), and whether the mode even has this
// independent-cut shape (false for modes that use a single width/shift pair
// instead — see AudioWidthRange for those).
func AudioLoHiCut(mode string, filterMode FilterMode, loPassbandID, hiPassbandID int) (loHz, hiHz int, ok bool) {
	switch mode {
	case "LSB", "USB", "LSB-D", "USB-D":
		if filterMode == FilterModeHiLoCut {
			return lookupClamped(ssbLoCutLookup, loPassbandID), lookupClamped(ssbHiCutLookup, hiPassbandID), true
		}
		return 0, 0, false
	case "AM", "AM-D":
		return lookupClamped(amLoCutLookup, loPassbandID), lookupClamped(amHiCutLookup, hiPassbandID), true
	case "FM", "FM-D":
		return lookupClamped(fmLoCutLookup, loPassbandID), lookupClamped(fmHiCutLookup, hiPassbandID), true
	default:
		return 0, 0, false
	}
}

// AudioLoCutRange and AudioHiCutRange return the min/max Hz achievable for
// lo-cut and hi-cut respectively, for modes with independent cut control.
func AudioLoCutRange(mode string, filterMode FilterMode) (minHz, maxHz int, ok bool) {
	switch mode {
	case "LSB", "USB", "LSB-D", "USB-D":
		if filterMode == FilterModeHiLoCut {
			return ssbLoCutLookup[0], ssbLoCutLookup[len(ssbLoCutLookup)-1], true
		}
		return 0, 0, false
	case "AM", "AM-D":
		return amLoCutLookup[0], amLoCutLookup[len(amLoCutLookup)-1], true
	case "FM", "FM-D":
		return fmLoCutLookup[0], fmLoCutLookup[len(fmLoCutLookup)-1], true
	default:
		return 0, 0, false
	}
}

func AudioHiCutRange(mode string, filterMode FilterMode) (minHz, maxHz int, ok bool) {
	switch mode {
	case "LSB", "USB", "LSB-D", "USB-D":
		if filterMode == FilterModeHiLoCut {
			return ssbHiCutLookup[0], ssbHiCutLookup[len(ssbHiCutLookup)-1], true
		}
		return 0, 0, false
	case "AM", "AM-D":
		return amHiCutLookup[0], amHiCutLookup[len(amHiCutLookup)-1], true
	case "FM", "FM-D":
		return fmHiCutLookup[0], fmHiCutLookup[len(fmHiCutLookup)-1], true
	default:
		return 0, 0, false
	}
}

// AudioLoCutSteps and AudioHiCutSteps return the exact Hz values the radio
// offers for lo-cut/hi-cut in the current mode (AM hi-cut for example: 2.0 to
// 3.0 kHz in 100 Hz steps, then 3.5, 4.0 and 5.0 kHz), so the UI can snap its
// sliders to them instead of letting the user pick values the radio rounds.
func AudioLoCutSteps(mode string, filterMode FilterMode) []int {
	switch mode {
	case "LSB", "USB", "LSB-D", "USB-D":
		if filterMode == FilterModeHiLoCut {
			return append([]int(nil), ssbLoCutLookup...)
		}
	case "AM", "AM-D":
		return append([]int(nil), amLoCutLookup...)
	case "FM", "FM-D":
		return append([]int(nil), fmLoCutLookup...)
	}
	return nil
}

func AudioHiCutSteps(mode string, filterMode FilterMode) []int {
	switch mode {
	case "LSB", "USB", "LSB-D", "USB-D":
		if filterMode == FilterModeHiLoCut {
			return append([]int(nil), ssbHiCutLookup...)
		}
	case "AM", "AM-D":
		return append([]int(nil), amHiCutLookup...)
	case "FM", "FM-D":
		return append([]int(nil), fmHiCutLookup...)
	}
	return nil
}

// EncodeLoCut and EncodeHiCut build "SL0"/"SH0" commands setting AM/FM's
// independent lo-cut/hi-cut directly (as opposed to EncodeAudioWidth's
// single-value width, which doesn't apply to these modes — see
// AudioLoHiCut). Same digit-padding rules as EncodeAudioWidth.
func EncodeLoCut(mode string, filterMode FilterMode, targetHz int) (string, error) {
	switch mode {
	case "LSB", "USB", "LSB-D", "USB-D":
		if filterMode == FilterModeHiLoCut {
			return fmt.Sprintf("SL0%02d", nearestPassbandIndex(ssbLoCutLookup, targetHz)), nil
		}
		return "", fmt.Errorf("lo-cut isn't settable in SSB shift/width mode")
	case "AM", "AM-D":
		return fmt.Sprintf("SL0%02d", nearestPassbandIndex(amLoCutLookup, targetHz)), nil
	case "FM", "FM-D":
		return fmt.Sprintf("SL0%02d", nearestPassbandIndex(fmLoCutLookup, targetHz)), nil
	default:
		return "", fmt.Errorf("lo-cut isn't independently settable for mode %q", mode)
	}
}

func EncodeHiCut(mode string, filterMode FilterMode, targetHz int) (string, error) {
	switch mode {
	case "LSB", "USB", "LSB-D", "USB-D":
		if filterMode == FilterModeHiLoCut {
			return fmt.Sprintf("SH0%03d", nearestPassbandIndex(ssbHiCutLookup, targetHz)), nil
		}
		return "", fmt.Errorf("hi-cut isn't settable in SSB shift/width mode")
	case "AM", "AM-D":
		return fmt.Sprintf("SH0%03d", nearestPassbandIndex(amHiCutLookup, targetHz)), nil
	case "FM", "FM-D":
		return fmt.Sprintf("SH0%03d", nearestPassbandIndex(fmHiCutLookup, targetHz)), nil
	default:
		return "", fmt.Errorf("hi-cut isn't independently settable for mode %q", mode)
	}
}

// ShiftRange returns the min/max SHIFT (Hz) achievable for the given
// mode/filter-mode, and whether shift is settable there at all — true only
// for CW/CW-R and SSB in shift/width display mode, mirroring hasShift from
// FilterWidthShift (see there for why AM/FM/hi-lo-cut modes don't have a
// real shift to set). Bounds come from calculateCWShift/calculateSSBShift's
// own valid passband-index ranges (0-160 and 0-49 respectively, taken from
// open890's calculate_cw_shift/calculate_ssb_shift guard clauses — open890
// itself never sends an SH0 SET for these, only reads them, so this range
// is reverse-engineered from the read side, not independently confirmed for
// the set direction).
func ShiftRange(mode string, filterMode FilterMode) (minHz, maxHz int, settable bool) {
	switch mode {
	case "CW", "CW-R":
		return calculateCWShift(0), calculateCWShift(160), true
	case "LSB", "USB", "LSB-D", "USB-D":
		if filterMode == FilterModeShiftWidth {
			return calculateSSBShift(0), calculateSSBShift(49), true
		}
		return 0, 0, false
	default:
		return 0, 0, false
	}
}

// EncodeShift builds an "SH0" command setting the audio filter's SHIFT (as
// opposed to EncodeAudioWidth's WIDTH, which uses "SL0") to whichever
// passband index's calculated shift is closest to targetHz. Only meaningful
// for CW/CW-R and SSB in shift/width mode (see ShiftRange) — same "SH0"
// command family already verified live for AM/FM's independent hi-cut
// (EncodeHiCut), including its minimum-3-digit padding requirement, but the
// specific CW/SSB shift index mapping used here hasn't itself been
// live-verified in the SET direction yet (only read/displayed so far).
func EncodeShift(mode string, filterMode FilterMode, targetHz int) (string, error) {
	switch mode {
	case "CW", "CW-R":
		return fmt.Sprintf("SH0%03d", nearestCWShiftIndex(targetHz)), nil
	case "LSB", "USB", "LSB-D", "USB-D":
		if filterMode == FilterModeShiftWidth {
			return fmt.Sprintf("SH0%03d", nearestSSBShiftIndex(targetHz)), nil
		}
		return "", fmt.Errorf("shift isn't directly settable for mode %q in hi/lo-cut filter mode", mode)
	default:
		return "", fmt.Errorf("shift isn't directly settable for mode %q", mode)
	}
}

// nearestCWShiftIndex inverts calculateCWShift (shift = 10*idx - 800):
// idx = (shift + 800) / 10, rounded to the nearest integer and clamped to
// the same [0, 160] range calculateCWShift itself is valid over.
func nearestCWShiftIndex(targetHz int) int {
	idx := (targetHz + 800 + 5) / 10 // +5 rounds to nearest instead of truncating
	switch {
	case idx < 0:
		return 0
	case idx > 160:
		return 160
	default:
		return idx
	}
}

// nearestSSBShiftIndex inverts calculateSSBShift (shift = 50*idx + 50):
// idx = (shift - 50) / 50, rounded to the nearest integer and clamped to
// the same [0, 49] range calculateSSBShift itself is valid over.
func nearestSSBShiftIndex(targetHz int) int {
	idx := (targetHz - 50 + 25) / 50 // +25 rounds to nearest instead of truncating
	switch {
	case idx < 0:
		return 0
	case idx > 49:
		return 49
	default:
		return idx
	}
}

func nearestPassbandIndex(table []int, targetHz int) int {
	best, bestDiff := 0, 0
	for i, v := range table {
		diff := v - targetHz
		if diff < 0 {
			diff = -diff
		}
		if i == 0 || diff < bestDiff {
			best, bestDiff = i, diff
		}
	}
	return best
}

// EncodeAudioWidth builds an "SL0"/"SH0" command setting the audio filter's
// WIDTH to whichever value the radio actually supports is closest to
// targetHz, for the given mode/filter-mode. The set direction needs the same
// "0" receiver-selector digit as the query/response ("SL0<index>", not a
// bare "SL<index>" — open890's own set command reads as if it omits this,
// but sending it that way was confirmed live to get "?" (invalid command)
// back from the real radio). It also needs a MINIMUM zero-padded digit
// count, live-verified to differ between the two: SL0 wants at least 2
// digits ("SL05"/"SL00" alone both got "?"; "SL005"/"SL000" were accepted),
// SH0 wants at least 3 ("SH010" got "?"; "SH0010" was accepted) — matching
// each command's own query/response digit width (SL0035 vs SH0023).
//
// AM/FM have no shift/width pair to set directly — they use independent
// lo-cut/hi-cut control instead (see EncodeLoCut/EncodeHiCut).
func EncodeAudioWidth(mode string, filterMode FilterMode, targetHz int) (string, error) {
	switch mode {
	case "CW", "CW-R":
		return fmt.Sprintf("SL0%02d", nearestPassbandIndex(cwWidthLookup, targetHz)), nil
	case "FSK", "FSK-R":
		return fmt.Sprintf("SL0%02d", nearestPassbandIndex(fskWidthLookup, targetHz)), nil
	case "PSK", "PSK-R":
		return fmt.Sprintf("SL0%02d", nearestPassbandIndex(pskWidthLookup, targetHz)), nil
	case "LSB", "USB", "LSB-D", "USB-D":
		if filterMode == FilterModeShiftWidth {
			return fmt.Sprintf("SL0%02d", nearestPassbandIndex(ssbWidthLookup, targetHz)), nil
		}
		return "", fmt.Errorf("audio width isn't directly settable for mode %q in hi/lo-cut filter mode", mode)
	default:
		return "", fmt.Errorf("audio width isn't directly settable for mode %q", mode)
	}
}
