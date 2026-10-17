package audio

import "testing"

func TestSequenceRestartIsFollowed(t *testing.T) {
	var r Receiver
	feed := func(from, n int) (forwarded int) {
		for i := 0; i < n; i++ {
			if r.trackSequence(uint16(from + i)) {
				forwarded++
			}
		}
		return
	}

	if got := feed(100, 50); got != 50 || r.LostPackets() != 0 {
		t.Fatalf("normal stream: forwarded %d, lost %d", got, r.LostPackets())
	}
	// A real gap of 3 packets is loss.
	if !r.trackSequence(153) || r.LostPackets() != 3 {
		t.Fatalf("small gap: lost %d, want 3", r.LostPackets())
	}
	// The radio restarts its stream far ahead: no loss, nothing dropped.
	if got := feed(21200, 50); got != 50 || r.LostPackets() != 3 {
		t.Fatalf("jump ahead: forwarded %d, lost %d", got, r.LostPackets())
	}
	// ...and the next restart begins at a much lower number: nothing dropped.
	if got := feed(500, 50); got != 50 || r.LostPackets() != 3 {
		t.Fatalf("restart at lower number: forwarded %d, lost %d", got, r.LostPackets())
	}
}

func TestShortRunBehindFollows(t *testing.T) {
	var r Receiver
	for i := 0; i < 20; i++ {
		r.trackSequence(uint16(1000 + i))
	}
	// A single reordered/duplicate packet is dropped and counted...
	if r.trackSequence(1010) {
		t.Fatal("stale packet must be dropped")
	}
	if r.ReorderedPackets() != 1 {
		t.Fatalf("reordered %d, want 1", r.ReorderedPackets())
	}
	// ...but a stream that continues slightly lower is followed after a few.
	forwarded := 0
	for i := 0; i < 30; i++ {
		if r.trackSequence(uint16(1000 + i)) {
			forwarded++
		}
	}
	if forwarded < 20 {
		t.Fatalf("stream behind by 20 was dropped for too long: forwarded %d of 30", forwarded)
	}
}

func TestWraparoundStillCounts(t *testing.T) {
	var r Receiver
	for _, s := range []uint16{65534, 65535, 0, 1} {
		if !r.trackSequence(s) {
			t.Fatal("wraparound must not drop")
		}
	}
	if r.LostPackets() != 0 {
		t.Fatalf("wraparound counted as loss: %d", r.LostPackets())
	}
}
