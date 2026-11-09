# private-ballot

The Go contract for private elections in Weft Experimental ([ADR 0007](../../docs/adr/0007-private-tally.md)), deployed as `private-ballot`. The [contract API](../../apps/docs/src/content/docs/experimental/contract-api.md) describes its functions, state and errors. No one outside the project has reviewed its cryptography.

| Path | Holds |
|---|---|
| `main.go` | The chaincode's `main`, at the module's root, where the peer's Go build looks. It starts the contract with the shim. |
| `contract/` | Every function in the contract API, its state keys, events and error messages, and its tests. |
| `internal/tally/` | The verifying half of the [private tally specification](../../apps/docs/src/content/docs/experimental/private-tally-spec.md): decoding the contract's JSON arguments, the ballot proofs, the voter tag, the tracking code, totals, the key ceremony checks, the election key and fingerprint, the decryption share proofs, the Lagrange combination and the count. It handles no secret and draws no randomness. |
| `pseudonym/` | [The per-election pseudonym](../../apps/docs/src/content/docs/experimental/private-tally-spec.md#the-per-election-pseudonym) of a voter credential: its encodings, HashToG1 and HashToZr, the prover and the verifier, the issuer key's decoding, and the check of an idemix creator's proof against an issuer key. It isn't in `internal/`, so that `packages/idemix` can require this module with a replace directive and compile the same prover into Weft's WebAssembly module. Its vectors are in `pseudonym/testdata/v1/pseudonym.json`. |

The contract is built for elections with X.509 voters and for elections with voter credentials ([ADR 0008](../../docs/adr/0008-idemix-voter-credentials.md)): `CreateElection` pins an election's issuer key, affiliation and role, and `CastAnonymousBallot` checks the creator, including its proof against the pinned issuer key, the ballot and the pseudonym proof in the order the specification gives. `CastBallot` makes an X.509 voter's tag from the MSP ID and the enrolment ID, the one common name in the certificate's subject, which it reads with Go's `crypto/x509`.

## The shim, not the contract API

The contract uses `fabric-chaincode-go/v2`'s `shim` and `pkg/cid`, v2.3.0, and dispatches its own functions.

- `cid` reads a creator's attributes from an X.509 certificate, and from an idemix creator's `SerializedIdemixIdentity` (its OU and role), so it answers for both kinds of creator. The trustee check asks it for `weft.trustee=true`, which only an X.509 trustee identity can carry, and `CastAnonymousBallot` asks it for an idemix creator's `ou` and `role`. The voter tag and the pseudonym proof need the creator's `mspid`, `id_bytes` and Nym, which `cid` doesn't expose, so the contract reads the `SerializedIdentity` and the `SerializedIdemixIdentity` itself, and an X.509 creator is one whose `id_bytes` are a PEM certificate.
- On a Fabric 2.5.16 network with credentials from Fabric CA 1.5.17, `cid` gives an idemix creator its MSP ID, `ou` and `role` (`member` for Fabric CA's role 1, `admin` for role 2), no `weft.trustee`, and errors from `GetID` ("cannot determine identity") and `HasOUValue`, as it does in the tests.
- `fabric-contract-api-go` builds its caller from `cid` too, and ignores `cid`'s error, so it would also accept idemix creators, unlike Node's `fabric-contract-api`. It isn't used because its latest release, v2.2.4, needs Go 1.26.7, newer than the Go in `hyperledger/fabric-ccenv:2.5`, and because it refuses wrong calls with messages of its own, outside the error table that the test vectors pin. Its reflection and metadata add nothing a fixed list of sixteen functions needs.
- The election context binds the contract's own name, which the shim doesn't give. `chaincodeName` in `contract/identity.go` reads it from the signed proposal's `ChaincodeHeaderExtension`.

## Determinism

No function reads a clock or any randomness, and no write depends on the order of a Go map. `CreateElection` is the one function that reads the transaction's timestamp, which the client sets and every endorser reads the same from the proposal, to refuse a `closesAt` that has already passed. Ballots and closing read no time. Records and posts are written from structs, whose fields marshal in a fixed order. Ballots are read by range in key order and the trustees' posts by point reads in the order of the trustee list. `TestEndorsersAgree` runs a whole election twice and compares every write byte for byte, and `TestNoClockOrRandomness` refuses `time.Now` and the random packages in the contract's source, and allows `GetTxTimestamp` only in the one function `CreateElection` calls. The tests' stub fails any other function that reads the timestamp.

## Building and testing

`go.mod` says `go 1.26.3`, the oldest Go that IBM idemix v0.3.1 builds with, and has no `toolchain` line. `hyperledger/fabric-ccenv:2.5` builds the contract with the Go of Fabric 2.5.16, 1.26.4, with `GOTOOLCHAIN=auto`, so the `go` line is older than the image's Go, as ADR 0007 requires, and the image builds it without downloading a toolchain. A `toolchain` line newer than 1.26.4 would make the image download that toolchain, and the build would fail on a peer without network access (`pnpm check:mac` builds it with `--network none` to check this). The gRPC and protobuf versions are those Fabric 2.5.16 uses, and `golang.org/x/net`, `x/sys` and `x/text` are those IBM idemix v0.3.1 requires.

The pseudonym proof uses IBM mathlib v0.3.2 for FP256BN, on `hyperledger/fabric-amcl`, and IBM idemix v0.3.1's dlog package to decode issuer keys and verify creators' proofs, both Apache 2.0, the code Fabric's idemix MSP runs. mathlib links gnark-crypto's other curves too. With them, `vendor/` is 0.7 MB larger, 17.7 MB, and the chaincode package 0.2 MB larger, 3.3 MB, than before voter credentials.

```sh
go vet ./...
go test ./...                                   # reads ../../packages/tally/vectors/v1 and the contract API page
go test ./pseudonym -run TestVectorsFile -update   # writes pseudonym/testdata/v1 again; it must not change
go test -run XXX -fuzz FuzzDecode ./pseudonym
go test -run XXX -fuzz FuzzParseBallot ./internal/tally
go test -run XXX -bench . ./internal/tally
go build .                                      # the chaincode binary
```

The contract's tests run on an in-memory peer in `contract/stub_test.go`, which endorses each call against the committed state and validates it on commit, with `MVCC_READ_CONFLICT` and `PHANTOM_READ_CONFLICT`, as a Fabric peer does. They drive every test vector through the contract's functions: each election's ceremony, ballots, close, decryption shares and tallies, and every negative vector with its message. `contract/anonymous_test.go` casts voter credentials' ballots through `CastAnonymousBallot`, with creators built as Fabric's idemix MSP serialises them from a scratch issuer key, and ballots from a prover in the test. When the whole suite runs, `TestMain` reads the error tables in the contract API page and fails if a refusal isn't one of their rows, or if no test reaches a row that this version can reach.

`internal/tally`'s tests read the same vectors and must agree with the TypeScript tests in `@weftwallet/tally` on every case. A negative vector passes only when the contract's message is the vector's, word for word.

## Deploying

`pnpm playground:up --experimental` deploys it on every election's channel, with test-network's `deployCC -ccl go` and `AND('Org1MSP.peer','Org2MSP.peer')` ([the playground's README](../../playground/README.md#the-experimental-channels)). By hand, on a channel test-network's peers have joined:

```sh
cd devnet/.fabric/fabric-samples/test-network
./network.sh deployCC -c privatevote-budget-2027 -ccn private-ballot \
  -ccp ../../../../contracts/private-ballot -ccl go \
  -ccep "AND('Org1MSP.peer','Org2MSP.peer')"
```

`deployCC` runs `go mod vendor` in this folder, and the peer builds the contract in Docker from `vendor/` without the network. `vendor/` stays out of git (see the repository's `.gitignore`). Deploy it again with `-ccv` and `-ccs` set to the next sequence after changing it.

## The ristretto255 library

`internal/tally` uses [`github.com/gtank/ristretto255`](https://github.com/gtank/ristretto255) v0.2.0, on [`filippo.io/edwards25519`](https://github.com/FiloSottile/edwards25519) v1.2.0. Both are under the BSD 3-Clause licence, which fits Weft's Apache 2.0.

- `filippo.io/edwards25519` is the Go standard library's `crypto/internal/fips140/edwards25519` published as a module, and it follows upstream. That code was in the scope of [Trail of Bits' audit of Go's cryptography](https://go.dev/blog/tob-crypto-audit), published on 19 May 2025, whose one finding in it (TOB-GOCL-6, a `SetCanonicalBytes` that wasn't constant time) is fixed in v1.2.0. v1.1.1 and later also fix CVE-2026-26958 in `MultiScalarMult`. The module requires v1.2.0 for both, although `gtank/ristretto255` v0.2.0 asks only for v1.1.0.
- `gtank/ristretto255` adds the RFC 9496 encoding, decoding and group operations to it, with the scalar field. George Tankersley and Henry de Valence, two of its authors, are among the authors of RFC 9496. No published audit of the package itself was found when it was chosen, so its 670 lines join the review list. Its last release, v0.2.0, is from August 2025 and updates it to RFC 9496.
- Using `filippo.io/edwards25519` directly would mean writing ristretto255's encoding and decoding by hand, which is the part most easily got wrong. `github.com/bwesterb/go-ristretto` has curve arithmetic of its own and doesn't share the standard library's code.

The test vectors check that this library and noble agree: every encoding, every refusal of a non-canonical point or scalar, and every proof.

## Written by hand, for review

The framing, `expand_message_xmd` with SHA-512, the hash to a scalar, the check of noble's DKG proof of knowledge, the strict JSON parser and the order of its checks, the 0-or-1, sum, confirmation and decryption share verifiers, the key and verifying shares from the commitments, the Lagrange combination and the count. In `pseudonym/`, the encodings of G1 points and scalars, the pseudonym proof's prover and verifier, and the issuer key's checks beyond IBM idemix's own. In `contract/`, the caller checks, the state machine and the order of its checks. The benchmark's prover in `bench_test.go` exists only to time proving in Go, and the contract never proves.
