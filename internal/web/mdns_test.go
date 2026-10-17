package web

import (
	"context"
	"encoding/binary"
	"os"
	"testing"
	"time"
)

func TestParsePTRAnswer(t *testing.T) {
	// header: id 0, flags response, qd 0, an 1
	msg := []byte{0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0}
	// owner name 174.1.168.192.in-addr.arpa; remember where the "arpa" label starts
	arpaOff := 0
	for _, l := range []string{"174", "1", "168", "192", "in-addr", "arpa"} {
		if l == "arpa" {
			arpaOff = len(msg)
		}
		msg = append(msg, byte(len(l)))
		msg = append(msg, l...)
	}
	msg = append(msg, 0)
	msg = binary.BigEndian.AppendUint16(msg, 12)
	msg = binary.BigEndian.AppendUint16(msg, 0x8001)
	msg = binary.BigEndian.AppendUint32(msg, 120)
	// rdata: "iPhone" + pointer to the "arpa" label inside the owner name (compression)
	rdata := append([]byte{6}, "iPhone"...)
	rdata = append(rdata, 0xC0|byte(arpaOff>>8), byte(arpaOff))
	msg = binary.BigEndian.AppendUint16(msg, uint16(len(rdata)))
	msg = append(msg, rdata...)
	got, err := parsePTRAnswer(msg)
	if err != nil {
		t.Fatal(err)
	}
	if got != "iPhone.arpa." {
		t.Fatalf("got %q", got)
	}
}

// Live check against a device on the LAN: MDNS_TEST_IP=192.168.1.x go test -run Live
func TestMDNSReverseLive(t *testing.T) {
	ip := os.Getenv("MDNS_TEST_IP")
	if ip == "" {
		t.Skip("MDNS_TEST_IP not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	t.Logf("%s -> %q", ip, mdnsReverse(ctx, ip))
}
