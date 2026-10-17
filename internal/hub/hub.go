// Package hub fans out radio state updates to any number of connected
// browser clients.
package hub

import (
	"sync"
	"sync/atomic"
)

// Hub broadcasts messages to a set of subscribed channels, one per
// connected WebSocket client.
type Hub struct {
	mu      sync.Mutex
	clients map[chan []byte]struct{}
	dropped atomic.Uint64
}

// Dropped counts messages that were not delivered because a client's queue was
// full (a client that does not read fast enough).
func (h *Hub) Dropped() uint64 { return h.dropped.Load() }

// New creates an empty Hub.
func New() *Hub {
	return &Hub{clients: make(map[chan []byte]struct{})}
}

// Subscribe registers a new client and returns the channel it will receive
// broadcasts on. Call Unsubscribe when the client disconnects.
func (h *Hub) Subscribe() chan []byte {
	ch := make(chan []byte, 16)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

// Unsubscribe removes and closes a client channel.
func (h *Hub) Unsubscribe(ch chan []byte) {
	h.mu.Lock()
	delete(h.clients, ch)
	h.mu.Unlock()
	close(ch)
}

// Len reports the current number of subscribed clients, so a caller can
// skip expensive work (like encoding) when nobody would receive it.
func (h *Hub) Len() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

// Broadcast sends msg to every subscribed client. A client that isn't
// keeping up with reads has the message dropped rather than blocking the
// radio's event loop.
func (h *Hub) Broadcast(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients {
		select {
		case ch <- msg:
		default:
			h.dropped.Add(1)
		}
	}
}
