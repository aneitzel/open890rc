package cat

import (
	"strings"
	"testing"
)

func TestVoiceMsgListDisplay(t *testing.T) {
	if EncodePBListDisplay(true) != "PB01" || EncodePBListDisplay(false) != "PB00" {
		t.Fatal("encode")
	}
	if on, err := ParsePBListDisplay("PB01"); err != nil || !on {
		t.Fatal(on, err)
	}
	if on, err := ParsePBListDisplay("PB00"); err != nil || on {
		t.Fatal(on, err)
	}
	if _, err := ParsePBListDisplay("PB1"); err == nil {
		t.Fatal("must not parse PB1 as PB0")
	}
}

func TestVoiceMsgPlayback(t *testing.T) {
	if c, err := EncodePBPlayback(1, VoiceMsgOpSend); err != nil || c != "PB115" {
		t.Fatal(c, err)
	}
	if c, err := EncodePBPlayback(6, VoiceMsgOpStop); err != nil || c != "PB160" {
		t.Fatal(c, err)
	}
	if _, err := EncodePBPlayback(0, VoiceMsgOpPlay); err == nil {
		t.Fatal("channel 0 must fail")
	}
	if _, err := EncodePBPlayback(7, VoiceMsgOpPlay); err == nil {
		t.Fatal("channel 7 must fail")
	}
	if _, err := EncodePBPlayback(1, 6); err == nil {
		t.Fatal("op 6 (repeat wait, response only) must not be settable")
	}
	channel, op, elapsed, err := ParsePBPlayback("PB1" + "1" + "5" + "042")
	if err != nil || channel != 1 || op != VoiceMsgOpSend || elapsed != 42 {
		t.Fatal(channel, op, elapsed, err)
	}
}

func TestVoiceMsgRegistration(t *testing.T) {
	if q, err := EncodePBRegistrationQuery(3); err != nil || q != "PB23" {
		t.Fatal(q, err)
	}
	channel, registered, seconds, err := ParsePBRegistration("PB2" + "3" + "1" + "087")
	if err != nil || channel != 3 || !registered || seconds != 87 {
		t.Fatal(channel, registered, seconds, err)
	}
	channel, registered, seconds, err = ParsePBRegistration("PB2" + "5" + "0" + "000")
	if err != nil || channel != 5 || registered || seconds != 0 {
		t.Fatal(channel, registered, seconds, err)
	}
}

func TestVoiceMsgRepeat(t *testing.T) {
	if c, err := EncodePBRepeat(2, true); err != nil || c != "PB321" {
		t.Fatal(c, err)
	}
	if c, err := EncodePBRepeat(4, false); err != nil || c != "PB340" {
		t.Fatal(c, err)
	}
	if q, err := EncodePBRepeatQuery(1); err != nil || q != "PB31" {
		t.Fatal(q, err)
	}
	channel, on, err := ParsePBRepeat("PB321")
	if err != nil || channel != 2 || !on {
		t.Fatal(channel, on, err)
	}
	channel, on, err = ParsePBRepeat("PB340")
	if err != nil || channel != 4 || on {
		t.Fatal(channel, on, err)
	}
}

func TestVoiceMsgName(t *testing.T) {
	if q, err := EncodePBNameQuery(6); err != nil || q != "PB46" {
		t.Fatal(q, err)
	}
	channel, name, err := ParsePBName("PB41 CQ CALL")
	if err != nil || channel != 1 || name != "CQ CALL" {
		t.Fatal(channel, name, err)
	}
	// trailing padding spaces trimmed
	channel, name, err = ParsePBName("PB42 EXCHANGE   ")
	if err != nil || channel != 2 || name != "EXCHANGE" {
		t.Fatal(channel, name, err)
	}
	// unregistered channel: empty name
	channel, name, err = ParsePBName("PB43 ")
	if err != nil || channel != 3 || name != "" {
		t.Fatal(channel, name, err)
	}
	if c, err := EncodePBName(1, "CQ CALL"); err != nil || c != "PB41 CQ CALL" {
		t.Fatal(c, err)
	}
	if _, err := EncodePBName(1, strings.Repeat("x", 31)); err == nil {
		t.Fatal("31-character name must fail")
	}
	if c, err := EncodePBName(2, strings.Repeat("x", 30)); err != nil || c != "PB42 "+strings.Repeat("x", 30) {
		t.Fatal(c, err)
	}
}

func TestVoiceMsgRecordingSource(t *testing.T) {
	if c, err := EncodePBRecordingSource(VoiceMsgSourceLAN); err != nil || c != "PB53" {
		t.Fatal(c, err)
	}
	if _, err := EncodePBRecordingSource(4); err == nil {
		t.Fatal("source 4 must fail")
	}
}

func TestVoiceMsgRecordingRemaining(t *testing.T) {
	if v, err := ParsePBRecordingRemaining("PB6042"); err != nil || v != 42 {
		t.Fatal(v, err)
	}
	if v, err := ParsePBRecordingRemaining("PB6100"); err != nil || v != 100 {
		t.Fatal(v, err)
	}
	if _, err := ParsePBRecordingRemaining("PB5042"); err == nil {
		t.Fatal("must not parse PB5 as PB6")
	}
}

func TestVoiceMsgRecording(t *testing.T) {
	if c, err := EncodeVoiceMsgRecording(VoiceMsgRecOpRecord); err != nil || c != "RE1" {
		t.Fatal(c, err)
	}
	if c, err := EncodeVoiceMsgRecording(VoiceMsgRecOpStop); err != nil || c != "RE0" {
		t.Fatal(c, err)
	}
	if c, err := EncodeVoiceMsgRecording(VoiceMsgRecOpPauseRecord); err != nil || c != "RE4" {
		t.Fatal(c, err)
	}
	if _, err := EncodeVoiceMsgRecording(VoiceMsgRecOpFullTimeStorage); err == nil {
		t.Fatal("op 2 (setting only) must not be settable via this path")
	}
	if _, err := EncodeVoiceMsgRecording(VoiceMsgRecOpRecordFailed); err == nil {
		t.Fatal("op 6 (response only) must not be settable")
	}
	op, progress, err := ParseVoiceMsgRecording("RE1042")
	if err != nil || op != VoiceMsgRecOpRecord || progress != 42 {
		t.Fatal(op, progress, err)
	}
	op, progress, err = ParseVoiceMsgRecording("RE0000")
	if err != nil || op != VoiceMsgRecOpStop || progress != 0 {
		t.Fatal(op, progress, err)
	}
}

func TestVoiceMsgChannelOp(t *testing.T) {
	if c, err := EncodeVoiceMsgChannelOp(3, VoiceMsgLMOpDelete); err != nil || c != "LM33" {
		t.Fatal(c, err)
	}
	if c, err := EncodeVoiceMsgDelete(1); err != nil || c != "LM13" {
		t.Fatal(c, err)
	}
	if _, err := EncodeVoiceMsgChannelOp(0, VoiceMsgLMOpDelete); err == nil {
		t.Fatal("channel 0 must fail")
	}
	if _, err := EncodeVoiceMsgChannelOp(7, VoiceMsgLMOpDelete); err == nil {
		t.Fatal("channel 7 must fail")
	}
	if _, err := EncodeVoiceMsgChannelOp(1, 4); err == nil {
		t.Fatal("op 4 must fail")
	}
	channel, op, elapsed, err := ParseVoiceMsgChannelOp("LM330042")
	if err == nil {
		t.Fatalf("LM330042 is too long and must not parse, got channel=%d op=%d elapsed=%d", channel, op, elapsed)
	}
	channel, op, elapsed, err = ParseVoiceMsgChannelOp("LM13000")
	if err != nil || channel != 1 || op != VoiceMsgLMOpDelete || elapsed != 0 {
		t.Fatal(channel, op, elapsed, err)
	}
	channel, op, elapsed, err = ParseVoiceMsgChannelOp("LM42042")
	if err != nil || channel != 4 || op != VoiceMsgLMOpRecording || elapsed != 42 {
		t.Fatal(channel, op, elapsed, err)
	}
	if _, _, _, err := ParseVoiceMsgChannelOp("PB13000"); err == nil {
		t.Fatal("must not parse PB1 as LM")
	}
}

func TestBeepVolume(t *testing.T) {
	if EncodeBeepVolumeQuery() != "EX00100" {
		t.Errorf("query = %q", EncodeBeepVolumeQuery())
	}
	if c := EncodeBeepVolume(0); c != "EX00100 000" {
		t.Errorf("mute = %q", c)
	}
	if c := EncodeBeepVolume(7); c != "EX00100 007" {
		t.Errorf("set 7 = %q", c)
	}
	if c := EncodeBeepVolume(99); c != "EX00100 020" {
		t.Errorf("clamped = %q", c)
	}
	if v, err := ParseBeepVolume("EX00100 005"); err != nil || v != 5 {
		t.Errorf("parse = %d, %v", v, err)
	}
	if _, err := ParseBeepVolume("EX00611 001"); err == nil {
		t.Error("another menu item must not parse as beep volume")
	}
	if _, err := ParseBeepVolume("EX00100 021"); err == nil {
		t.Error("out of range must fail")
	}
}
