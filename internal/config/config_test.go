package config

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// compact removes the indentation the file gets on disk.
func compact(b []byte) string {
	var out bytes.Buffer
	if err := json.Compact(&out, b); err != nil {
		return string(b)
	}
	return out.String()
}

func TestPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")

	s := Open(path)
	if _, ok := s.Read("spe"); ok {
		t.Fatal("missing section must report no data")
	}
	if err := s.Write("spe", []byte(`{"port":"/dev/ttyUSB0","auto":true}`)); err != nil {
		t.Fatal(err)
	}
	if err := s.Write("proc", []byte(`{"proc":"on"}`)); err != nil {
		t.Fatal(err)
	}

	s2 := Open(path)
	if d, ok := s2.Read("spe"); !ok || compact(d) != `{"port":"/dev/ttyUSB0","auto":true}` {
		t.Fatalf("spe after reopen: %q %v", d, ok)
	}
	if d, ok := s2.Read("proc"); !ok || compact(d) != `{"proc":"on"}` {
		t.Fatalf("proc after reopen: %q %v", d, ok)
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v, want 0600", fi.Mode().Perm())
	}
}

func TestCorruptFileKeptAside(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	os.WriteFile(path, []byte("{broken"), 0o600)
	s := Open(path)
	if _, ok := s.Read("kns"); ok {
		t.Fatal("corrupt file must start empty")
	}
	if _, err := os.Stat(path + ".bad"); err != nil {
		t.Fatal("corrupt file should be kept as .bad")
	}
}

func TestConcurrentWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	s := Open(path)
	var wg sync.WaitGroup
	for _, sec := range []string{"kns", "spe", "proc", "eq"} {
		wg.Add(1)
		go func(sec string) {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				if err := s.Write(sec, []byte(`{"n":1}`)); err != nil {
					t.Error(err)
				}
			}
		}(sec)
	}
	wg.Wait()
	s2 := Open(path)
	for _, sec := range []string{"kns", "spe", "proc", "eq"} {
		if _, ok := s2.Read(sec); !ok {
			t.Fatalf("section %s lost", sec)
		}
	}
}
