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
