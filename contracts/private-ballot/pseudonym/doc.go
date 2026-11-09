// Package pseudonym is the per-election pseudonym of a voter credential and
// its proof, as "The per-election pseudonym" in
// apps/docs/src/content/docs/experimental/private-tally-spec.md specifies
// them (version 1).
//
// A voter credential's transaction carries a Nym that is new for every
// transaction. The pseudonym P = sk·B, with B hashed from the channel and
// the election ID, is the same for one credential within one election, and
// the proof shows that P comes from the secret key inside the transaction's
// Nym. The contract makes the voter tag from P and marks it as voted.
//
// It is the one Go source for both sides: the contract verifies with it,
// and Weft's idemix WebAssembly module (packages/idemix) proves with it, by
// requiring this module with a replace directive. It works in G1 of
// FP256BN, Fabric CA's default idemix curve, with IBM mathlib, and decodes
// issuer keys with IBM idemix's dlog package.
//
// Unreviewed cryptography, for Weft Experimental only.
package pseudonym
