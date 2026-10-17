package web

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// EnsureSelfSignedCert loads a cached self-signed certificate from
// certPath/keyPath if it's still valid and covers every local IP address,
// generating and caching a fresh one otherwise.
//
// This exists because AudioWorklet and WebCodecs (used for RX audio
// playback) only work in a secure context: HTTPS, or the literal hostname
// "localhost". A LAN IP over plain HTTP doesn't qualify — confirmed live:
// at http://<lan-ip>:8080, window.isSecureContext is false and both APIs
// are simply undefined — so any browser other than one running directly on
// this machine needs HTTPS to hear audio. A self-signed certificate is
// enough: once the browser's one-time warning is accepted, the connection
// still counts as a secure context.
func EnsureSelfSignedCert(certPath, keyPath string) (tls.Certificate, error) {
	ips, err := localIPs()
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("listing local IP addresses: %w", err)
	}

	dir := filepath.Dir(certPath)
	ca, caKey, err := loadOrCreateCA(filepath.Join(dir, "open890rc-ca.pem"), filepath.Join(dir, "open890rc-ca-key.pem"))
	if err != nil {
		return tls.Certificate{}, err
	}

	if cert, err := tls.LoadX509KeyPair(certPath, keyPath); err == nil {
		if leaf, err := x509.ParseCertificate(cert.Certificate[0]); err == nil {
			if time.Now().Add(30*24*time.Hour).Before(leaf.NotAfter) && leaf.CheckSignatureFrom(ca) == nil &&
				coversAllIPs(leaf, ips) && coversAllNames(leaf, dnsNames()) {
				return cert, nil
			}
		}
	}

	return generateServerCert(certPath, keyPath, ips, ca, caKey)
}

// caCertFile is the path of the CA certificate that handleCACert serves (set
// by EnsureSelfSignedCert).
var caCertFile string

// handleCACert serves the public CA certificate (never the key) so a phone or
// another computer can install it once and then trust every server
// certificate signed by it, even after the server certificate is regenerated
// (new IP, expiry). iOS: open the link in Safari, allow the profile, install
// it in Settings, then enable it under General > About > Certificate Trust
// Settings.
func handleCACert(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile(caCertFile)
	if caCertFile == "" || err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/x-x509-ca-cert")
	w.Header().Set("Content-Disposition", `attachment; filename="open890rc-ca.crt"`)
	w.Write(data)
}

// loadOrCreateCA loads the local CA used to sign the server certificate, or
// creates it (10 years) on first start. The CA key stays on this machine.
func loadOrCreateCA(certPath, keyPath string) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	if certPEM, err := os.ReadFile(certPath); err == nil {
		if keyPEM, err := os.ReadFile(keyPath); err == nil {
			cb, _ := pem.Decode(certPEM)
			kb, _ := pem.Decode(keyPEM)
			if cb != nil && kb != nil {
				if ca, err := x509.ParseCertificate(cb.Bytes); err == nil && time.Now().Before(ca.NotAfter) {
					if key, err := x509.ParseECPrivateKey(kb.Bytes); err == nil {
						caCertFile = certPath
						return ca, key, nil
					}
				}
			}
		}
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("generating CA key: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, nil, fmt.Errorf("generating CA serial number: %w", err)
	}
	template := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "open890rc local CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true,
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		return nil, nil, fmt.Errorf("creating CA certificate: %w", err)
	}
	ca, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, err
	}
	keyBytes, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, fmt.Errorf("marshaling CA key: %w", err)
	}
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return nil, nil, fmt.Errorf("writing CA certificate: %w", err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes}), 0o600); err != nil {
		return nil, nil, fmt.Errorf("writing CA key: %w", err)
	}
	caCertFile = certPath
	return ca, key, nil
}

// PreferredLocalIP returns the first non-loopback IPv4 address assigned to
// this machine, for showing the operator a usable URL at startup — falling
// back to "localhost" if none is found (no network, or only loopback/IPv6).
func PreferredLocalIP() string {
	ips, err := localIPs()
	if err != nil {
		return "localhost"
	}
	for _, ip := range ips {
		if ip.IsLoopback() || ip.To4() == nil {
			continue
		}
		return ip.String()
	}
	return "localhost"
}

// dnsNames lists the host names the certificate should be valid for:
// "localhost", this machine's host name ("pi") and "<name>.local" (mDNS), so
// opening https://pi:8080 or https://pi.local:8080 matches the certificate
// (browsers, Safari in particular, are much harsher about a name mismatch
// than about a plain self-signed certificate).
func dnsNames() []string {
	names := []string{"localhost"}
	host, err := os.Hostname()
	if err != nil || host == "" {
		return names
	}
	host = strings.ToLower(host)
	short := host
	if i := strings.IndexByte(short, '.'); i > 0 {
		short = short[:i]
	}
	for _, n := range []string{short, short + ".local", host} {
		dup := false
		for _, have := range names {
			if have == n {
				dup = true
				break
			}
		}
		if !dup && n != "" {
			names = append(names, n)
		}
	}
	return names
}

func coversAllNames(cert *x509.Certificate, names []string) bool {
	for _, want := range names {
		found := false
		for _, have := range cert.DNSNames {
			if strings.EqualFold(have, want) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func coversAllIPs(cert *x509.Certificate, ips []net.IP) bool {
	for _, want := range ips {
		found := false
		for _, have := range cert.IPAddresses {
			if have.Equal(want) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// localIPs returns loopback plus every non-loopback IPv4 address currently
// assigned to this machine, so the generated certificate covers whatever
// LAN IP it's reached on without needing that IP configured up front.
func localIPs() ([]net.IP, error) {
	ips := []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}

	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil, err
	}
	for _, addr := range addrs {
		ipNet, ok := addr.(*net.IPNet)
		if !ok || ipNet.IP.IsLoopback() || ipNet.IP.To4() == nil {
			continue
		}
		ips = append(ips, ipNet.IP)
	}
	return ips, nil
}

func generateServerCert(certPath, keyPath string, ips []net.IP, ca *x509.Certificate, caKey *ecdsa.PrivateKey) (tls.Certificate, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generating key: %w", err)
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generating serial number: %w", err)
	}

	template := x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "open890rc"},
		NotBefore:    time.Now().Add(-time.Hour),
		// Apple rejects server certificates valid for more than 825 days.
		NotAfter:              time.Now().AddDate(0, 0, 800),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              dnsNames(),
		IPAddresses:           ips,
	}

	der, err := x509.CreateCertificate(rand.Reader, &template, ca, &priv.PublicKey, caKey)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("creating certificate: %w", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})

	keyBytes, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("marshaling key: %w", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes})

	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil {
		return tls.Certificate{}, fmt.Errorf("writing cert file: %w", err)
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return tls.Certificate{}, fmt.Errorf("writing key file: %w", err)
	}

	return tls.X509KeyPair(certPEM, keyPEM)
}
