package cat

import "testing"

func TestNotch(t *testing.T) {
	if EncodeNotch(true) != "NT1" || EncodeNotch(false) != "NT0" {
		t.Fatal("EncodeNotch")
	}
	if on, err := ParseNotch("NT1"); err != nil || !on {
		t.Fatal("ParseNotch NT1")
	}
	if _, err := ParseNotch("NT2"); err == nil {
		t.Fatal("ParseNotch NT2 must fail")
	}
	if c, err := EncodeNotchWidth(2); err != nil || c != "NW2" {
		t.Fatal("EncodeNotchWidth")
	}
	if _, err := EncodeNotchWidth(3); err == nil {
		t.Fatal("width 3 must fail")
	}
	if w, err := ParseNotchWidth("NW1"); err != nil || w != 1 {
		t.Fatal("ParseNotchWidth")
	}
	if c, err := EncodeNotchPos(7); err != nil || c != "BP007" {
		t.Fatalf("EncodeNotchPos: %q", c)
	}
	if _, err := EncodeNotchPos(256); err == nil {
		t.Fatal("pos 256 must fail")
	}
	if p, err := ParseNotchPos("BP200"); err != nil || p != 200 {
		t.Fatal("ParseNotchPos")
	}
}
