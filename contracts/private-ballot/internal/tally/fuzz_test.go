package tally

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// The decoders take arguments from anyone in the channel. They must refuse
// with a contract message or accept, and never panic. go test runs the seed
// corpus; go test -fuzz=FuzzParseBallot runs the fuzzer.

func seeds(f *testing.F, kind string) {
	b, err := os.ReadFile(filepath.Join(vectorsDir, "negative.json"))
	if err != nil {
		f.Fatal(err)
	}
	var v struct {
		Negative []negativeVector `json:"negative"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		f.Fatal(err)
	}
	for _, c := range v.Negative {
		if c.Kind == kind && c.JSON != "" {
			f.Add(c.JSON)
		}
	}
	f.Add("")
	f.Add("{}")
	f.Add(`{"v":1e400}`)
}

func refusedOrAccepted(t *testing.T, err error) {
	var te *Error
	if err != nil && !errors.As(err, &te) {
		t.Fatalf("not a contract refusal: %v", err)
	}
}

// allElections reads the elections in context.json.
func allElections(tb testing.TB) map[string]*Prepared {
	b, err := os.ReadFile(filepath.Join(vectorsDir, "context.json"))
	if err != nil {
		tb.Fatal(err)
	}
	var v struct {
		Elections []electionVector `json:"elections"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		tb.Fatal(err)
	}
	ps := map[string]*Prepared{}
	for _, e := range v.Elections {
		p, err := Prepare(&Election{Setup: e.Setup, Keys: e.Keys})
		if err != nil {
			tb.Fatal(err)
		}
		ps[e.Name] = p
	}
	return ps
}

func fuzzElection(tb testing.TB) *Prepared { return allElections(tb)["budget-2027"] }

func FuzzParseBallot(f *testing.F) {
	seeds(f, "ballot")
	p := fuzzElection(f)
	tag := make([]byte, 32)
	f.Fuzz(func(t *testing.T, text string) {
		_, err := CheckBallot(p, tag, text, newLedger(nil, nil), false)
		refusedOrAccepted(t, err)
	})
}

func FuzzCheckRound1(f *testing.F) {
	seeds(f, "round1")
	p := fuzzElection(f)
	f.Fuzz(func(t *testing.T, text string) {
		_, err := CheckRound1(&p.Setup, 0, text)
		refusedOrAccepted(t, err)
	})
}

func FuzzCheckRound2(f *testing.F) {
	seeds(f, "round2")
	p := fuzzElection(f)
	f.Fuzz(func(t *testing.T, text string) {
		refusedOrAccepted(t, CheckRound2(&p.Setup, 0, text))
	})
}

func FuzzCheckConfirmation(f *testing.F) {
	seeds(f, "confirm")
	p := fuzzElection(f)
	f.Fuzz(func(t *testing.T, text string) {
		refusedOrAccepted(t, CheckConfirmation(p, 0, text))
	})
}

func FuzzCheckDecryptionShare(f *testing.F) {
	seeds(f, "dshare")
	p := fuzzElection(f)
	totals := make([]Ciphertext, len(p.Options))
	for j := range totals {
		totals[j] = Ciphertext{pointHex(generator()), pointHex(generator())}
	}
	f.Fuzz(func(t *testing.T, text string) {
		_, err := CheckDecryptionShare(p, totals, 0, text)
		refusedOrAccepted(t, err)
	})
}

func FuzzFromHex(f *testing.F) {
	f.Add("00ff", 2)
	f.Add("00FF", -1)
	f.Fuzz(func(t *testing.T, s string, n int) {
		if n > 1<<16 {
			return
		}
		b, ok := FromHex(s, n)
		if ok && ToHex(b) != s {
			t.Fatalf("FromHex(%q) gave %x, which doesn't write back", s, b)
		}
	})
}

func FuzzParseElectionRequest(f *testing.F) {
	f.Add(`{"id":"budget-2027","title":"Budget 2027","options":["Plan A","Plan B"],"closesAt":"2027-01-31T17:00:00.000Z",` +
		`"trustees":["Org1MSP","Org2MSP"],"threshold":2,"voters":{"kind":"x509","msps":["Org1MSP"]}}`)
	f.Add(`{"id":"x","title":"","options":[],"closesAt":"","trustees":[],"threshold":1e400,"voters":{"kind":"idemix","msp":"M","issuerPublicKey":"","issuerKeyHash":"","curve":""}}`)
	f.Add(`{"voters":{"kind":null}}`)
	f.Add("")
	f.Fuzz(func(t *testing.T, text string) {
		_, err := ParseElectionRequest(text)
		refusedOrAccepted(t, err)
	})
}
