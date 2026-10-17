package cat

import (
	"fmt"
	"math"
	"strconv"
)

// ParseMessageID parses a pop-up message report from the radio: "ME0" or
// "ME1" followed by the 3-digit message ID (ME1 = "Pop-up Message 2", which
// has priority over ME0 when both are shown). The ME0 layout is assumed to
// match ME1's (from the PC command reference).
func ParseMessageID(msg string) (source, id int, err error) {
	if len(msg) != 6 || msg[0] != 'M' || msg[1] != 'E' || (msg[2] != '0' && msg[2] != '1') {
		return 0, 0, fmt.Errorf("not a pop-up message: %q", msg)
	}
	id, err = strconv.Atoi(msg[3:])
	if err != nil || id < 0 {
		return 0, 0, fmt.Errorf("bad message ID in %q", msg)
	}
	return int(msg[2] - '0'), id, nil
}

// MessageText returns the text to show for a radio message ID, or "" for IDs
// that are not worth a warning in the status line (000 = no message, program
// timer and display colour screens, unused IDs).
func MessageText(id int) string {
	switch {
	case id == 3:
		return "USB bus power error"
	case id == 4:
		return "Temperature protection"
	case id == 5:
		return "Frequency unlock"
	case id == 6:
		return "TX protection (high temperature)"
	case id == 7:
		return "Reference signal input error"
	case id == 9:
		return "Backup data corruption"
	case id >= 10 && id <= 21:
		return "DSP error"
	case id == 23:
		return "Hardware error"
	case id == 25:
		return "Timer power off"
	}
	return ""
}

// JitterChoicesMs are the only jitter buffer lengths "##KN4" accepts
// (units of 20 ms: 04, 10, 25, 40). Anything else, e.g. 30, is answered with
// "?" (seen live).
var JitterChoicesMs = []int{80, 200, 500, 800}

// ParseJitterBuffer parses a "##KN4" answer into the buffer length in ms.
func ParseJitterBuffer(msg string) (int, error) {
	if len(msg) != 7 || msg[:5] != "##KN4" {
		return 0, fmt.Errorf("not a jitter buffer message: %q", msg)
	}
	units, err := strconv.Atoi(msg[5:])
	if err != nil || units < 0 {
		return 0, fmt.Errorf("bad jitter buffer value in %q", msg)
	}
	return units * 20, nil
}

// EncodeJitterBuffer builds the "##KN4" set command for the choice nearest
// to ms. Only accepted by the radio for a KNS admin login.
func EncodeJitterBuffer(ms int) string {
	best := JitterChoicesMs[0]
	for _, c := range JitterChoicesMs {
		if abs(c-ms) < abs(best-ms) {
			best = c
		}
	}
	return fmt.Sprintf("##KN4%02d", best/20)
}

// VoIP audio input/output level ("##KN3"): P1 selects which side (0 = input,
// 1 = output), P2 is the level 0-100. Query is "##KN3<P1>", set/answer is
// "##KN3<P1><P2 3-digit>". Like "##KN4", the SET form is only accepted by
// the radio for a KNS admin login (the reference PDF says so explicitly);
// reading works for anyone.

// EncodeVoipLevelQuery builds the "##KN3<P1>" read command for one side.
func EncodeVoipLevelQuery(output bool) string {
	if output {
		return "##KN31"
	}
	return "##KN30"
}

// EncodeVoipLevel builds the "##KN3<P1><P2>" set command, level 0-100.
func EncodeVoipLevel(output bool, level int) (string, error) {
	if level < 0 || level > 100 {
		return "", fmt.Errorf("VoIP audio level %d out of range 0-100", level)
	}
	p1 := byte('0')
	if output {
		p1 = '1'
	}
	return fmt.Sprintf("##KN3%c%03d", p1, level), nil
}

// ParseVoipLevel parses a "##KN3<P1><P2>" answer into which side it is and
// the level.
func ParseVoipLevel(msg string) (output bool, level int, err error) {
	if len(msg) != 9 || msg[:5] != "##KN3" {
		return false, 0, fmt.Errorf("not a VoIP audio level message: %q", msg)
	}
	switch msg[5] {
	case '0':
		output = false
	case '1':
		output = true
	default:
		return false, 0, fmt.Errorf("bad P1 in VoIP audio level message: %q", msg)
	}
	level, err = strconv.Atoi(msg[6:])
	if err != nil || level < 0 {
		return false, 0, fmt.Errorf("bad level in VoIP audio level message: %q", msg)
	}
	return output, level, nil
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// ParsePitch parses a "PT" answer (side tone / CW pitch): "PT" + 3 digits,
// 000..160 = 300..1100 Hz in 5 Hz steps. Returns the pitch in Hz.
func ParsePitch(msg string) (int, error) {
	if len(msg) != 5 || msg[:2] != "PT" {
		return 0, fmt.Errorf("not a pitch message: %q", msg)
	}
	n, err := strconv.Atoi(msg[2:])
	if err != nil || n < 0 || n > 160 {
		return 0, fmt.Errorf("bad pitch value in %q", msg)
	}
	return 300 + 5*n, nil
}

// ParseAPFShift parses an "AP1" answer (audio peak filter shift): "AP1" + 2
// digits, 00..80 = -200..+200 Hz around the CW pitch in 5 Hz steps (40 =
// centre). Returns the shift in Hz.
func ParseAPFShift(msg string) (int, error) {
	if len(msg) != 5 || msg[:3] != "AP1" {
		return 0, fmt.Errorf("not an APF shift message: %q", msg)
	}
	n, err := strconv.Atoi(msg[3:])
	if err != nil || n < 0 || n > 80 {
		return 0, fmt.Errorf("bad APF shift in %q", msg)
	}
	return (n - 40) * 5, nil
}

// ParseAPFOn parses an "AP0" answer (audio peak filter on/off): 0 = OFF,
// 1 = ON. The PC command reference lists 1 = OFF / 2 = ON, but the real
// radio answers AP00 while off and rejects AP02 with "?" (seen live).
func ParseAPFOn(msg string) (bool, error) {
	switch msg {
	case "AP00":
		return false, nil
	case "AP01":
		return true, nil
	}
	return false, fmt.Errorf("not an APF on/off message: %q", msg)
}

// EncodeAPFOn builds the "AP0" set command: 0 = OFF, 1 = ON (see ParseAPFOn).
func EncodeAPFOn(on bool) string {
	if on {
		return "AP01"
	}
	return "AP00"
}

// EncodeAPFShift builds the "AP1" set command for a shift in Hz around the
// CW pitch: rounded to the 5 Hz steps and clamped to -200..+200 Hz (00..80).
func EncodeAPFShift(hz int) string {
	n := hz/5 + 40
	if hz%5 != 0 {
		n = int(math.Round(float64(hz)/5)) + 40
	}
	if n < 0 {
		n = 0
	}
	if n > 80 {
		n = 80
	}
	return fmt.Sprintf("AP1%02d", n)
}

// APFBandwidths are the audio peak filter's pass bandwidth choices ("AP2":
// 0 = NAR, 1 = MID, 2 = WIDE), indexed by that digit.
var APFBandwidths = []string{"NAR", "MID", "WIDE"}

// ParseAPFBandwidth parses an "AP2" answer into the choice index 0..2.
func ParseAPFBandwidth(msg string) (int, error) {
	if len(msg) != 4 || msg[:3] != "AP2" || msg[3] < '0' || msg[3] > '2' {
		return 0, fmt.Errorf("not an APF bandwidth message: %q", msg)
	}
	return int(msg[3] - '0'), nil
}

// EncodeAPFBandwidth builds the "AP2" set command for a choice index 0..2.
func EncodeAPFBandwidth(idx int) (string, error) {
	if idx < 0 || idx >= len(APFBandwidths) {
		return "", fmt.Errorf("invalid APF bandwidth %d", idx)
	}
	return fmt.Sprintf("AP2%d", idx), nil
}

// ParseAPFGain parses an "AP3" answer (audio peak filter gain) into 0..6.
func ParseAPFGain(msg string) (int, error) {
	if len(msg) != 4 || msg[:3] != "AP3" || msg[3] < '0' || msg[3] > '6' {
		return 0, fmt.Errorf("not an APF gain message: %q", msg)
	}
	return int(msg[3] - '0'), nil
}

// EncodeAPFGain builds the "AP3" set command for a gain 0..6.
func EncodeAPFGain(gain int) (string, error) {
	if gain < 0 || gain > 6 {
		return "", fmt.Errorf("invalid APF gain %d", gain)
	}
	return fmt.Sprintf("AP3%d", gain), nil
}
