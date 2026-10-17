// Package config keeps the settings the server remembers across restarts in
// ONE file instead of one file per feature: a JSON object with one section per
// feature ("kns", "spe", "proc", "eq"). The sections stay opaque to this
// package — each feature keeps marshalling its own struct, the store only
// moves the bytes. Users are not part of it (password hashes, own file).
package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
)

// Store is safe for concurrent use: features save from different goroutines
// (browser actions, radio events).
type Store struct {
	mu       sync.Mutex
	path     string
	sections map[string]json.RawMessage
}

// Open reads path if it exists. A missing file is normal (first start); an
// unreadable or corrupt one is moved aside to <path>.bad so the next save does
// not silently destroy it.
func Open(path string) *Store {
	s := &Store{path: path, sections: map[string]json.RawMessage{}}
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("config: reading %s failed: %v", path, err)
		}
		return s
	}
	if err := json.Unmarshal(data, &s.sections); err != nil || s.sections == nil {
		bad := path + ".bad"
		log.Printf("config: %s is not valid JSON (%v), keeping it as %s and starting empty", path, err, bad)
		_ = os.Rename(path, bad)
		s.sections = map[string]json.RawMessage{}
	}
	return s
}

// Read returns the saved bytes of a section, if there are any.
func (s *Store) Read(section string) ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, ok := s.sections[section]
	return raw, ok
}

// Write replaces one section and saves the whole file.
func (s *Store) Write(section string, data []byte) error {
	if !json.Valid(data) {
		return fmt.Errorf("config section %q: not valid JSON", section)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sections[section] = json.RawMessage(bytes.TrimSpace(data))
	return s.saveLocked()
}

// saveLocked writes a temporary file next to the real one and renames it, so a
// crash or power loss leaves either the old or the new file, never half of one.
// 0600: the "kns" section contains the radio password.
func (s *Store) saveLocked() error {
	data, err := json.MarshalIndent(s.sections, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	dir := filepath.Dir(s.path)
	tmp, err := os.CreateTemp(dir, filepath.Base(s.path)+".tmp*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	cleanup := func() { _ = os.Remove(name) }
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(name, s.path); err != nil {
		cleanup()
		return err
	}
	return nil
}
