package cat

import (
	"strings"
	"testing"
)

func TestTXEQ(t *testing.T) {
	if EncodeTXEQ(true) != "EQT01" || EncodeTXEQ(false) != "EQT00" {
		t.Fatal("encode")
	}
	for msg, want := range map[string]bool{"EQT01": true, "EQT00": false} {
		got, err := ParseTXEQ(msg)
		if err != nil || got != want {
			t.Fatalf("%s: %v %v", msg, got, err)
		}
	}
	for _, bad := range []string{"EQT10", "EQT1", "EQT02", "EQT0", "PR01"} {
		if _, err := ParseTXEQ(bad); err == nil {
			t.Fatalf("%q should not parse", bad)
		}
	}
	if !TXEQApplies("USB") || !TXEQApplies("FM-D") || TXEQApplies("CW") || TXEQApplies("FSK") || TXEQApplies("PSK-R") || TXEQApplies("") {
		t.Fatal("TXEQApplies")
	}
}

func TestEQEffectsAndRX(t *testing.T) {
	if c, _ := EncodeTXEQEffect(5); c != "EQT15" {
		t.Fatal(c)
	}
	if c, _ := EncodeRXEQEffect(8); c != "EQR18" {
		t.Fatal(c)
	}
	if _, err := EncodeTXEQEffect(9); err == nil {
		t.Fatal("effect 9 must fail")
	}
	if n, err := ParseTXEQEffect("EQT17"); err != nil || n != 7 {
		t.Fatal(n, err)
	}
	if n, err := ParseRXEQEffect("EQR12"); err != nil || n != 2 {
		t.Fatal(n, err)
	}
	if _, err := ParseRXEQEffect("EQT12"); err == nil {
		t.Fatal("wrong prefix")
	}
	if on, err := ParseRXEQ("EQR01"); err != nil || !on {
		t.Fatal(on, err)
	}
	if EncodeRXEQ(false) != "EQR00" {
		t.Fatal("rx off")
	}
	if _, err := ParseRXEQ("EQR10"); err == nil {
		t.Fatal("EQR1 is the effect")
	}
}

func TestEncodeActiveReceiver(t *testing.T) {
	if c, err := EncodeActiveReceiver(VFOA); err != nil || c != "FR0" {
		t.Fatal(c, err)
	}
	if c, err := EncodeActiveReceiver(VFOB); err != nil || c != "FR1" {
		t.Fatal(c, err)
	}
	if _, err := EncodeActiveReceiver("C"); err == nil {
		t.Fatal("C must fail")
	}
}

func TestEQBands(t *testing.T) {
	raw := make([]int, EQBands)
	raw[0], raw[1], raw[17] = 0, 6, 30
	for i := 2; i < 17; i++ {
		raw[i] = 99
	}
	cmd, err := EncodeEQBands(true, raw)
	if err != nil || cmd != "UT0006"+strings.Repeat("99", 15)+"30" {
		t.Fatalf("EncodeEQBands = %q, %v", cmd, err)
	}
	if _, err := EncodeEQBands(false, raw[:5]); err == nil {
		t.Error("short slice accepted")
	}
	if _, err := EncodeEQBands(false, append([]int{31}, raw[1:]...)); err == nil {
		t.Error("out of range accepted")
	}
	tx, got, err := ParseEQBands("UR" + strings.Repeat("06", 18))
	if err != nil || tx || len(got) != 18 || got[5] != 6 {
		t.Fatalf("ParseEQBands = %v %v %v", tx, got, err)
	}
	if tx, _, err := ParseEQBands("UT" + strings.Repeat("30", 18)); err != nil || !tx {
		t.Fatalf("UT parse: %v %v", tx, err)
	}
	if _, _, err := ParseEQBands("UT" + strings.Repeat("99", 18)); err == nil {
		t.Error("99 in an answer accepted")
	}
}
