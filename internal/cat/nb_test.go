package cat

import "testing"

func TestNoiseBlankerSettings(t *testing.T) {
	if c, err := EncodeNBLevel(1, 7); err != nil || c != "NL1007" {
		t.Fatal(c, err)
	}
	if c, err := EncodeNBLevel(2, 10); err != nil || c != "NL2010" {
		t.Fatal(c, err)
	}
	if _, err := EncodeNBLevel(2, 11); err == nil {
		t.Fatal("NB2 level 11 must fail")
	}
	if _, err := EncodeNBLevel(1, 0); err == nil {
		t.Fatal("level 0 must fail")
	}
	if w, l, err := ParseNBLevel("NL2009"); err != nil || w != 2 || l != 9 {
		t.Fatal(w, l, err)
	}
	if _, _, err := ParseNBLevel("NL3009"); err == nil {
		t.Fatal("NL3")
	}
	if EncodeNBType(true) != "NBT1" || EncodeNBType(false) != "NBT0" {
		t.Fatal("type")
	}
	if b, err := ParseNBType("NBT1"); err != nil || !b {
		t.Fatal(b, err)
	}
	if c, _ := EncodeNBDepth(5); c != "NBD005" {
		t.Fatal(c)
	}
	if c, _ := EncodeNBWidth(20); c != "NBW020" {
		t.Fatal(c)
	}
	if v, err := ParseNBDepth("NBD012"); err != nil || v != 12 {
		t.Fatal(v, err)
	}
	if v, err := ParseNBWidth("NBW003"); err != nil || v != 3 {
		t.Fatal(v, err)
	}
	if _, err := ParseNBWidth("NBD003"); err == nil {
		t.Fatal("prefix")
	}
	if _, _, err := ParseNB("NBT1"); err == nil {
		t.Fatal("NBT1 must not parse as NB1/NB2 on-off")
	}
}
