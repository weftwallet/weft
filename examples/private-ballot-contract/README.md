# private-ballot-contract

The Go contract for private elections in Weft Experimental ([ADR 0007](../../docs/adr/0007-private-tally.md)), deployed as `private-ballot`. The [contract API](../../apps/docs/src/content/docs/experimental/contract-api.md) describes its functions, state and errors. No one outside the project has reviewed its cryptography.

So far the module holds only `internal/tally`, the verifying half of the [private tally specification](../../apps/docs/src/content/docs/experimental/private-tally-spec.md): decoding the contract's JSON arguments, the ballot proofs, the voter tag, the tracking code, totals, the key ceremony checks, the election key and fingerprint, the decryption share proofs, the Lagrange combination and the count. It handles no secret and draws no randomness. The contract's functions are the next step.

## The ristretto255 library

`internal/tally` uses [`github.com/gtank/ristretto255`](https://github.com/gtank/ristretto255) v0.2.0, on [`filippo.io/edwards25519`](https://github.com/FiloSottile/edwards25519) v1.2.0. Both are under the BSD 3-Clause licence, which fits Weft's Apache 2.0.

- `filippo.io/edwards25519` is the Go standard library's `crypto/internal/fips140/edwards25519` published as a module, and it follows upstream. That code was in the scope of [Trail of Bits' audit of Go's cryptography](https://go.dev/blog/tob-crypto-audit), published on 19 May 2025, whose one finding in it (TOB-GOCL-6, a `SetCanonicalBytes` that wasn't constant time) is fixed in v1.2.0. v1.1.1 and later also fix CVE-2026-26958 in `MultiScalarMult`. The module requires v1.2.0 for both, although `gtank/ristretto255` v0.2.0 asks only for v1.1.0.
- `gtank/ristretto255` adds the RFC 9496 encoding, decoding and group operations to it, with the scalar field. George Tankersley and Henry de Valence, two of its authors, are among the authors of RFC 9496. No published audit of the package itself was found when it was chosen, so its 670 lines join the review list. Its last release, v0.2.0, is from August 2025 and updates it to RFC 9496.
- Using `filippo.io/edwards25519` directly would mean writing ristretto255's encoding and decoding by hand, which is the part most easily got wrong. `github.com/bwesterb/go-ristretto` has curve arithmetic of its own and doesn't share the standard library's code.

The test vectors check that this library and noble agree: every encoding, every refusal of a non-canonical point or scalar, and every proof.

## Building

`go.mod` says `go 1.24.0`, the oldest Go that `filippo.io/edwards25519` v1.2.0 builds with. `hyperledger/fabric-ccenv:2.5` builds the contract with the Go of Fabric 2.5.16, 1.26.4, so the line is older than the image's Go, as [ADR 0007](../../docs/adr/0007-private-tally.md) requires. test-network's `deployCC -ccl go` runs `go mod vendor` in this folder. `vendor/` stays out of git (see the repository's `.gitignore`).

```sh
go vet ./...
go test ./...                                   # reads ../../packages/tally/vectors/v1
go test -run XXX -fuzz FuzzParseBallot ./internal/tally
go test -run XXX -bench . ./internal/tally
```

The tests read the vectors that `@weftwallet/tally` writes, by relative path, and must agree with the TypeScript tests on every case. A negative vector passes only when the contract's message is the vector's, word for word.

## Written by hand, for review

The framing, `expand_message_xmd` with SHA-512, the hash to a scalar, the check of noble's DKG proof of knowledge, the strict JSON parser and the order of its checks, the 0-or-1, sum, confirmation and decryption share verifiers, the key and verifying shares from the commitments, the Lagrange combination and the count. The benchmark's prover in `bench_test.go` exists only to time proving in Go, and the contract never proves.
