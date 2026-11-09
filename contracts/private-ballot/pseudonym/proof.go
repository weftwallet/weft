package pseudonym

import (
	"errors"
	"fmt"
	"io"

	math "github.com/IBM/mathlib"
)

// Error is a refusal with the contract's exact message, from the error
// table in contract-api.md.
type Error struct{ Msg string }

func (e *Error) Error() string { return e.Msg }

// Thing is how the contract's messages name the pseudonym proof.
const Thing = "The pseudonym proof"

func errNotPoint(path string) error {
	return &Error{fmt.Sprintf("%s's %s isn't a canonical point.", Thing, path)}
}
func errNotScalar(path string) error {
	return &Error{fmt.Sprintf("%s's %s isn't a canonical scalar.", Thing, path)}
}

// ErrNotValid is every failure of a decoded proof.
var ErrNotValid error = &Error{"The pseudonym proof is not valid."}

// Statement is the public part of the proof: the issuer key, where the
// pseudonym applies, the ballot it is bound to and the transaction's Nym.
type Statement struct {
	Key        *Key
	Channel    string
	ElectionID string
	Tracking   []byte // the ballot's 32-byte tracking code
	Nym        *math.G1
}

func (s *Statement) check() error {
	if s.Key == nil || s.Nym == nil || len(s.Tracking) != 32 {
		return errors.New("pseudonym: the statement needs a key, a Nym and a 32-byte tracking code")
	}
	return nil
}

// Base returns B = H1("weft-scope v1", [channel, electionId]), the same for
// every voter of one election on one channel.
func Base(channel, electionID string) *math.G1 {
	return h1(LabelScope, channel, electionID)
}

// Pseudonym returns P = sk·B, the credential's pseudonym in the election.
func Pseudonym(sk *math.Zr, channel, electionID string) *math.G1 {
	return Base(channel, electionID).Mul(sk)
}

// ChallengeInput returns frame(["weft-scope-proof v1", issuerKeyHash,
// channel, electionId, tracking, B, Nym, P, T1, T2]), the bytes Hz hashes.
func ChallengeInput(s *Statement, b, p, t1, t2 *math.G1) []byte {
	return frame(LabelProof, s.Key.Hash[:], s.Channel, s.ElectionID, s.Tracking,
		EncodePoint(b), EncodePoint(s.Nym), EncodePoint(p), EncodePoint(t1), EncodePoint(t2))
}

// Proof is (P, c, ssk, sr), decoded.
type Proof struct {
	P          *math.G1
	C, SSk, SR *math.Zr
}

// PBytes is P's 64-byte encoding, which the voter tag frames.
func (p *Proof) PBytes() []byte { return EncodePoint(p.P) }

// JSON is pseudonymJson, the third argument of CastAnonymousBallot: P and
// the scalars as lowercase hex, in this field order.
type JSON struct {
	Pseudonym string `json:"pseudonym"`
	C         string `json:"c"`
	SSk       string `json:"ssk"`
	SR        string `json:"sr"`
}

// JSON returns the proof's fields as lowercase hex.
func (p *Proof) JSON() JSON {
	return JSON{toHex(EncodePoint(p.P)), toHex(EncodeScalar(p.C)), toHex(EncodeScalar(p.SSk)), toHex(EncodeScalar(p.SR))}
}

// Decode decodes pseudonymJson's fields, once the argument has parsed, in
// the order pseudonym, c, ssk, sr, with the contract's parsing messages.
func Decode(j JSON) (*Proof, error) {
	pb, ok := fromHex(j.Pseudonym, PointSize)
	if !ok {
		return nil, errNotPoint("pseudonym")
	}
	p, ok := DecodePoint(pb)
	if !ok {
		return nil, errNotPoint("pseudonym")
	}
	out := &Proof{P: p}
	for _, f := range []struct {
		path string
		hex  string
		to   **math.Zr
	}{{"c", j.C, &out.C}, {"ssk", j.SSk, &out.SSk}, {"sr", j.SR, &out.SR}} {
		b, ok := fromHex(f.hex, ScalarSize)
		if !ok {
			return nil, errNotScalar(f.path)
		}
		if *f.to, ok = DecodeScalar(b); !ok {
			return nil, errNotScalar(f.path)
		}
	}
	return out, nil
}

// Trace is every value a proof computes, for the test vectors.
type Trace struct {
	B, P, T1, T2   *math.G1
	ChallengeInput []byte
	C, SSk, SR     *math.Zr
}

// Prove makes the proof for the credential's secret key sk and the Nym's
// randomness rNym, where the statement's Nym is sk·HSk + rNym·HRand, with
// a and b drawn uniformly below r from rng. It draws again in the
// negligible case that T1 or T2 is the identity.
func Prove(s *Statement, sk, rNym *math.Zr, rng io.Reader) (*Proof, error) {
	for range 8 {
		a := curve.NewRandomZr(rng)
		b := curve.NewRandomZr(rng)
		p, _, err := ProveWith(s, sk, rNym, a, b)
		wipe(a)
		wipe(b)
		if errors.Is(err, errIdentityCommitment) {
			continue
		}
		return p, err
	}
	return nil, errors.New("pseudonym: no commitment other than the identity in 8 draws")
}

var errIdentityCommitment = errors.New("pseudonym: T1 or T2 is the identity")

// ProveWith makes the proof with the given a and b, for the test vectors,
// and returns its trace. a and b must be secret and used once: two proofs
// with the same a and b and different challenges give away sk.
func ProveWith(s *Statement, sk, rNym, a, b *math.Zr) (*Proof, *Trace, error) {
	if err := s.check(); err != nil {
		return nil, nil, err
	}
	if sk.IsZero() || !scalarBelowR(sk) || !scalarBelowR(rNym) || !scalarBelowR(a) || !scalarBelowR(b) {
		return nil, nil, errors.New("pseudonym: sk must be from 1 to r - 1, and rNym, a and b below r")
	}
	base := Base(s.Channel, s.ElectionID)
	p := base.Mul(sk)
	t1 := s.Key.HSk.Mul2(a, s.Key.HRand, b)
	t2 := base.Mul(a)
	if t1.IsInfinity() || t2.IsInfinity() {
		return nil, nil, errIdentityCommitment
	}
	input := ChallengeInput(s, base, p, t1, t2)
	c := hz(input)
	order := curve.GroupOrder
	ssk := curve.ModAdd(a, curve.ModMul(c, sk, order), order)
	sr := curve.ModAdd(b, curve.ModMul(c, rNym, order), order)
	proof := &Proof{P: p, C: c, SSk: ssk, SR: sr}
	return proof, &Trace{B: base, P: p, T1: t1, T2: t2, ChallengeInput: input, C: c, SSk: ssk, SR: sr}, nil
}

// Verify checks a decoded proof against the statement:
//
//	T1' = ssk·HSk + sr·HRand - c·Nym
//	T2' = ssk·B - c·P
//
// refusing if T1' or T2' is the identity, and accepting if c is
// Hz("weft-scope-proof v1", [issuerKeyHash, channel, electionId, tracking,
// B, Nym, P, T1', T2']). Every failure is ErrNotValid.
func Verify(s *Statement, p *Proof) error {
	_, err := VerifyTrace(s, p)
	return err
}

// VerifyTrace is Verify, returning what it computed, for the test vectors.
func VerifyTrace(s *Statement, p *Proof) (*Trace, error) {
	if err := s.check(); err != nil {
		return nil, err
	}
	if p == nil || p.P == nil || p.C == nil || p.SSk == nil || p.SR == nil || p.P.IsInfinity() || s.Nym.IsInfinity() {
		return nil, ErrNotValid
	}
	base := Base(s.Channel, s.ElectionID)
	t1 := s.Key.HSk.Mul2(p.SSk, s.Key.HRand, p.SR)
	t1.Sub(s.Nym.Mul(p.C))
	t2 := base.Mul(p.SSk)
	t2.Sub(p.P.Mul(p.C))
	if t1.IsInfinity() || t2.IsInfinity() {
		return nil, ErrNotValid
	}
	input := ChallengeInput(s, base, p.P, t1, t2)
	c := hz(input)
	if !c.Equals(p.C) {
		return nil, ErrNotValid
	}
	return &Trace{B: base, P: p.P, T1: t1, T2: t2, ChallengeInput: input, C: c, SSk: p.SSk, SR: p.SR}, nil
}

// wipe zeroes a scalar's words in place. IBM mathlib's BigInt returns the
// scalar's own big.Int.
func wipe(z *math.Zr) {
	if z == nil {
		return
	}
	n := z.BigInt()
	clear(n.Bits())
	n.SetInt64(0)
}
