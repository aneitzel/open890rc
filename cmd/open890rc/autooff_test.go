package main

import "testing"

func TestIsAutoOffNoise(t *testing.T) {
	noise := []string{"SM0012", "RM10005", "RM20000", "RM40020", "BY0", "BY1", "PS", "PS1"}
	for _, msg := range noise {
		if !isAutoOffNoise(msg) {
			t.Errorf("isAutoOffNoise(%q) = false, want true", msg)
		}
	}
	activity := []string{"FA00014074000", "FB00007100000", "OM01", "MD2", "NR1", "NB10", "BC1", "RA2", "AC111", "TX1", "RX"}
	for _, msg := range activity {
		if isAutoOffNoise(msg) {
			t.Errorf("isAutoOffNoise(%q) = true, want false", msg)
		}
	}
}
