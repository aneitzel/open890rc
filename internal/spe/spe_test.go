package spe

import "testing"

func TestParseAndExtract(t *testing.T) {
	csv := ",13K,O,T,A,1,05,1a,0r,H,1200,1.10,1.20,50.0,20.0,40,41,42,N,N,"
	payload := make([]byte, statusLen)
	copy(payload, csv)
	frame := append([]byte{0x12, 0xAA, 0xAA, 0xAA, statusLen}, payload...)
	// Split across two reads, plus the start of the next sync.
	frames, rest := extractFrames(frame[:30])
	if len(frames) != 0 {
		t.Fatal("partial frame must not parse")
	}
	frames, _ = extractFrames(append(rest, frame[30:]...))
	if len(frames) != 1 {
		t.Fatalf("frames = %d", len(frames))
	}
	st, ok := parseStatus(frames[0].payload)
	want := Status{On: true, Operate: true, TX: true, Level: "H", Model: "13K", PowerW: 1200, SWR: 1.1}
	if !ok || st != want {
		t.Fatalf("got %+v ok=%v", st, ok)
	}
	if st, ok := parseStatus([]byte(",13K,O,R,A,1,05,1a,0r,H,0,0,0,0,0,0,0,0,P,S,")); !ok || st.Warning != "POWER LIMIT EXCEEDED" || st.Alarm != "SWR EXCEEDING LIMITS" {
		t.Fatalf("codes: %+v", st)
	}
	if st, _ := parseStatus([]byte("C,20K,S,R,x,1,00,1a,0r,L,0,")); st.Operate || st.Level != "L" {
		t.Fatalf("prefix variant: %+v", st)
	}
}

func TestPacket(t *testing.T) {
	p := packet(0x0D)
	if len(p) != 6 || p[3] != 1 || p[4] != 0x0D || p[5] != 0x0D {
		t.Fatalf("%x", p)
	}
}

func TestRCUFrame(t *testing.T) {
	payload := make([]byte, 367)
	payload[4] = 0xB0 // bit 6 clear => LED on
	stream := append([]byte{0xAA, 0xAA, 0xAA, 0x6A}, payload...)
	stream = append(stream, 0xAA, 0xAA, 0xAA, 0x43) // start of next frame
	frames, _ := extractFrames(stream)
	if len(frames) != 1 || !frames[0].rcu || len(frames[0].payload) != 367 {
		t.Fatalf("frames: %+v", len(frames))
	}
	if on, ok := tuneLEDOn(frames[0].payload); !ok || !on {
		t.Fatal("LED should be on")
	}
	payload[4] = 0xF0
	if on, _ := tuneLEDOn(payload); on {
		t.Fatal("LED should be off")
	}
}

func TestLCDSWR(t *testing.T) {
	payload := make([]byte, 367)
	copy(payload[314:320], []byte{0x00, 0x11, 0x0e, 0x10, 0x15, 0x8f}) // from a real capture: "1.05"
	if v, ok := lcdSWR(payload); !ok || v != 1.05 {
		t.Fatalf("got %v %v", v, ok)
	}
	copy(payload[314:320], []byte{0x0d, 0x0d, 0x0e, 0x0d, 0x0d, 0x8f}) // idle "--.--"
	if _, ok := lcdSWR(payload); ok {
		t.Fatal("idle must not parse")
	}
}

func TestLCDPower(t *testing.T) {
	payload := make([]byte, 367)
	copy(payload[112:119], []byte{0x00, 0x00, 0x19, 0x0e, 0x16, 0x00, 0x37}) // real capture: "9.6" then 'W'
	if v, ok := lcdPower(payload); !ok || v != 9.6 {
		t.Fatalf("got %v %v", v, ok)
	}
}
