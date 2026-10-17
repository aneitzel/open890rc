package radio

import (
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

var macRe = regexp.MustCompile(`(?i)\b([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\b`)

// NormalizeMAC parses a MAC address and returns it as lower-case, zero-padded
// colon notation ("" for an empty input).
func NormalizeMAC(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", nil
	}
	// net.ParseMAC rejects macOS-style unpadded octets ("0:1a:..."), so pad.
	parts := strings.Split(strings.ReplaceAll(s, "-", ":"), ":")
	if len(parts) == 6 {
		for i, p := range parts {
			if len(p) == 1 {
				parts[i] = "0" + p
			}
		}
	}
	hw, err := net.ParseMAC(strings.Join(parts, ":"))
	if err != nil || len(hw) != 6 {
		return "", fmt.Errorf("invalid MAC address %q", s)
	}
	return hw.String(), nil
}

// LookupMAC reads the MAC address of an IPv4 host from the OS ARP cache
// (Linux /proc/net/arp, otherwise the `arp` tool, which macOS prints without
// leading zeros). Only works for hosts that were recently contacted on the
// local network; returns "" if nothing is found.
func LookupMAC(ip string) string {
	if data, err := os.ReadFile("/proc/net/arp"); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			f := strings.Fields(line)
			if len(f) >= 4 && f[0] == ip {
				if mac, err := NormalizeMAC(f[3]); err == nil && mac != "00:00:00:00:00:00" {
					return mac
				}
			}
		}
		return ""
	}
	out, err := exec.Command("arp", "-n", ip).Output()
	if err != nil {
		return ""
	}
	if m := macRe.FindString(string(out)); m != "" {
		if mac, err := NormalizeMAC(m); err == nil {
			return mac
		}
	}
	return ""
}

// SendWOL sends a Wake-on-LAN magic packet (6x 0xFF + 16x MAC) to UDP port 9
// via the broadcast address of every local interface network containing
// hostIP (plus 255.255.255.255 and the host itself as fallbacks).
func SendWOL(mac, hostIP string) error {
	hw, err := net.ParseMAC(mac)
	if err != nil {
		return fmt.Errorf("invalid MAC address %q", mac)
	}
	pkt := make([]byte, 0, 102)
	for i := 0; i < 6; i++ {
		pkt = append(pkt, 0xFF)
	}
	for i := 0; i < 16; i++ {
		pkt = append(pkt, hw...)
	}

	// Which interface the radio hangs off is found via its IP: every local
	// IPv4 network that contains it gets the packet as a directed broadcast,
	// with the socket bound to THAT interface's own address so the OS can't
	// send it out of a different one (e.g. the default-route interface).
	ip := net.ParseIP(hostIP)
	if ip == nil {
		if ips, err := net.LookupIP(hostIP); err == nil {
			for _, c := range ips {
				if c.To4() != nil {
					ip = c
					break
				}
			}
		}
	}

	sent := 0
	var lastErr error
	send := func(local net.IP, dst string) {
		var laddr *net.UDPAddr
		if local != nil {
			laddr = &net.UDPAddr{IP: local}
		}
		raddr, err := net.ResolveUDPAddr("udp4", net.JoinHostPort(dst, "9"))
		if err != nil {
			lastErr = err
			return
		}
		conn, err := net.DialUDP("udp4", laddr, raddr)
		if err != nil {
			lastErr = err
			return
		}
		defer conn.Close()
		if _, err := conn.Write(pkt); err != nil {
			lastErr = err
			return
		}
		sent++
		log.Printf("radio: wake-on-lan sent to %s:9 (from %v)", dst, local)
	}

	if ip != nil {
		if addrs, err := net.InterfaceAddrs(); err == nil {
			for _, a := range addrs {
				n, ok := a.(*net.IPNet)
				if !ok || n.IP.To4() == nil || !n.Contains(ip) {
					continue
				}
				b := make(net.IP, 4)
				for i := range b {
					b[i] = n.IP.To4()[i] | ^n.Mask[len(n.Mask)-4+i]
				}
				send(n.IP.To4(), b.String())
			}
		}
		send(nil, ip.String()) // unicast, works if the radio is still in the ARP cache
	}
	if sent == 0 {
		send(nil, "255.255.255.255") // last resort: no local network contains the radio's IP
	}
	if sent == 0 {
		return fmt.Errorf("sending wake-on-lan packet failed: %v", lastErr)
	}
	return nil
}
