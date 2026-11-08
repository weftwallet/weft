package signer

import math "github.com/IBM/mathlib"

// wipeZr zeroes a scalar's words in place. mathlib's BigInt returns the
// scalar's own big.Int, so its words are the ones the library computes
// with; TestWipe fails if a mathlib version changes that.
func wipeZr(z *math.Zr) {
	if z == nil {
		return
	}
	b := z.BigInt()
	clear(b.Bits())
	b.SetInt64(0)
}
