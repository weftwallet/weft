package pseudonym_test

import (
	"encoding/json"
	"testing"

	"github.com/ifeanyi-ugwu/weft/examples/private-ballot-contract/pseudonym"
)

// FuzzDecode: parsing and decoding pseudonymJson never panics, refuses
// with one of the contract's messages, and what decodes encodes back to the
// same fields.
func FuzzDecode(f *testing.F) {
	v := loadVectorsFile()
	for _, p := range v.Positive {
		f.Add(p.PseudonymJSON)
	}
	for _, n := range v.Negative {
		f.Add(n.PseudonymJSON)
	}
	f.Fuzz(func(t *testing.T, text string) {
		proof, err := parse(text)
		if err != nil {
			if err.Error() == "" {
				t.Fatal("an empty message")
			}
			return
		}
		var j pseudonym.JSON
		if err := json.Unmarshal([]byte(text), &j); err != nil {
			t.Fatalf("decoded what encoding/json can't read: %v", err)
		}
		if proof.JSON() != j {
			t.Fatalf("decoding doesn't round-trip: %+v, %+v", proof.JSON(), j)
		}
	})
}

// FuzzDecodePoint: a 64-byte string decodes only to a point that encodes
// back to it.
func FuzzDecodePoint(f *testing.F) {
	v := loadVectorsFile()
	for _, p := range v.Positive {
		f.Add([]byte(p.P))
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		g, ok := pseudonym.DecodePoint(b)
		if !ok {
			return
		}
		if got := pseudonym.EncodePoint(g); string(got) != string(b) {
			t.Fatalf("%x decodes to a point that encodes as %x", b, got)
		}
	})
}
