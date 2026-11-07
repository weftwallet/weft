package tally

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"testing"

	r255 "github.com/gtank/ristretto255"
)

// go test -bench . -benchtime 2s ./internal/tally
//
// Verifying a ballot is what every endorser of CastBallot does. The contract
// never proves, so the prover below exists only in this test file, to
// measure encrypting and proving in Go against @weftwallet/tally in Node.

func randomScalar() *r255.Scalar {
	var b [64]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	s, _ := r255.NewScalar().SetUniformBytes(b[:])
	return s
}

// proveForBench encrypts a choice and proves it, as the specification's
// prover does. Test only: constant-time multiplications, no reuse.
func proveForBench(p *Prepared, tag []byte, choice int) string {
	G := generator()
	L := len(p.Options)
	cts, bits := make([]map[string]string, L), make([]map[string]string, L)
	A, B, R := identity(), identity(), r255.NewScalar()
	for j := 0; j < L; j++ {
		r := randomScalar()
		a := r255.NewElement().ScalarBaseMult(r)
		b := r255.NewElement().ScalarMult(r, p.H)
		real := 0
		if j == choice {
			b.Add(b, G)
			real = 1
		}
		Y := []*r255.Element{b, r255.NewElement().Subtract(b, G)}
		cs, zs, w := randomScalar(), randomScalar(), randomScalar()
		ncs := r255.NewScalar().Negate(cs)
		As := r255.NewElement().MultiScalarMult([]*r255.Scalar{zs, ncs}, []*r255.Element{G, a})
		Bs := r255.NewElement().MultiScalarMult([]*r255.Scalar{zs, ncs}, []*r255.Element{p.H, Y[1-real]})
		Ar, Br := r255.NewElement().ScalarBaseMult(w), r255.NewElement().ScalarMult(w, p.H)
		com := [][]*r255.Element{{Ar, Br}, {As, Bs}}
		if real == 1 {
			com = [][]*r255.Element{{As, Bs}, {Ar, Br}}
		}
		c := Hs(LabelBit, p.Ctx, tag, j, a.Bytes(), b.Bytes(), com[0][0].Bytes(), com[0][1].Bytes(), com[1][0].Bytes(), com[1][1].Bytes())
		cr := r255.NewScalar().Subtract(c, cs)
		zr := r255.NewScalar().Add(w, r255.NewScalar().Multiply(cr, r))
		cv, zv := [2]*r255.Scalar{cr, cs}, [2]*r255.Scalar{zr, zs}
		if real == 1 {
			cv, zv = [2]*r255.Scalar{cs, cr}, [2]*r255.Scalar{zs, zr}
		}
		cts[j] = map[string]string{"a": pointHex(a), "b": pointHex(b)}
		bits[j] = map[string]string{"c0": scalarHex(cv[0]), "c1": scalarHex(cv[1]), "z0": scalarHex(zv[0]), "z1": scalarHex(zv[1])}
		A.Add(A, a)
		B.Add(B, b)
		R.Add(R, r)
	}
	w := randomScalar()
	c := Hs(LabelSum, p.Ctx, tag, A.Bytes(), B.Bytes(), r255.NewElement().ScalarBaseMult(w).Bytes(), r255.NewElement().ScalarMult(w, p.H).Bytes())
	z := r255.NewScalar().Add(w, r255.NewScalar().Multiply(c, R))
	out, _ := json.Marshal(map[string]any{"v": 1, "electionId": p.ElectionID, "ciphertexts": cts, "bitProofs": bits, "sumProof": map[string]string{"c": scalarHex(c), "z": scalarHex(z)}})
	return string(out)
}

func benchElection(b *testing.B, L int) *Prepared {
	p := allElections(b)[map[int]string{3: "budget-2027", 10: "council-2027"}[L]]
	if p == nil || len(p.Options) != L {
		b.Fatalf("no election with %d options", L)
	}
	return p
}

func TestBenchProverMakesValidBallots(t *testing.T) {
	p := fuzzElection(t)
	tag := VoterTagX509(p.Channel, p.ElectionID, "Org1MSP", []byte("bench"))
	for choice := 0; choice < len(p.Options); choice++ {
		if _, err := CheckBallot(p, tag, proveForBench(p, tag, choice), newLedger(nil, nil), false); err != nil {
			t.Fatal(err)
		}
	}
}

func BenchmarkEncryptAndProve(b *testing.B) {
	for _, L := range []int{3, 10} {
		p := benchElection(b, L)
		tag := VoterTagX509(p.Channel, p.ElectionID, "Org1MSP", []byte("bench"))
		b.Run(fmt.Sprintf("options=%d", L), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				proveForBench(p, tag, i%L)
			}
		})
	}
}

func BenchmarkVerifyBallot(b *testing.B) {
	for _, L := range []int{3, 10} {
		p := benchElection(b, L)
		tag := VoterTagX509(p.Channel, p.ElectionID, "Org1MSP", []byte("bench"))
		ballot := proveForBench(p, tag, 1)
		ledger := newLedger(nil, nil)
		b.Run(fmt.Sprintf("options=%d", L), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				if _, err := CheckBallot(p, tag, ballot, ledger, false); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
