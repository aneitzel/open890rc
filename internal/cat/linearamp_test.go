package cat

import "testing"

func TestLinearAmp(t *testing.T) {
	if EncodeLinearAmpQuery() != "LA1" {
		t.Fatal("EncodeLinearAmpQuery")
	}
	if EncodeLinearAmp(true) != "LA11" || EncodeLinearAmp(false) != "LA10" {
		t.Fatal("EncodeLinearAmp")
	}
	if on, err := ParseLinearAmp("LA11"); err != nil || !on {
		t.Fatal("ParseLinearAmp LA11")
	}
	if on, err := ParseLinearAmp("LA10"); err != nil || on {
		t.Fatal("ParseLinearAmp LA10")
	}
	if _, err := ParseLinearAmp("LA12"); err == nil {
		t.Fatal("ParseLinearAmp LA12 must fail")
	}
	if _, err := ParseLinearAmp("LA1"); err == nil {
		t.Fatal("ParseLinearAmp LA1 (no param) must fail")
	}
}
