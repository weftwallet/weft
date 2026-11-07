---
title: Prototype results
description: What the private tally and voter credential prototypes of 1 November 2026 ran, refused and measured.
---

:::caution[Experimental]
This page describes Weft Experimental, a separate build that is not part of the main product, and nothing on it applies to Weft as you install it. No one outside the project has reviewed its cryptography. The results on this page come from the studies' prototypes, except [version 1's timings](#version-1-measured), which come from `@weftwallet/tally` and the contract's `internal/tally`, [the peers'](#on-a-fabric-peer-version-1) and [the explorer's](#the-explorer-version-1).
:::

The studies behind [ADR 0007](/reference/decisions/) and [ADR 0008](/reference/decisions/) each built a prototype on 1 November 2026. Where version 1 differs from a prototype, the [specification](/experimental/private-tally-spec/) says so.

## Private tally

The prototype ran a three-organisation key ceremony, cast five ballots (Ada 1, Grace 3, Alan 1), verified each one twice as two endorsers would, and decrypted the right count with every pair of organisations.

It refused each of these:

- a ballot sent by another voter
- a repeated ballot
- a slot holding 2
- two options chosen
- a ballot under another key
- a changed proof value
- a decryption share made with another key
- a tally from one organisation alone

The [test vectors](/experimental/private-tally-spec/#test-vectors) include these eight refusals as negative vectors.

### Timings

Node 22.22.0 and headless Chromium 141 on a 2.8 GHz Xeon with two cores, means of 20 to 40 runs after warm-up, with noble 2.4.0.

| Options | Encrypt and prove, Node | Encrypt and prove, Chromium | Verify, Node | Verify, Chromium | Bytes | Hex JSON |
|---|---|---|---|---|---|---|
| 2 | 12.6 ms | 16.1 ms | 16.9 ms | 14.8 ms | 448 | 1,086 |
| 3 | 19.8 ms | 20.1 ms | 24.3 ms | 23.5 ms | 640 | 1,520 |
| 5 | 31.3 ms | 26.6 ms | 35.0 ms | 38.4 ms | 1,024 | 2,388 |
| 10 | 54.8 ms | 55.4 ms | 77.2 ms | 88.9 ms | 1,984 | 4,558 |

| Step | Measured |
|---|---|
| Key ceremony, three trustees in one process | 152 ms in Node, 120 ms in Chromium |
| Add up 1,000 three-option ballots | 24 ms |
| One trustee's decryption share for three options | 12 ms to make, 13 ms to verify |
| Count search for a count of 1,000 | 6 ms |
| Count search for a count of 10,000 | 54 ms |

### The group, against ElectionGuard's

One 4096-bit exponentiation, the operation of ElectionGuard's integer group, took 8 to 14 ms. A ristretto255 multiplication took 0.5 to 1.4 ms. A ciphertext in the 4096-bit group is 1,024 bytes per option, against 64 in ristretto255.

### Version 1, measured

Version 1's code was timed on 7 November 2026 on a 2.3 GHz Intel Xeon with two cores: Node 22.22.0 with noble 2.4.0 (`pnpm --filter @weftwallet/tally bench`, means of 40 to 100 runs after warm-up), and Go 1.24.7 with `github.com/gtank/ristretto255` v0.2.0 on `filippo.io/edwards25519` v1.2.0 (`go test -bench . ./internal/tally`, three runs of 3 seconds). Verifying includes parsing the JSON and the tracking code. The contract never proves, so the Go prover is a test-only one, there to compare.

| Options | Encrypt and prove, Node | Encrypt and prove, Go | Verify, Node | Verify, Go | Hex JSON |
|---|---|---|---|---|---|
| 3 | 11 ms | 0.69 ms | 15 ms | 0.68 ms | 1,521 bytes |
| 10 | 31 to 34 ms | 2.2 ms | 44 ms | 2.1 ms | 4,560 bytes |

Go verifies about 22 times as fast as Node on the same machine. An endorsing peer's checks of one three-option ballot take about 0.7 ms of one core in Go, which is about 1,400 ballots a second before the contract's ledger reads and writes, against about 65 in Node.

The study's estimate, made before any Go ristretto255 library could be fetched, was 1 to 2 ms from the ratio of the Go standard library's X25519 and P-256 multiplications to noble's (24 and 40 to 56 times). The measurement is below that range.

### On a Fabric peer, version 1

The contract was timed on 7 and 8 November 2026 on the native network the step 4 tests ran on: Fabric 2.5.16 peers and three Raft orderers run as processes, without Docker, on the machine the explorer's timings below come from, with `private-ballot` built by the peers' Go builder and endorsed by `AND('Org1MSP.peer','Org2MSP.peer')`. Each time is a peer's own "finished chaincode" duration for one endorsement, which covers the contract's ledger reads and writes as well as its checks.

| Transaction | Measured on each endorsing peer |
|---|---|
| `CastBallot`, a three-option ballot, with its proofs, voter tag, tracking code and repeat checks | 2 to 11 ms, mean 4.3 ms |
| A ballot from `weft_castBallot`, from submitting the signed transaction to its commit | about 2 s |
| `CreateElection`, each round of the key ceremony, `OpenElection`, a decryption share and `PublishTally` | 1 to 5 ms each |
| `CloseElection`, the request that closes voting and adds up the ballots, for up to 13 ballots | 2 to 3 ms |

The time from submit to commit is the orderers' batch and block time, not the contract's. Across the whole of a ceremony or a count, the trustee tool's time is in its gateway calls and commits: `seedElection` creating an election and running its key ceremony for Org1 and Org2 (eight transactions, the last opening it) took 26 s, and `pnpm playground:count` closing an election, posting both decryption shares and publishing the tally took 14.5 s, both with the ledger reads between steps.

### The explorer's full check

The prototype's estimate was about 24 ms per three-option ballot in one browser thread: about 4 minutes for 10,000 ballots, and about 1 minute across four Web Workers. Batch verification, which folds all the proof equations into one large multi-scalar multiplication, is left for later.

### The explorer, version 1

The explorer's private election pages were timed on 8 November 2026 on a 2.1 GHz Intel Xeon with two cores: Node 22.22.0 for the indexer, and headless Chromium 141 for the full check, with `@weftwallet/tally` and noble 2.4.0, for three-option ballots in a 2 of 2 election. The browser had two cores, so the full check ran in two workers.

| Step | Measured |
|---|---|
| Indexing: checking one ballot as the block is read (decoding, the voter tag, the proofs, the tracking code and the repeat checks) | 23.7 ms |
| Indexing: one ballot in all, with decoding the block and storing it | 26.5 ms |
| Indexing 10,000 ballots from block 0 | 265 s, about 4.5 minutes |
| Full check, 13 ballots, as in the playground | 0.5 to 0.6 s in two workers, from pressing Check every ballot to the result |
| Full check, 10,000 ballots | 134 s, about 2.2 minutes, in two workers, including reading the ballots from the explorer |
| Full check, stopping at a changed ballot, 7th of 13 | 0.3 to 0.4 s |
| The full check's worker, minified | 53 KB, 20 KB gzipped |

The full check spends about 27 ms per ballot in each worker, so four workers would take about 1.1 minutes for 10,000 ballots, as the prototype estimated. On the native network, both organisations' explorers indexed every election the earlier steps had seeded and counted, and one seeded, voted in by eight voters and counted for this step, and found every ceremony post, key, ballot, total, decryption share and tally to check out. Batch verification, left for later, would cut both the indexing and the full check.

## Voter credentials

The prototype used channel `anonvote` on a local Fabric 2.5.16 network: three Raft orderers, peer0.org1 and peer0.org2, and the organisations Org1MSP and Org2MSP (X.509) and VotersMSP (idemix, with its issuer key from a scratch Fabric CA). Every voter signature came from the WebAssembly module, through the relay's offline-signing calls.

| Run | What happened | Result |
|---|---|---|
| Enrol voter3 from WebAssembly only | Two requests to `/api/v1/idemix/credential` with the enrolment ID and secret. The CA accepted the request the module built and issued a credential with OU `org1.department1`, role 1, revocation handle 3. | Issued |
| Enrol voter3 again | Same secret, `maxenrollments 1`. The CA answered code 20, authentication failure. | Refused |
| Native self-test | IBM idemix's own MSP, set up as a peer's is, validated the identity and the signature, and refused the signature over a different message. Two identities from one credential had different pseudonyms. | Valid |
| Sign fabric-gateway's wrapper bytes | The peer logged "creator is valid", then "pseudonym signature invalid". | Wrong bytes |
| Call `basic` (fabric-contract-api) with the right bytes | The peer accepted the signature and started the contract, which failed for every call with "Failed to find start line or end line of the certificate". | Contract API fails |
| WhoAmI on the prototype contract | The contract saw MSP ID VotersMSP, OU `org1.department1`, role member and a pseudonym. No enrolment ID. | As expected |
| voter3 votes in e1 | Endorsed, ordered, committed in block 12. | VALID |
| voter3 votes in e1 again | New transaction pseudonym, same per-election pseudonym: "This credential has already voted in this election." | Refused |
| voter1 (enrolled by `fabric-ca-client`) votes in e1 | A credential from the stock CLI works with the WebAssembly signer. Block 13. | VALID |
| voter4 replays voter3's proof | The proof is bound to the transaction's pseudonym: "scope pseudonym proof is not valid". | Refused |
| voter4 votes with its own proof | Block 14. | VALID |
| voter3 votes in e2 | Different election, unrelated per-election pseudonym. Block 15. | VALID |
| voter5 gets three credentials | One basic-auth enrolment used for an X.509 certificate, then three idemix credentials with token authorisation, each with a different secret key. | No limit |
| voter5 votes three times in e1 | Three different per-election pseudonyms. Blocks 16, 17 and 18. | Three votes |
| Decode block 12 | Creator: MSP ID VotersMSP, `nym_x` and `nym_y` (32 bytes each), OU, role, an 870-byte proof. `voter3`, `voter1` and `voter4` occur 0 times. | No name |

| Measure | Value |
|---|---|
| WebAssembly module, raw and gzipped | 13.0 MB and 3.0 MB |
| Compile and start the module | 497 ms |
| Load the issuer key | 105 ms |
| Build the CA credential request | 17 ms |
| New identity: check credential, new Nym, new proof | 171 to 254 ms |
| Nym signature, per message | 5 to 13 ms |
| Per-election pseudonym proof | 13 to 23 ms |
| Creator identity, signature, pseudonym proof | 1,019, 136 and 160 bytes |

The timings are from Node 22 on the build machine, and none were taken in a browser. A vote makes one identity and three signatures (proposal, transaction, commit status), about 0.3 s of signing after the module has loaded.
