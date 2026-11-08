package signer

import math "github.com/IBM/mathlib"

// Secrets gives the tests an identity's secret scalars, to check Dispose.
func Secrets(id *Identity) (sk, rNym *math.Zr) { return id.sk, id.rNym }
