package state

import "testing"

// TestTXFlags verifies the TX0/RX wire messages toggle State.TXFlags'
// radioTX as expected — this is what cmd/open890rc/main.go's onPCM relies
// on to suppress the radio's own RX audio broadcast while a client is
// transmitting (Nutzer-Report, 2026-10-14: double-streaming the radio's
// continuing LAN audio alongside the new TX-audio relay caused a
// continuously growing playback backlog and frequent buffer trims, heard
// as distortion/dropouts).
func TestTXFlags(t *testing.T) {
	s := New()
	if radioTX, _, _ := s.TXFlags(); radioTX {
		t.Fatal("radioTX should start false")
	}
	s.Update("TX0")
	if radioTX, _, _ := s.TXFlags(); !radioTX {
		t.Fatal("radioTX should be true after TX0")
	}
	s.Update("RX")
	if radioTX, _, _ := s.TXFlags(); radioTX {
		t.Fatal("radioTX should be false again after RX")
	}
}

func TestRadioStandbyFromPS(t *testing.T) {
	s := New()
	s.SetConnected(true)
	if !s.Update("PS0") || !s.Snapshot().RadioStandby {
		t.Fatal("PS0 should mark standby")
	}
	if s.Update("PS0") {
		t.Fatal("repeat PS0 should not change state")
	}
	if !s.Update("PS1") || s.Snapshot().RadioStandby {
		t.Fatal("PS1 should clear standby")
	}
	s.Update("PS2")
	s.SetConnected(false)
	if s.Snapshot().RadioStandby {
		t.Fatal("disconnect should reset standby")
	}
}
