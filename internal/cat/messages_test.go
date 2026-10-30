package cat

import "testing"

func TestVoipLevel(t *testing.T) {
	if c := EncodeVoipLevelQuery(false); c != "##KN30" {
		t.Fatal(c)
	}
	if c := EncodeVoipLevelQuery(true); c != "##KN31" {
		t.Fatal(c)
	}
	if c, err := EncodeVoipLevel(false, 49); err != nil || c != "##KN30049" {
		t.Fatal(c, err)
	}
	if c, err := EncodeVoipLevel(true, 0); err != nil || c != "##KN31000" {
		t.Fatal(c, err)
	}
	if c, err := EncodeVoipLevel(false, 100); err != nil || c != "##KN30100" {
		t.Fatal(c, err)
	}
	if _, err := EncodeVoipLevel(false, 101); err == nil {
		t.Fatal("level 101 must fail")
	}
	if _, err := EncodeVoipLevel(false, -1); err == nil {
		t.Fatal("negative level must fail")
	}
	if out, level, err := ParseVoipLevel("##KN30049"); err != nil || out || level != 49 {
		t.Fatal(out, level, err)
	}
	if out, level, err := ParseVoipLevel("##KN31075"); err != nil || !out || level != 75 {
		t.Fatal(out, level, err)
	}
	for _, bad := range []string{"##KN3049", "##KN20049", "##KN3249", "##KN300049"} {
		if _, _, err := ParseVoipLevel(bad); err == nil {
			t.Fatalf("%q should not parse", bad)
		}
	}
}

func TestParseTXFilterEdge(t *testing.T) {
	cases := []struct {
		msg  string
		edge TXFilterEdge
		hz   int
	}{
		{"EX00606 000", TXFilterLowSSB, 10},
		{"EX00606 005", TXFilterLowSSB, 500},
		{"EX00607 005", TXFilterHighSSB, 3000},
		{"EX00607 007", TXFilterHighSSB, 4000},
		{"EX00608 001", TXFilterLowData, 100},
		{"EX00609 000", TXFilterHighData, 2500},
	}
	for _, c := range cases {
		edge, hz, err := ParseTXFilterEdge(c.msg)
		if err != nil || edge != c.edge || hz != c.hz {
			t.Errorf("%q = %v, %d, %v", c.msg, edge, hz, err)
		}
	}
	for _, bad := range []string{"EX00606 006", "EX00611 001", "EX00610 000", "EX00606"} {
		if _, _, err := ParseTXFilterEdge(bad); err == nil {
			t.Errorf("%q must not parse", bad)
		}
	}
}
