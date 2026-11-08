package signer_test

import (
	"bytes"
	"math/big"

	math "github.com/IBM/mathlib"
	"google.golang.org/protobuf/proto"
)

func marshal(m proto.Message) ([]byte, error) { return proto.Marshal(m) }

// flip returns a copy of b with one bit of byte i changed.
func flip(b []byte, i int) []byte {
	out := bytes.Clone(b)
	out[i] ^= 1
	return out
}

// order is the group order r of FP256BN as 32 bytes, the smallest value
// that isn't a scalar.
func order() []byte {
	return math.Curves[math.FP256BN_AMCL].GroupOrder.Bytes()
}

func wordsOf(z *math.Zr) []big.Word { return z.BigInt().Bits() }

func allZero(ws []big.Word) bool {
	for _, w := range ws {
		if w != 0 {
			return false
		}
	}
	return true
}

func allZeroBytes(b []byte) bool { return len(b) > 0 && bytes.Count(b, []byte{0}) == len(b) }
