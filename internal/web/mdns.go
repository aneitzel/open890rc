package web

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"strconv"
	"strings"
	"time"
)

// mdnsReverse asks the local network by multicast DNS (what Apple devices and
// avahi/Bonjour answer) which name belongs to an IPv4 address, e.g. an iPhone
// that the router's DNS has no reverse entry for. Returns "" if nobody answers
// within the context's deadline. IPv4 only.
func mdnsReverse(ctx context.Context, ip string) string {
	parsed := net.ParseIP(ip).To4()
	if parsed == nil {
		return ""
	}
	qname := strings.Join([]string{
		itoa(parsed[3]), itoa(parsed[2]), itoa(parsed[1]), itoa(parsed[0]), "in-addr", "arpa",
	}, ".")
	query := buildPTRQuery(qname)

	conn, err := net.ListenPacket("udp4", ":0")
	if err != nil {
		return ""
	}
	defer conn.Close()
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(400 * time.Millisecond)
	}
	_ = conn.SetDeadline(deadline)
	dst := &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: 5353}
	if _, err := conn.WriteTo(query, dst); err != nil {
		return ""
	}
	buf := make([]byte, 1500)
	for {
		n, from, err := conn.ReadFrom(buf)
		if err != nil {
			return ""
		}
		// only an answer from the device itself counts
		if u, ok := from.(*net.UDPAddr); ok && !u.IP.Equal(parsed) {
			continue
		}
		if name, err := parsePTRAnswer(buf[:n]); err == nil && name != "" {
			return strings.TrimSuffix(name, ".")
		}
	}
}

func itoa(b byte) string { return strconv.Itoa(int(b)) }

// buildPTRQuery is a standard DNS query message (one question, PTR/IN) with the
// "unicast response" bit set, so the device answers straight back to us.
func buildPTRQuery(name string) []byte {
	msg := make([]byte, 12, 64)
	binary.BigEndian.PutUint16(msg[4:], 1) // QDCOUNT
	for _, label := range strings.Split(name, ".") {
		msg = append(msg, byte(len(label)))
		msg = append(msg, label...)
	}
	msg = append(msg, 0)
	msg = binary.BigEndian.AppendUint16(msg, 12)     // type PTR
	msg = binary.BigEndian.AppendUint16(msg, 0x8001) // class IN + unicast-response
	return msg
}

// parsePTRAnswer returns the target of the first PTR record in the answer section.
func parsePTRAnswer(msg []byte) (string, error) {
	if len(msg) < 12 {
		return "", errors.New("short message")
	}
	qd := int(binary.BigEndian.Uint16(msg[4:]))
	an := int(binary.BigEndian.Uint16(msg[6:]))
	off := 12
	var err error
	for i := 0; i < qd; i++ {
		if _, off, err = readDNSName(msg, off); err != nil {
			return "", err
		}
		off += 4
	}
	for i := 0; i < an; i++ {
		if _, off, err = readDNSName(msg, off); err != nil {
			return "", err
		}
		if off+10 > len(msg) {
			return "", errors.New("truncated record")
		}
		typ := binary.BigEndian.Uint16(msg[off:])
		rdlen := int(binary.BigEndian.Uint16(msg[off+8:]))
		off += 10
		if off+rdlen > len(msg) {
			return "", errors.New("truncated rdata")
		}
		if typ == 12 {
			name, _, err := readDNSName(msg, off)
			return name, err
		}
		off += rdlen
	}
	return "", errors.New("no PTR answer")
}

// readDNSName decodes a (possibly compressed) domain name starting at off and
// returns it with the offset just after the name in the original position.
func readDNSName(msg []byte, off int) (string, int, error) {
	var labels []string
	next := -1
	for hops := 0; hops < 20; hops++ {
		if off >= len(msg) {
			return "", 0, errors.New("name out of range")
		}
		l := int(msg[off])
		switch {
		case l == 0:
			if next < 0 {
				next = off + 1
			}
			return strings.Join(labels, ".") + ".", next, nil
		case l&0xC0 == 0xC0:
			if off+1 >= len(msg) {
				return "", 0, errors.New("bad pointer")
			}
			if next < 0 {
				next = off + 2
			}
			off = (l&0x3F)<<8 | int(msg[off+1])
		default:
			if off+1+l > len(msg) {
				return "", 0, errors.New("label out of range")
			}
			labels = append(labels, string(msg[off+1:off+1+l]))
			off += 1 + l
		}
	}
	return "", 0, errors.New("too many compression hops")
}
