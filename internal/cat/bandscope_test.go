package cat

import "testing"

func TestBandScopeMode(t *testing.T) {
	if EncodeBandScopeMode(0) != "BS30" || EncodeBandScopeMode(1) != "BS31" || EncodeBandScopeMode(2) != "BS32" {
		t.Fatal("encode")
	}
	for msg, want := range map[string]int{"BS30": 0, "BS31": 1, "BS32": 2} {
		got, err := ParseBandScopeMode(msg)
		if err != nil || got != want {
			t.Fatalf("%s: %v %v", msg, got, err)
		}
	}
	for _, bad := range []string{"BS3", "BS33", "BS40", "BS3-1", "##BS30"} {
		if _, err := ParseBandScopeMode(bad); err == nil {
			t.Fatalf("%q should not parse", bad)
		}
	}
}

func TestAudioScope(t *testing.T) {
	if EncodeAudioScope(true) != "DD11" || EncodeAudioScope(false) != "DD10" {
		t.Error("audio scope commands")
	}
	line, ok := ParseAudioScopeLine("##DD30A10FF")
	if !ok || len(line) != 3 || line[0] != 0x0A || line[1] != 0x10 || line[2] != 0xFF {
		t.Errorf("parse = %v, %v", line, ok)
	}
	if _, ok := ParseAudioScopeLine("##DD2" + "00"); ok {
		t.Error("a band scope line is not an audio scope line")
	}
	if _, ok := ParseAudioScopeLine("##DD3"); ok {
		t.Error("an empty line must not parse")
	}
	if _, ok := ParseAudioScopeLine("##DD3ZZ"); ok {
		t.Error("bad hex must not parse")
	}
}
