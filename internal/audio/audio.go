// Package audio receives the TS-890's RX audio stream over LAN: RTP-framed
// UDP packets carrying mono 16-bit signed PCM at 16kHz, sent once the radio
// is told to start streaming (the "##VP1" CAT command).
package audio

import (
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"sync/atomic"
	"time"
)

const (
	// DefaultPort is the UDP port open890 also listens on for the radio's
	// RX audio stream; the radio sends here once ##VP1/##VP2 is sent on the
	// CAT connection, using the same source IP as the login.
	DefaultPort = 60001

	// SampleRate is the TS-890's RX audio sample rate over LAN. It's fixed
	// regardless of the ##VP1 (high) vs ##VP2 (low) quality selection.
	SampleRate = 16000

	// rtpHeaderSize is the fixed 12-byte RTP header (no CSRC list, which the
	// radio doesn't use): version/padding/extension/CC, marker/payload
	// type, sequence number, timestamp, SSRC.
	rtpHeaderSize = 12

	// A sequence number this far (in packets, 20 ms each) from the expected
	// one cannot be loss or reordering: the radio restarted its stream.
	restartJump = 1000
	// This many out-of-order packets in a row also mean a restarted stream.
	restartStale = 10
)

// Receiver listens for the radio's RTP audio stream on a UDP socket.
type Receiver struct {
	conn *net.UDPConn

	// lost counts RTP sequence number gaps seen since this Receiver was
	// created — a genuine "the radio's stream lost packets on the wire"
	// signal, independent of anything the browser's own playback buffer
	// does. Added live (2026-09-28) as a diagnostic after a report of
	// scratchy RX audio, to tell a real network/radio-side loss apart from
	// client-side causes (the browser ring buffer's own trimming, etc.).
	lost    atomic.Uint64
	seqSeen bool
	nextSeq uint16
	// stale counts the consecutive out-of-order packets (readLoop goroutine
	// only), see trackSequence.
	stale int
	// reordered counts packets whose sequence number was BEHIND what was
	// already expected — arrived out of order, or a duplicate. Added
	// 2026-10-12: a "Klatschen" report where neither of the two existing
	// diagnostics (this gap-timing log and the lost-packet counter above)
	// showed anything, yet the clapping was real and reproducible, and only
	// a radio-side ##VP0/##VP1 restart fixed it — a plain browser reload,
	// which rebuilds the entire client-side audio pipeline from scratch,
	// did NOT. That rules out a purely client-side cause (a fresh pipeline
	// would have cleared any stale client state) and points at something on
	// the UDP leg that neither existing counter can see: trackSequence only
	// ever checked gap>0 (packets skipped ahead = loss) — a packet arriving
	// BEHIND the expected sequence (reordering, or a duplicate) fell
	// through uncounted. Worse, the old code unconditionally set
	// nextSeq=seq+1 on every packet regardless of order, so a single
	// out-of-order packet would silently rewind nextSeq and could trigger a
	// bogus "lost" count on the very next (actually perfectly normal)
	// packet. Both the blind spot and that corruption are fixed together
	// below.
	reordered atomic.Uint64

	// resetRequested is set by ResetLoss (called from the "reset RX audio"
	// button's goroutine, NOT the readLoop goroutine that owns seqSeen/
	// nextSeq) and consumed by trackSequence on its own goroutine — keeps
	// every mutation of those two non-atomic fields confined to the single
	// readLoop goroutine that already owned them, instead of a second
	// goroutine reaching in and racing with it directly.
	resetRequested atomic.Bool
}

// Listen opens a UDP socket on port and starts reading in the background.
// onPCM is called from that goroutine for each packet's payload (raw mono
// 16-bit signed PCM, little-endian, exactly as the radio sends it) with a
// fresh slice the callee may retain; it must not block.
func Listen(port int, onPCM func(pcm []byte)) (*Receiver, error) {
	conn, err := net.ListenUDP("udp", &net.UDPAddr{Port: port})
	if err != nil {
		return nil, fmt.Errorf("listening for radio audio on UDP port %d: %w", port, err)
	}

	r := &Receiver{conn: conn}
	go r.readLoop(onPCM)
	return r, nil
}

// Arrival-time diagnostic (2026-10-11, for the returning "Klatschen"): the radio
// sends one packet every 20 ms. A gap well above that between two packets as
// they arrive HERE means the stream stalls on the way TS-890 -> server (radio,
// cable/switch, this machine's network stack); no gaps here but trouble in the
// browser points at server -> browser or the browser itself. Reported at most
// once per window, and only when something happened.
const (
	gapWarn    = 60 * time.Millisecond
	gapWindow  = 10 * time.Second
	gapMinLogs = 1
)

func (r *Receiver) readLoop(onPCM func(pcm []byte)) {
	buf := make([]byte, 2048)
	var (
		last, windowStart time.Time
		maxGap            time.Duration
		gaps              int
		lostAtWindow      uint64
		reorderedAtWindow uint64
	)
	for {
		n, err := r.conn.Read(buf)
		if err != nil {
			return
		}
		now := time.Now()
		if windowStart.IsZero() {
			windowStart, lostAtWindow, reorderedAtWindow = now, r.lost.Load(), r.reordered.Load()
		}
		if !last.IsZero() {
			// a pause of several seconds is the stream being switched off and on (no browser client
			// connected), not a network gap
			if g := now.Sub(last); g > gapWarn && g < 5*time.Second {
				gaps++
				if g > maxGap {
					maxGap = g
				}
			}
		}
		last = now
		if now.Sub(windowStart) >= gapWindow {
			lost := sinceWindowStart(r.lost.Load(), lostAtWindow)
			reordered := sinceWindowStart(r.reordered.Load(), reorderedAtWindow)
			if gaps >= gapMinLogs || lost > 0 || reordered > 0 {
				log.Printf("audio: RX stream from the radio, last %d s: %d gaps over %d ms between packets (longest %d ms), %d packets lost, %d packets out of order/duplicate",
					int(now.Sub(windowStart).Seconds()), gaps, gapWarn.Milliseconds(), maxGap.Milliseconds(), lost, reordered)
			}
			windowStart, lostAtWindow, reorderedAtWindow, gaps, maxGap = now, r.lost.Load(), r.reordered.Load(), 0, 0
		}
		if n <= rtpHeaderSize {
			continue
		}
		if !r.trackSequence(binary.BigEndian.Uint16(buf[2:4])) {
			// Out of order / duplicate (see trackSequence) — forwarding it
			// would play a stale or misordered frame right now, an audible
			// glitch. Dropping it instead just leaves a tiny gap, which the
			// browser ring buffer already handles smoothly (its existing
			// underrun declick fade, see pcm-player-processor.js).
			continue
		}
		payload := make([]byte, n-rtpHeaderSize)
		copy(payload, buf[rtpHeaderSize:n])
		onPCM(payload)
	}
}

// sinceWindowStart computes how much a counter grew since the start of the
// current 10s log window, guarding against ResetLoss() zeroing the counter
// from a different goroutine partway through that window (the "reset RX
// audio" button). A plain `current - atWindowStart` would underflow the
// uint64 subtraction into a huge wrapped value in that case — exactly what a
// live report (2026-10-12) showed: "18446744073709551545 packets out of
// order/duplicate" is precisely 2^64 minus the 71 the previous window had
// already logged, i.e. the counter really did reset to 0 mid-window and the
// raw subtraction wrapped around. Treating "counter now below where this
// window started" as "it was reset, so just report what's accumulated
// since" avoids the wrap without needing readLoop and ResetLoss to
// coordinate any more tightly than they already do.
func sinceWindowStart(current, atWindowStart uint64) uint64 {
	if current < atWindowStart {
		return current
	}
	return current - atWindowStart
}

// trackSequence updates the lost/reordered-packet counters from one packet's
// RTP sequence number and reports whether the caller should forward this
// packet's payload (false for an out-of-order/duplicate one — see the
// reordered field's own comment for why those are dropped rather than
// forwarded). Sequence numbers are a 16-bit counter that wraps around;
// casting the (wrapping) uint16 difference to int16 reinterprets it as a
// signed distance, the standard trick for comparing sequence numbers across
// a wraparound (same idea TCP/RTP implementations use).
func (r *Receiver) trackSequence(seq uint16) bool {
	if r.resetRequested.CompareAndSwap(true, false) {
		r.seqSeen = false
	}
	if !r.seqSeen {
		r.seqSeen = true
		r.nextSeq = seq + 1
		return true
	}
	gap := int16(seq - r.nextSeq)
	if gap > restartJump || gap < -restartJump {
		// Far from where the stream should be: the radio started a NEW
		// stream with another sequence number base (after ##VP0/##VP1, the
		// auto sync). Live (2026-10-17): a +21039 jump was counted as 21039
		// lost packets, and when the next restart began at a lower number,
		// every packet looked "behind" and was dropped for about a minute
		// until the numbers caught up — the RX audio was gone for that long.
		// Follow the new numbering instead (not a loss, nothing dropped).
		r.stale = 0
		r.nextSeq = seq + 1
		log.Printf("audio: RX stream from the radio restarted (sequence number jumped by %d)", gap)
		return true
	}
	if gap < 0 {
		// Behind what we already expected: out of order, or a duplicate.
		// Does NOT advance nextSeq — the packet(s) we were actually waiting
		// for haven't arrived yet (or already have), so treating this one
		// as "next" would desync the counter from the real stream position.
		// But real reordering never produces a long run of them: that is a
		// stream that continues at a slightly lower number, so follow it.
		r.stale++
		if r.stale >= restartStale {
			r.stale = 0
			r.nextSeq = seq + 1
			log.Printf("audio: RX stream from the radio continues at a lower sequence number, following it")
			return true
		}
		r.reordered.Add(1)
		return false
	}
	r.stale = 0
	if gap > 0 {
		r.lost.Add(uint64(gap))
	}
	r.nextSeq = seq + 1
	return true
}

// LostPackets reports the number of RTP sequence gaps seen so far.
func (r *Receiver) LostPackets() uint64 { return r.lost.Load() }

// ReorderedPackets reports the number of packets seen so far whose sequence
// number was behind what was already expected (arrived out of order, or a
// duplicate) — see the reordered field's own comment.
func (r *Receiver) ReorderedPackets() uint64 { return r.reordered.Load() }

// ResetLoss zeroes the lost-packet and reordered-packet counters and re-arms
// sequence tracking to treat the next packet as the first one seen — for a
// deliberate stream restart (e.g. the "##VP0" then "##VP1" reset button
// toggling the radio's own RTP sender off and on), where the resulting
// sequence-number jump is expected and not a real loss, and any older
// accumulated count is no longer relevant to "is there a problem right
// now". Safe to call from any goroutine — see resetRequested's comment.
func (r *Receiver) ResetLoss() {
	r.lost.Store(0)
	r.reordered.Store(0)
	r.resetRequested.Store(true)
}

// Close stops the receiver.
func (r *Receiver) Close() error { return r.conn.Close() }
