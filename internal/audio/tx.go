// tx.go sends the browser's mic audio to the radio as RTP-framed UDP,
// matching the format open890 uses for TX voice (lib/open890/tcp_client.ex,
// make_tx_voip_packet): 320 samples (20ms) of 16-bit PCM per packet,
// attenuated, converted to unsigned, big-endian, and wrapped in an RTP
// header shaped like RX's but with a fixed zero timestamp — verified
// against open890's source, not independently confirmed live (that needs an
// actual over-the-air test, which only the operator can do).
package audio

import (
	"encoding/binary"
	"fmt"
	"math"
	"net"
	"sync"
)

const (
	// TXFrameSamples is the number of samples per TX packet (20ms at
	// 16kHz), matching the radio's own RX audio framing and open890's TX
	// implementation.
	TXFrameSamples = 320

	// TXAttenuation scales each sample down before sending: the radio's mic
	// input expects a much lower amplitude than a full-scale PCM signal.
	// Matches open890's own factor exactly. Diagnosing what first looked
	// like a level problem (crackle/dropouts) took a long detour through
	// this value before landing on the real cause — real mic input clipping
	// in the browser capture path, since fixed with a proper gain/limiter
	// stage there (see audio.js, ensureMicCapture) — so there's no reason
	// left to deviate from open890's own calibration here.
	TXAttenuation = 0.01

	// txSrcPort is the local UDP port TX audio is sent from — matches
	// open890's own choice; whether the radio actually requires this
	// specific source port isn't independently confirmed, but there's no
	// reason to risk deviating from a known-working value. The destination
	// port (the radio's own VoIP port, the same one it sends RX audio FROM,
	// used bidirectionally) is caller-supplied now instead of a hardcoded
	// constant — see NewTXSender — since it's user-configurable (KNS VoIP
	// port, default 60001).
	txSrcPort = 60002

	txSSRC = 0x38393000
)

// TXSender streams mic audio to the radio over UDP, RTP-framed the way the
// radio's own TX audio ingest expects. Send is safe for concurrent use
// (guarded by mu) — found the hard way live: an earlier diagnostic test
// tone feature and real mic audio both called Send on the same TXSender
// with no coordination above this layer, and without a lock here, two
// goroutines racing on the bare seq++ interleaved their packets onto the
// wire in an unpredictable order, sounding exactly like random audio
// dropouts. That diagnostic feature is gone now, but the same lesson as
// radio.Conn's write mutex applies generally: don't leave a shared
// resource's writes unserialized just because today's callers happen not
// to overlap.
type TXSender struct {
	conn *net.UDPConn
	mu   sync.Mutex
	seq  uint16
}

// NewTXSender opens the local UDP socket and targets it at the radio's
// address (dstPort: the KNS VoIP port, default 60001, same one used
// bidirectionally for RX audio) for sending TX audio.
func NewTXSender(radioIP string, dstPort int) (*TXSender, error) {
	raddr, err := net.ResolveUDPAddr("udp", fmt.Sprintf("%s:%d", radioIP, dstPort))
	if err != nil {
		return nil, fmt.Errorf("resolving radio TX audio address: %w", err)
	}
	conn, err := net.DialUDP("udp", &net.UDPAddr{Port: txSrcPort}, raddr)
	if err != nil {
		return nil, fmt.Errorf("opening TX audio socket: %w", err)
	}
	return &TXSender{conn: conn}, nil
}

// Send takes exactly TXFrameSamples of signed 16-bit PCM and sends one RTP
// packet to the radio.
func (t *TXSender) Send(samples []int16) error {
	if len(samples) != TXFrameSamples {
		return fmt.Errorf("TX audio frame must be %d samples, got %d", TXFrameSamples, len(samples))
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	packet := make([]byte, rtpHeaderSize+len(samples)*2)
	packet[0] = 0x80 // V=2, P=0, X=0, CC=0
	packet[1] = 96   // M=0, PT=96
	binary.BigEndian.PutUint16(packet[2:4], t.seq)
	// packet[4:8] (timestamp) stays zero, matching open890 exactly.
	binary.BigEndian.PutUint32(packet[8:12], txSSRC)
	t.seq++

	for i, s := range samples {
		// Rounded, not truncated: attenuating by ~0.01 already leaves only
		// ~6-7 bits of the original 16-bit resolution, so truncating toward
		// zero on top of that (open890's own approach, via Elixir's `trunc`)
		// adds avoidable quantization distortion in an already narrow range
		// — round-to-nearest at least uses that narrow range as accurately
		// as possible.
		scaled := int32(math.Round(float64(s) * TXAttenuation))
		binary.BigEndian.PutUint16(packet[rtpHeaderSize+i*2:], uint16(scaled+32768))
	}

	_, err := t.conn.Write(packet)
	return err
}

// Close stops the sender.
func (t *TXSender) Close() error { return t.conn.Close() }

// TXFramer regroups arbitrarily-sized sample chunks (a browser audio block,
// or a decoded Opus packet — neither necessarily lines up with the radio's
// required 320-sample framing) into exact TXFrameSamples-sized groups,
// buffering any remainder for the next call. Not safe for concurrent use.
type TXFramer struct {
	buf []int16
}

// NewTXFramer creates an empty framer.
func NewTXFramer() *TXFramer {
	return &TXFramer{}
}

// Push appends samples and calls emit once for every complete
// TXFrameSamples-sized group now available. emit's slice is only valid for
// the duration of the call.
func (f *TXFramer) Push(samples []int16, emit func([]int16)) {
	f.buf = append(f.buf, samples...)
	for len(f.buf) >= TXFrameSamples {
		emit(f.buf[:TXFrameSamples])
		f.buf = f.buf[TXFrameSamples:]
	}
}
