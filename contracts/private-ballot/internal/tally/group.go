package tally

import (
	"encoding/binary"

	r255 "github.com/gtank/ristretto255"
)

// Every value here is public: the contract handles no secret, so the
// variable-time multiplications are used throughout.

func decodePoint(b []byte) (*r255.Element, bool) {
	if len(b) != 32 {
		return nil, false
	}
	e, err := r255.NewElement().SetCanonicalBytes(b)
	return e, err == nil
}

func decodeScalar(b []byte) (*r255.Scalar, bool) {
	if len(b) != 32 {
		return nil, false
	}
	s, err := r255.NewScalar().SetCanonicalBytes(b)
	return s, err == nil
}

func identity() *r255.Element { return r255.NewIdentityElement() }

func generator() *r255.Element { return r255.NewGeneratorElement() }

func isIdentity(e *r255.Element) bool { return e.Equal(identity()) == 1 }

// scalarOf returns the scalar n.
func scalarOf(n uint64) *r255.Scalar {
	var b [32]byte
	binary.LittleEndian.PutUint64(b[:8], n)
	s, err := r255.NewScalar().SetCanonicalBytes(b[:])
	if err != nil {
		panic(err)
	}
	return s
}

// TrusteeID returns id_i, the scalar i, as 32 bytes, for the trustee at
// 0-based index i - 1.
func TrusteeID(index int) []byte { return scalarOf(uint64(index + 1)).Bytes() }

// lin returns x·P - y·Q.
func lin(x *r255.Scalar, p *r255.Element, y *r255.Scalar, q *r255.Element) *r255.Element {
	ny := r255.NewScalar().Negate(y)
	return r255.NewElement().VarTimeMultiScalarMult([]*r255.Scalar{x, ny}, []*r255.Element{p, q})
}

func mul(s *r255.Scalar, p *r255.Element) *r255.Element {
	return r255.NewElement().VarTimeMultiScalarMult([]*r255.Scalar{s}, []*r255.Element{p})
}

func scalarHex(s *r255.Scalar) string { return ToHex(s.Bytes()) }

func pointHex(e *r255.Element) string { return ToHex(e.Bytes()) }
