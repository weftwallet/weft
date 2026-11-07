package tally

import (
	"crypto/sha256"
	"crypto/sha512"

	r255 "github.com/gtank/ristretto255"
)

// DST is the domain separation tag of every challenge.
const DST = "weft-ballot-v1-challenge"

// The labels that start each hash input.
const (
	LabelContext     = "weft-ballot v1"
	LabelVoterX509   = "weft-voter x509 v1"
	LabelVoterIdemix = "weft-voter idemix v1"
	LabelBit         = "bit"
	LabelSum         = "sum"
	LabelShare       = "share"
	LabelConfirm     = "confirm"
	LabelTracking    = "weft-ballot-hash v1"
	LabelFingerprint = "weft-election-fingerprint v1"
	LabelShareBox    = "weft-ballot-v1 share"
)

// ExpandMessageXMD is RFC 9380's expand_message_xmd (section 5.3.1) with
// SHA-512. It panics on a DST over 255 bytes or an output over 255 blocks,
// which no caller here asks for.
func ExpandMessageXMD(msg, dst []byte, n int) []byte {
	const bInBytes, sInBytes = 64, 128
	ell := (n + bInBytes - 1) / bInBytes
	if ell > 255 || n > 65535 || len(dst) > 255 {
		panic("tally: expand_message_xmd parameters out of range")
	}
	dstPrime := append(append([]byte{}, dst...), byte(len(dst)))
	h := sha512.New()
	h.Write(make([]byte, sInBytes))
	h.Write(msg)
	h.Write([]byte{byte(n >> 8), byte(n)})
	h.Write([]byte{0})
	h.Write(dstPrime)
	b0 := h.Sum(nil)

	h.Reset()
	h.Write(b0)
	h.Write([]byte{1})
	h.Write(dstPrime)
	bi := h.Sum(nil)
	out := append([]byte{}, bi...)
	for i := 2; i <= ell; i++ {
		x := make([]byte, bInBytes)
		for k := range x {
			x[k] = b0[k] ^ bi[k]
		}
		h.Reset()
		h.Write(x)
		h.Write([]byte{byte(i)})
		h.Write(dstPrime)
		bi = h.Sum(nil)
		out = append(out, bi...)
	}
	return out[:n]
}

// ChallengeBytes returns the 64 bytes that Hs reduces.
func ChallengeBytes(label string, parts ...any) []byte {
	return ExpandMessageXMD(Frame(append([]any{label}, parts...)...), []byte(DST), 64)
}

// Hs(label, parts) = OS2IP_LE(expand_message_xmd(frame([label, ...parts]), DST, 64)) mod l.
func Hs(label string, parts ...any) *r255.Scalar {
	s, err := r255.NewScalar().SetUniformBytes(ChallengeBytes(label, parts...))
	if err != nil {
		panic(err)
	}
	return s
}

// digest is SHA-256 of a framed list that starts with its label.
func digest(label string, parts ...any) []byte {
	d := sha256.Sum256(Frame(append([]any{label}, parts...)...))
	return d[:]
}
