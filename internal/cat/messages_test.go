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
