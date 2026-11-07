package tally

import (
	"encoding/json"
	"fmt"

	r255 "github.com/gtank/ristretto255"
)

// Ciphertext is (a, b) as lowercase hex.
type Ciphertext struct {
	A string `json:"a"`
	B string `json:"b"`
}

var ballotSchema = sObj(
	f("v", sNum),
	f("electionId", sStr),
	f("ciphertexts", sList(sObj(f("a", sStr), f("b", sStr)))),
	f("bitProofs", sList(sObj(f("c0", sStr), f("c1", sStr), f("z0", sStr), f("z1", sStr)))),
	f("sumProof", sObj(f("c", sStr), f("z", sStr))),
)

type bitProof struct{ c0, c1, z0, z1 *r255.Scalar }

// DecodedBallot is a ballot that has parsed and decoded.
type DecodedBallot struct {
	Ciphertexts []Ciphertext
	a, b        []*r255.Element
	bits        []bitProof
	c, z        *r255.Scalar
	raw         [][]byte // a_0, b_0, c0_0, c1_0, z0_0, z1_0, ..., c, z, for the tracking code
}

func pointAt(thing, path, h string) (*r255.Element, []byte, error) {
	b, ok := FromHex(h, 32)
	if !ok {
		return nil, nil, errNotPoint(thing, path)
	}
	p, ok := decodePoint(b)
	if !ok {
		return nil, nil, errNotPoint(thing, path)
	}
	return p, b, nil
}

func scalarAt(thing, path, h string) (*r255.Scalar, []byte, error) {
	b, ok := FromHex(h, 32)
	if !ok {
		return nil, nil, errNotScalar(thing, path)
	}
	s, ok := decodeScalar(b)
	if !ok {
		return nil, nil, errNotScalar(thing, path)
	}
	return s, b, nil
}

func objects(x any) []map[string]any {
	var out []map[string]any
	for _, item := range x.([]any) {
		out = append(out, item.(map[string]any))
	}
	return out
}

// ParseBallot runs steps 2 and 3 of what the contract checks: the ballot
// parses into the version 1 fields, is for this election, has L ciphertexts
// and L bit proofs, and every point and scalar decodes canonically, in the
// order the fields appear, with no a_j the identity.
func ParseBallot(s *Setup, text string) (*DecodedBallot, error) {
	const t = thingBallot
	x, err := parseStrict(t, text, ballotSchema)
	if err != nil {
		return nil, err
	}
	L := len(s.Options)
	if !numberIs(x["v"].(json.Number), 1) || x["electionId"].(string) != s.ElectionID {
		return nil, errWrongElection()
	}
	cts, proofs := objects(x["ciphertexts"]), objects(x["bitProofs"])
	if len(cts) != L {
		return nil, errCiphertextCount(len(cts), L)
	}
	if len(proofs) != L {
		return nil, errBitProofCount(len(proofs), L)
	}
	d := &DecodedBallot{}
	raws := make([][2][]byte, L)
	for j, ct := range cts {
		a, ra, err := pointAt(t, fmt.Sprintf("ciphertexts[%d].a", j), ct["a"].(string))
		if err != nil {
			return nil, err
		}
		b, rb, err := pointAt(t, fmt.Sprintf("ciphertexts[%d].b", j), ct["b"].(string))
		if err != nil {
			return nil, err
		}
		if isIdentity(a) {
			return nil, errNoRandomness(j)
		}
		d.a, d.b = append(d.a, a), append(d.b, b)
		d.Ciphertexts = append(d.Ciphertexts, Ciphertext{A: ct["a"].(string), B: ct["b"].(string)})
		raws[j] = [2][]byte{ra, rb}
	}
	for j, p := range proofs {
		var vs [4]*r255.Scalar
		var rs [4][]byte
		for k, name := range []string{"c0", "c1", "z0", "z1"} {
			sc, r, err := scalarAt(t, fmt.Sprintf("bitProofs[%d].%s", j, name), p[name].(string))
			if err != nil {
				return nil, err
			}
			vs[k], rs[k] = sc, r
		}
		d.bits = append(d.bits, bitProof{vs[0], vs[1], vs[2], vs[3]})
		d.raw = append(d.raw, raws[j][0], raws[j][1], rs[0], rs[1], rs[2], rs[3])
	}
	sum := x["sumProof"].(map[string]any)
	c, rc, err := scalarAt(t, "sumProof.c", sum["c"].(string))
	if err != nil {
		return nil, err
	}
	z, rz, err := scalarAt(t, "sumProof.z", sum["z"].(string))
	if err != nil {
		return nil, err
	}
	d.c, d.z = c, z
	d.raw = append(d.raw, rc, rz)
	return d, nil
}

// BitTrace and ProofTrace are the commitments and challenges a verifier
// recomputes, for the test vectors.
type BitTrace struct {
	A0 string `json:"A0"`
	B0 string `json:"B0"`
	A1 string `json:"A1"`
	B1 string `json:"B1"`
	C  string `json:"c"`
}

type SumTrace struct {
	A  string `json:"A"`
	B  string `json:"B"`
	T1 string `json:"T1"`
	T2 string `json:"T2"`
	C  string `json:"c"`
}

type ProofTrace struct {
	Bits []BitTrace `json:"bits"`
	Sum  SumTrace   `json:"sum"`
}

// VerifyBallotProofs runs steps 4 and 5: every bit proof, then the sum proof.
func VerifyBallotProofs(p *Prepared, voterTag []byte, d *DecodedBallot) (*ProofTrace, error) {
	G := generator()
	tr := &ProofTrace{}
	A, B := identity(), identity()
	for j, a := range d.a {
		b, bp := d.b[j], d.bits[j]
		bMinusG := r255.NewElement().Subtract(b, G)
		A0 := lin(bp.z0, G, bp.c0, a)
		B0 := lin(bp.z0, p.H, bp.c0, b)
		A1 := lin(bp.z1, G, bp.c1, a)
		B1 := lin(bp.z1, p.H, bp.c1, bMinusG)
		c := Hs(LabelBit, p.Ctx, voterTag, j, a.Bytes(), b.Bytes(), A0.Bytes(), B0.Bytes(), A1.Bytes(), B1.Bytes())
		if r255.NewScalar().Add(bp.c0, bp.c1).Equal(c) != 1 {
			return nil, errNotBit(j)
		}
		tr.Bits = append(tr.Bits, BitTrace{pointHex(A0), pointHex(B0), pointHex(A1), pointHex(B1), scalarHex(c)})
		A.Add(A, a)
		B.Add(B, b)
	}
	BMinusG := r255.NewElement().Subtract(B, G)
	T1 := lin(d.z, G, d.c, A)
	T2 := lin(d.z, p.H, d.c, BMinusG)
	c := Hs(LabelSum, p.Ctx, voterTag, A.Bytes(), B.Bytes(), T1.Bytes(), T2.Bytes())
	if c.Equal(d.c) != 1 {
		return nil, errNotOne()
	}
	tr.Sum = SumTrace{pointHex(A), pointHex(B), pointHex(T1), pointHex(T2), scalarHex(c)}
	return tr, nil
}

// TrackingCode returns
//
//	SHA-256(frame(["weft-ballot-hash v1", ctx, v, a_0, b_0, c0_0, c1_0, z0_0, z1_0, ..., c, z]))
//
// as 64 lowercase hex characters.
func TrackingCode(p *Prepared, voterTag []byte, d *DecodedBallot) string {
	parts := []any{p.Ctx, voterTag}
	for _, r := range d.raw {
		parts = append(parts, r)
	}
	return ToHex(digest(LabelTracking, parts...))
}

// Ledger is the contract's lookups for steps 6 and 7.
type Ledger interface {
	// HasCiphertext reports whether a ciphertext with this first component
	// (lowercase hex) is already on the ledger for this election.
	HasCiphertext(a string) bool
	// HasVoted reports whether this voter tag (lowercase hex) has voted in this election.
	HasVoted(tag string) bool
}

// CheckedBallot is an accepted ballot.
type CheckedBallot struct {
	Ballot   *DecodedBallot
	Tracking string
	Trace    *ProofTrace
}

// CheckBallot runs steps 2 to 7 of what the contract checks, in order,
// stopping at the first failure. Step 1, the election's state, is the
// contract's own. credential selects the message for a second vote.
func CheckBallot(p *Prepared, voterTag []byte, text string, ledger Ledger, credential bool) (*CheckedBallot, error) {
	d, err := ParseBallot(&p.Setup, text)
	if err != nil {
		return nil, err
	}
	tr, err := VerifyBallotProofs(p, voterTag, d)
	if err != nil {
		return nil, err
	}
	for _, ct := range d.Ciphertexts {
		if ledger.HasCiphertext(ct.A) {
			return nil, errRepeated()
		}
	}
	if ledger.HasVoted(ToHex(voterTag)) {
		if credential {
			return nil, errCredentialVoted()
		}
		return nil, errIdentityVoted()
	}
	return &CheckedBallot{Ballot: d, Tracking: TrackingCode(p, voterTag, d), Trace: tr}, nil
}

// AddTotals returns (A_j, B_j), the sum of every accepted ballot's
// ciphertexts per option, and N, the number of ballots. The ballots were
// checked when they were cast.
func AddTotals(L int, ballots [][]Ciphertext) ([]Ciphertext, int, error) {
	A, B := make([]*r255.Element, L), make([]*r255.Element, L)
	for j := range A {
		A[j], B[j] = identity(), identity()
	}
	for _, cts := range ballots {
		if len(cts) != L {
			return nil, 0, fmt.Errorf("tally: a stored ballot has %d ciphertexts, not %d", len(cts), L)
		}
		for j, ct := range cts {
			a, _, errA := pointAt(thingBallot, "a", ct.A)
			b, _, errB := pointAt(thingBallot, "b", ct.B)
			if errA != nil || errB != nil {
				return nil, 0, fmt.Errorf("tally: a stored ballot doesn't decode")
			}
			A[j].Add(A[j], a)
			B[j].Add(B[j], b)
		}
	}
	out := make([]Ciphertext, L)
	for j := range out {
		out[j] = Ciphertext{pointHex(A[j]), pointHex(B[j])}
	}
	return out, len(ballots), nil
}
