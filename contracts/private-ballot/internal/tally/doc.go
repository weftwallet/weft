// Package tally is the verifying half of the private tally (ADR 0007), as
// the specification in apps/docs/src/content/docs/experimental/private-tally-spec.md
// defines it: decoding, the ballot and ceremony proofs, the tracking code,
// totals, the election key and fingerprint, and combining decryption shares.
//
// It handles no secret and draws no randomness, so every endorser computes
// the same result. @weftwallet/tally in packages/tally is the TypeScript
// implementation of the whole scheme, and both run the test vectors in
// packages/tally/vectors/v1.
//
// Unreviewed cryptography, for Weft Experimental only.
package tally
