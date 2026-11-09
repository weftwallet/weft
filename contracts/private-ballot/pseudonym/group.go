package pseudonym

import (
	"bytes"
	"encoding/binary"
	"math/big"

	math "github.com/IBM/mathlib"
)

// The curve, FP256BN as IBM mathlib's FP256BN_AMCL, the curve of Fabric
// CA's idemix issuer keys.
var curve = math.Curves[math.FP256BN_AMCL]

// The modulus p of FP256BN's base field and the order r of G1, as the
// specification writes them.
const (
	PHex = "fffffffffffcf0cd46e5f25eee71a49f0cdc65fb12980a82d3292ddbaed33013"
	RHex = "fffffffffffcf0cd46e5f25eee71a49e0cdc65fb1299921af62d536cd10b500d"
)

var (
	fieldP = mustBig(PHex)
	orderR = mustBig(RHex)
	three  = big.NewInt(3)
)

func mustBig(h string) *big.Int {
	n, ok := new(big.Int).SetString(h, 16)
	if !ok {
		panic("pseudonym: bad constant")
	}
	return n
}

// The sizes of the encodings.
const (
	PointSize  = 64
	ScalarSize = 32
)

// The labels of the two hashes, from the specification's label table.
const (
	LabelScope = "weft-scope v1"
	LabelProof = "weft-scope-proof v1"
)

// frame returns frame([p_1, ..., p_m]) = len(p_1) || p_1 || ... , each len
// a 4-byte big-endian integer and each part a string's UTF-8 bytes or a
// byte string. It is the scheme's frame(), as internal/tally.Frame.
func frame(parts ...any) []byte {
	var out bytes.Buffer
	for _, p := range parts {
		var b []byte
		switch v := p.(type) {
		case string:
			b = []byte(v)
		case []byte:
			b = v
		default:
			panic("pseudonym: can't frame this part")
		}
		out.Write(binary.BigEndian.AppendUint32(nil, uint32(len(b))))
		out.Write(b)
	}
	return out.Bytes()
}

// hz is Hz(label, parts) = OS2IP(SHA-256(frame([label, ...parts]))) mod r,
// IBM mathlib's HashToZr for FP256BN_AMCL.
func hz(input []byte) *math.Zr { return curve.HashToZr(input) }

// h1 is H1(label, parts) = HashToG1(frame([label, ...parts])), IBM
// mathlib's HashToG1 for FP256BN_AMCL, which is AMCL's Bls_hash.
func h1(label string, parts ...any) *math.G1 {
	return curve.HashToG1(frame(append([]any{label}, parts...)...))
}

// onCurve reports whether 0 <= x, y < p and y^2 = x^3 + 3 mod p.
func onCurve(x, y *big.Int) bool {
	if x.Sign() < 0 || y.Sign() < 0 || x.Cmp(fieldP) >= 0 || y.Cmp(fieldP) >= 0 {
		return false
	}
	lhs := new(big.Int).Mul(y, y)
	lhs.Mod(lhs, fieldP)
	rhs := new(big.Int).Exp(x, three, fieldP)
	rhs.Add(rhs, three).Mod(rhs, fieldP)
	return lhs.Cmp(rhs) == 0
}

// DecodePoint reads a point of G1 from its 64 bytes, x then y, each 32
// bytes big-endian. It refuses any other length, a coordinate of p or more,
// and a point that isn't on the curve, which includes every attempt at the
// identity, since the identity has no encoding. G1 has cofactor 1, so a
// point on the curve is in G1.
func DecodePoint(b []byte) (*math.G1, bool) {
	if len(b) != PointSize {
		return nil, false
	}
	x := new(big.Int).SetBytes(b[:32])
	y := new(big.Int).SetBytes(b[32:])
	if !onCurve(x, y) {
		return nil, false
	}
	g, err := curve.NewG1FromBytes(append([]byte{0x04}, b...))
	if err != nil || g.IsInfinity() {
		return nil, false
	}
	return g, true
}

// EncodePoint writes a point of G1 as its 64 bytes. It panics on the
// identity, which has no encoding: the prover draws again rather than
// write one, and the verifier never encodes one.
func EncodePoint(g *math.G1) []byte {
	if g.IsInfinity() {
		panic("pseudonym: the identity has no encoding")
	}
	b := g.Bytes() // 0x04, then x and y
	return append([]byte{}, b[1:]...)
}

// DecodeScalar reads a scalar from its 32 bytes, big-endian, as IBM mathlib
// writes one, refusing any other length and any value of r or more.
func DecodeScalar(b []byte) (*math.Zr, bool) {
	if len(b) != ScalarSize {
		return nil, false
	}
	n := new(big.Int).SetBytes(b)
	if n.Cmp(orderR) >= 0 {
		return nil, false
	}
	return curve.NewZrFromBigInt(n), true
}

// EncodeScalar writes a scalar as its 32 bytes, big-endian.
func EncodeScalar(z *math.Zr) []byte { return z.Bytes() }

// scalarBelowR reports whether z is from 0 to r - 1.
func scalarBelowR(z *math.Zr) bool {
	n := z.BigInt()
	return n.Sign() >= 0 && n.Cmp(orderR) < 0
}

const hexDigits = "0123456789abcdef"

func toHex(b []byte) string {
	out := make([]byte, 2*len(b))
	for i, x := range b {
		out[2*i] = hexDigits[x>>4]
		out[2*i+1] = hexDigits[x&15]
	}
	return string(out)
}

// fromHex reads strict lowercase hex of exactly n bytes.
func fromHex(s string, n int) ([]byte, bool) {
	if len(s) != 2*n {
		return nil, false
	}
	out := make([]byte, n)
	for i := range out {
		hi, lo := hexValue(s[2*i]), hexValue(s[2*i+1])
		if hi < 0 || lo < 0 {
			return nil, false
		}
		out[i] = byte(hi<<4 | lo)
	}
	return out, true
}

func hexValue(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	}
	return -1
}
