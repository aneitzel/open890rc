package radio

import (
	"net"
	"testing"
	"time"
)

func TestSendWOLPacket(t *testing.T) {
	l, err := net.ListenPacket("udp4", "127.0.0.1:9")
	if err != nil {
		t.Skip("port 9 unavailable:", err)
	}
	defer l.Close()
	if err := SendWOL("aa:bb:cc:dd:ee:ff", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 200)
	l.SetReadDeadline(time.Now().Add(time.Second))
	n, _, err := l.ReadFrom(buf)
	if err != nil || n != 102 {
		t.Fatalf("n=%d err=%v", n, err)
	}
	for i := 0; i < 6; i++ {
		if buf[i] != 0xFF {
			t.Fatal("bad header")
		}
	}
	if buf[6] != 0xaa || buf[101] != 0xff {
		t.Fatal("bad mac payload")
	}
}

func TestNormalizeMAC(t *testing.T) {
	got, err := NormalizeMAC("0:1A:2b:3:4:5")
	if err != nil || got != "00:1a:2b:03:04:05" {
		t.Fatalf("%q %v", got, err)
	}
}
