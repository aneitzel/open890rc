package cat

import "testing"

func TestTXMonitor(t *testing.T) {
	if EncodeTXMonitor(true) != "MO01" || EncodeTXMonitor(false) != "MO00" {
		t.Fatal("encode")
	}
	for msg, want := range map[string]bool{"MO01": true, "MO00": false} {
		got, err := ParseTXMonitor(msg)
		if err != nil || got != want {
			t.Fatalf("%s: %v %v", msg, got, err)
		}
	}
	for _, bad := range []string{"MO10", "MO0", "MO02", "ML000", "PR01"} {
		if _, err := ParseTXMonitor(bad); err == nil {
			t.Fatalf("%q should not parse", bad)
		}
	}
}

func TestTXMonitorLevel(t *testing.T) {
	if c, err := EncodeTXMonitorLevel(0); err != nil || c != "ML000" {
		t.Fatal(c, err)
	}
	if c, err := EncodeTXMonitorLevel(20); err != nil || c != "ML020" {
		t.Fatal(c, err)
	}
	if c, err := EncodeTXMonitorLevel(5); err != nil || c != "ML005" {
		t.Fatal(c, err)
	}
	if _, err := EncodeTXMonitorLevel(21); err == nil {
		t.Fatal("level 21 must fail")
	}
	if _, err := EncodeTXMonitorLevel(-1); err == nil {
		t.Fatal("negative level must fail")
	}
	if n, err := ParseTXMonitorLevel("ML015"); err != nil || n != 15 {
		t.Fatal(n, err)
	}
	if n, err := ParseTXMonitorLevel("ML000"); err != nil || n != 0 {
		t.Fatal(n, err)
	}
	for _, bad := range []string{"ML15", "MO015", "ML0150", "ML0xx"} {
		if _, err := ParseTXMonitorLevel(bad); err == nil {
			t.Fatalf("%q should not parse", bad)
		}
	}
}
