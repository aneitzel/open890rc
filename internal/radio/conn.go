package radio

import (
	"fmt"
	"log"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

const (
	DefaultPort    = 60000
	connectTimeout = 5 * time.Second
	keepaliveEvery = 5 * time.Second
)

// Conn manages a single KNS TCP session with the radio: login, keepalive,
// and dispatch of incoming messages to a handler.
type Conn struct {
	conn     net.Conn
	creds    Credentials
	onMsg    func(msg string)
	onClose  func()
	loggedIn chan error

	// writeMu serializes writes to conn: the login handshake, the keepalive
	// ticker, and browser-triggered commands all call send from different
	// goroutines, and concurrent writes to the same TCP socket can interleave
	// mid-command.
	writeMu sync.Mutex

	// closing is set by Close() before it actually closes the socket, so
	// readLoop/keepaliveLoop can tell an intentional disconnect (the
	// operator's "Trennen" button) apart from an unexpected one (radio
	// powered off, network gone) when their blocking Read/Write calls
	// unblock with an error a moment later. Live-reported (2026-09-28): a
	// deliberate disconnect logged "connection closed"/"keepalive failed"
	// lines that read like something had gone wrong, when it was the
	// expected result of the operator's own click.
	closing atomic.Bool
}

// Dial connects to the radio at addr (host:port) and performs the KNS login.
// onMsg is called for every complete message received after login (not
// including the ##CN/##ID handshake itself). onClose, if not nil, is called
// once when the connection drops (radio powered off, network gone, etc.), so
// a caller tracking "are we connected" can find out without polling. It
// blocks until login succeeds or fails, then keeps the keepalive loop
// running in the background.
func Dial(addr string, creds Credentials, onMsg func(msg string), onClose func()) (*Conn, error) {
	return DialTimeout(addr, creds, onMsg, onClose, connectTimeout, connectTimeout)
}

// DialTimeout is Dial with separate timeouts for the TCP connect and the
// login. Short connect timeouts suit a radio that is still waking up (the OS
// retransmits a lost SYN with exponentially growing gaps, so one long attempt
// reacts much later than several short ones), while the login on an
// accepted connection may take longer while the radio boots.
func DialTimeout(addr string, creds Credentials, onMsg func(msg string), onClose func(), connectTO, loginTO time.Duration) (*Conn, error) {
	nc, err := net.DialTimeout("tcp", addr, connectTO)
	if err != nil {
		return nil, fmt.Errorf("connecting to radio at %s: %w", addr, err)
	}

	c := &Conn{
		conn:     nc,
		creds:    creds,
		onMsg:    onMsg,
		onClose:  onClose,
		loggedIn: make(chan error, 1),
	}

	go c.readLoop()

	if err := c.send("##CN"); err != nil {
		nc.Close()
		return nil, fmt.Errorf("sending ##CN: %w", err)
	}

	select {
	case err := <-c.loggedIn:
		if err != nil {
			nc.Close()
			return nil, err
		}
	case <-time.After(loginTO):
		nc.Close()
		return nil, fmt.Errorf("login to radio timed out")
	}

	go c.keepaliveLoop()

	return c, nil
}

// Send writes a single command to the radio, appending the trailing ";".
func (c *Conn) Send(cmd string) error {
	return c.send(cmd)
}

func (c *Conn) send(cmd string) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err := c.conn.Write([]byte(cmd + ";"))
	return err
}

// Close terminates the TCP connection.
func (c *Conn) Close() error {
	c.closing.Store(true)
	return c.conn.Close()
}

// LocalAddr returns the local (server-side) address of the TCP connection,
// e.g. for logging which of this machine's own interfaces/IPs a session
// went out on.
func (c *Conn) LocalAddr() string {
	return c.conn.LocalAddr().String()
}

func (c *Conn) readLoop() {
	buf := make([]byte, 4096)
	var pending string

	for {
		n, err := c.conn.Read(buf)
		if err != nil {
			if !c.closing.Load() {
				log.Printf("radio: connection closed: %v", err)
			}
			if c.onClose != nil {
				c.onClose()
			}
			return
		}

		var complete []string
		complete, pending = splitMessages(pending + string(buf[:n]))

		for _, msg := range complete {
			c.handle(msg)
		}
	}
}

func (c *Conn) handle(msg string) {
	switch {
	case msg == "##CN0":
		c.loggedIn <- fmt.Errorf("KNS connection refused: already in use by another application")
	case msg == "##CN1":
		if err := c.send("##ID" + c.creds.loginString()); err != nil {
			c.loggedIn <- fmt.Errorf("sending ##ID: %w", err)
		}
	case msg == "##ID1":
		c.loggedIn <- nil
	case msg == "##ID0":
		c.loggedIn <- fmt.Errorf("login rejected: incorrect username or password")
	default:
		if c.onMsg != nil {
			c.onMsg(msg)
		}
	}
}

func (c *Conn) keepaliveLoop() {
	ticker := time.NewTicker(keepaliveEvery)
	defer ticker.Stop()
	for range ticker.C {
		if err := c.send("PS"); err != nil {
			if !c.closing.Load() {
				log.Printf("radio: keepalive failed: %v", err)
			}
			return
		}
	}
}
