# 0007: Hide the choice with a homomorphic tally, as an experiment

Proposed on 1 November 2026 as an experiment, revised on 7 November 2026, and built on 8 November 2026. Decided by Ifeanyi Ugwu.

This record applies only to the Weft Experimental build, the playground's experimental channels and `contracts/private-ballot`. ADR 0004 and ADR 0006 remain the main product's decisions. All of it is built, behind the experimental switches: `@weftwallet/tally`, `contracts/private-ballot` with its verifiers in `internal/tally`, `weft-trustee` in `packages/trustee`, `weft_castBallot` and receipt version 2 in Weft Experimental, the explorer's private election pages with the full check, and the playground's Private election section.

## Context and problem

The ballot contract from ADR 0004 hides each choice from the public, and ADR 0006 lets Weft keep the voter's receipt. Several parties still see the choice:

| Party | Sees the choice with `contracts/ballot` | Why |
|---|---|---|
| The public, through an explorer | No | Only the commitment is on the ledger, and the salt stops a guess-and-hash attack. |
| Every member organisation | Yes | The collection policy lets each member's peers store the plaintext ballot. |
| Endorsing peers | Yes | The ballot reaches the contract as transient data on every endorser. |
| The relay | Yes | It builds the proposal, so it sees the private input. |
| The voting web app | Yes | The voter picks the option on its page. |

The count is only partly checkable. The explorer compares the published total with the number of commitments, and it can't check the count per option, because the counting happens inside the private collection. ADR 0004 and the elections guide say that hiding the choice from the member organisations needs blind signatures, mixnets or homomorphic tallying.

Whatever the contract verifies has to finish within Fabric's default 30-second execution timeout, with the same result on every endorser.

A Fabric transaction's timestamp comes from the proposal header, which the client writes. The shim's `GetTxTimestamp` returns that value, and no peer compares it with its own clock. Endorsement policies, at chaincode or key level, name the peers that must sign a result, not the client that submits it.

Reading from the ledger through the relay is a proposal signed with the voter's key, which ADR 0005 keeps encrypted until Weft is unlocked. Fabric CA returns the organisation's CA chain with every enrolment, and Weft doesn't keep it.

`@weftwallet/cli` is published, and every operator who builds an invite installs it.

I ran a study on 1 November 2026 that compared those options and built a prototype of the recommended one. The prototype ran a three-organisation key ceremony, cast five ballots, decrypted the right count with every pair of organisations, and refused each of the eight invalid ballots, shares and tallies it was given. [Prototype results](../../apps/docs/src/content/docs/experimental/prototype-results.md) has the runs and timings. This record follows the study's recommendations with two changes made afterwards: the contract is written in Go instead of TypeScript, and the work is an experiment on main behind a switch (ADR 0009) instead of a change to the main product.

## Decision drivers

- The relay, the voting web app and the member organisations don't learn the choice.
- Anyone with ledger access can check the count per option.
- The contract verifies each ballot within the timeout, deterministically.
- Ballot size and speed in JavaScript, where Weft and the explorer run.
- Libraries under licences that fit Weft's.

## Considered options

1. Exponential ElGamal over ristretto255, with a key the trustee organisations share, validity proofs and a homomorphic tally (chosen).
2. Verifiable re-encryption mixnets. They handle any ballot shape, and secrecy holds if one mixer is honest. Verification is linear in the number of ballots, with several multiplications per ciphertext, and for 10,000 ballots was estimated at about 100 seconds in Node chaincode. That is past the 30-second timeout, and the contract could only store mixes and leave all checking to explorers. The maintained mixnet, Verificatum, is Java under the AGPL, and the study found no permissively licensed TypeScript shuffle prover.
3. Blind signatures, as in Fujioka, Okamoto and Ohta's scheme (RFC 9474 for blind RSA). They hide the link between voter and ballot, and only when the ballot is submitted anonymously, which Fabric doesn't offer for X.509 identities. The ballot itself stays readable. The signer can also issue tokens for registered voters who never vote and cast those ballots itself, and the token and ballot together prove the vote to anyone.
4. The same design in ElectionGuard's 4096-bit prime-order subgroup. In the prototype one 4096-bit exponentiation took 8 to 14 ms against 0.5 to 1.4 ms for a ristretto255 multiplication, and a ciphertext is 1,024 bytes per option instead of 64. Option 1 gives up compatibility for this: ElectionGuard's own verifiers can't read Weft's election records.
5. Doing nothing, which keeps ADR 0004's limit, stated to voters. This remains the main product's position. It is rejected for the experimental track, which tests whether a private tally can work in Weft before anyone decides whether the main product should have one.

## Decision

The private tally follows Helios. Each ballot is encrypted under a key that the trustee organisations share and proves that it is well formed. The contract adds up the encrypted ballots, and the trustees jointly decrypt only the totals. Ballots use exponential ElGamal over ristretto255 (RFC 9496), through `@noble/curves` in TypeScript. The design follows ElectionGuard's structure (guardians with a threshold key ceremony, ciphertexts with validity proofs, tracking codes, a separate verifier) without its 4096-bit integer group. The tally is built before ADR 0008's voter credentials, because it works with ordinary X.509 identities and needs no change at the CA.

### The election key

The trustee organisations run a key ceremony over the ledger, a Pedersen distributed key generation in the three-round structure of noble's FROST module. It ends with a joint public key whose secret no organisation knows, and a Shamir share for each trustee. No share reaches the contract or the ledger in readable form. Trustees act through `weft-trustee`, the command of a private package, `@weftwallet/trustee` in `packages/trustee`, which keeps the share on the organisation's own machine. It isn't a `weft trustee` command in `@weftwallet/cli`, because that would add `@hyperledger/fabric-gateway`, gRPC and unreviewed cryptography to a package every operator installs, which ADR 0009 keeps away from people who install Weft. If the feature leaves the track, its commands can move into `@weftwallet/cli` with the same subcommands.

Any k of the n trustees can decrypt, and fewer can't. The threshold k is set per election and defaults to a majority of the trustee organisations. The playground's network has two organisations, and its elections use 2 of 2. Choosing k = n gives the most secrecy, but lets any one organisation stop the count by losing or withholding its share.

### Proofs

Each ciphertext carries a proof that it encrypts 0 or 1, and the ballot carries one more proof that its ciphertexts add up to an encryption of exactly 1. Every challenge covers the election context, the voter tag, the ciphertext and the proof's commitments, which avoids the weak Fiat-Shamir fault that allowed forged proofs in Helios. Binding to the voter, and refusing any ciphertext already on the ledger or repeated within the ballot, stops the Helios replay attack in which a copied ballot reveals the voter's choice. The voter tag is a hash of the transaction creator's MSP ID and its identity within it, for an X.509 voter the enrolment ID in its certificate, together with the channel and the election ID, so the same voter has a different tag in each election. The enrolment ID is the certificate's common name, which Fabric CA sets to the ID in every certificate it issues for it, so a new certificate for the same ID, or the same certificate written differently, can't give a voter a second tag.

### Casting through Weft

The experimental build adds `weft_castBallot`, with the channel, contract and election ID. The voter chooses in Weft's approval window, and the web app never learns the choice.

Weft opens the window once the params check, and unlocks there if it is locked. It then reads the election by endorsing `GetElection` without submitting, and checks that a peer of the voter's own organisation signed the answer, against the CA chain Weft keeps from enrolment. Where it has no chain, it reads without that check and says so. It works out the election context and the election fingerprint itself. The fingerprint is a short hash of the whole election context and the trustees' MSP IDs, which explorers show too. It doesn't cover the title or `closesAt`. Any failure before the vote shows in the window, and the site gets the error code as soon as Weft knows.

The window has two screens. The first shows the title, the options and the planned closing time, and the voter chooses. The second shows the choice, who holds the key, the threshold, the fingerprint and what the network sees, with Sign and vote. Weft then encrypts, proves, signs and submits.

Weft never takes the election key, or a finished ballot, from the web app. A key the web app supplies could be one whose secret the web app holds, and a finished ballot can't be checked to hold the option the voter saw. The contract refuses a ballot under any other key, as the prototype's wrong-key test shows.

### Receipt version 2

The receipt is a tracking code, a hash of the ballot with the voter tag and the election context, carried in a receipt with `version: 2`. It holds no choice and no randomness. Weft discards the encryption randomness once the ballot is built, because with it a voter could show anyone which option a ciphertext encrypts, as the salt in a version 1 receipt does. An ordinary voter then has nothing to sell or to be forced to show.

"Keep the receipt in Weft" stays, off by default, as in ADR 0006. When the voter turns it on, Weft also seals the choice as a note for the voter alone, under ADR 0006's receipt key.

### Counting and checking

Only the trustees close an election. `CloseElection` records a trustee's request, and the request that brings the number of trustees who have asked to k closes the election and adds up the accepted ballots per option. The contract checks the caller's MSP ID and its `weft.trustee=true` attribute itself, as for every trustee function, because an endorsement policy can't name the submitting client. The closing transaction is the cut-off: `CastBallot` reads the election record that the close rewrites, so a ballot committed after the close fails validation and one endorsed after it is refused. No contract function reads a clock. `CreateElection` alone reads the transaction's timestamp, to refuse a `closesAt` that has already passed. That is safe there because every endorser reads the same timestamp, and a creator that writes a wrong one can only make its own election show as past its planned closing time. Casting, closing and counting read no time. `closesAt` is the planned closing time, which Weft and explorers show. After it, the election stays open until k trustees close it. k is chosen because k trustees already decide whether the totals are decrypted: a smaller group can't end voting, and the n - k + 1 who could stop a close by not asking could already stop the count.

Each trustee posts a decryption share of each total with a proof, the contract checks it, and once k shares are in, `PublishTally` combines them and writes the counts. Every step is deterministic, so every endorser gets the same answer. The explorer can re-check the whole election from ledger data. Every ballot proof is bound to the voter tag, so an explorer whose policy has `privateElections` for a channel publishes each ballot's voter tag there, even with `submitter: hide`, and still hides the submitter's certificate, name and MSP ID. Its receipt check needs no choice, and ADR 0006's message hand-off isn't used for version 2 receipts.

### A Go contract, with the proofs written twice

`contracts/private-ballot` is written in Go, and `contracts/ballot` stays as it is. Go is chosen over TypeScript for three reasons:

- IBM's idemix library is Go, and ADR 0008's pseudonym proof is verified natively in the same contract.
- Node chaincode verifies about 40 three-option ballots a second per core with noble. The Go standard library's curve operations were 24 to 56 times faster than noble's in the prototype. Version 1's Go verifier, measured since, checks a three-option ballot in 0.68 ms, about 22 times as fast as version 1 in Node on the same machine.
- The Node contract library, `fabric-contract-api`, fails for every call from an idemix creator (ADR 0008).

The contract is one Go module with the verifiers in `internal/tally`. The peer builds it in Docker with test-network's `deployCC -ccl go`, as for the playground's other contracts, so it needs no new container or peer setting. `vendor/` stays out of git, and the `go` line in `go.mod` is no newer than the Go in `hyperledger/fabric-ccenv:2.5`.

The tally proofs therefore exist in Go in the contract and in TypeScript in one private package, `@weftwallet/tally` in `packages/tally`, which Weft Experimental, the trustee tool and the explorer share. It stays out of `@weftwallet/core`, so the check that the normal build holds none of it is a check on a package boundary. Test vectors in `packages/tally/vectors/v1/`, written from fixed seeds as JSON and run by both test suites, keep the two in step. Each negative vector carries the contract's exact error message.

### Left out of version 1

- A check before casting (the Benaloh challenge). Weft is open source, and the voter already trusts it with their key.
- Re-voting. A second ballot from the same voter is visible to every member, and on Fabric it gives little protection against coercion.
- Batch verification in the explorer, which would cut the time of a full check.

### Review gate

The ElGamal encryption, the proofs, the share encryption, the Lagrange combination and the transcript encoding are hand-written. In TypeScript, only the group, hashing to a scalar, the DKG rounds and SHA-256 come from audited libraries. The Go verifiers use `github.com/gtank/ristretto255` over `filippo.io/edwards25519`, the Go standard library's audited edwards25519 code. The ristretto255 layer has no published audit, and joins the review with the Go `expand_message_xmd`. The feature stays experimental until an external cryptographic review of the hand-written part and a maintainer's sign-off (ADR 0009). Until then, any page that says the choice is hidden from the organisations also says the feature is unreviewed.

## Consequences

- The relay, the endorsing peers and the member organisations see only ciphertext. The contract uses no private data collection and no transient data.
- Anyone with ledger access can check the whole count, including the count per option.
- Election creators choose trustees and a threshold. The trustee organisations run a ceremony before voting and a decryption step after it.
- Two implementations of the proofs have to be kept in step, with the test vectors as the contract between them.
- A three-option ballot is 640 bytes, or about 1,520 as hex JSON. `CloseElection` reads every ballot, and its read set grows with the electorate, as in `contracts/ballot`.
- Version 1 receipts and the main product's ballot contract keep working unchanged.
- Any k colluding trustees can read a single ballot, and nothing on the ledger would show it. If fewer than k can or will post shares, the totals can't be decrypted, and the election has to be run again.
- A voter running a modified Weft can keep the randomness and prove their vote. A bug or side channel in Weft that leaks the randomness reveals the vote.
- Weft Experimental keeps the CA chain that Fabric CA returns at enrolment and re-enrolment, and checks the voter's organisation's peer signature on the election it reads. For an identity it has no chain for, such as one imported from files, it reads the election without that check, and the window says so. The election fingerprint in the approval window, which explorers show too, is then the voter's check against a substituted key. A voter credential's organisation has no peers, and ADR 0008 checks the trustee organisations' peers for it instead, against CA chains the voter invite pins.
- k trustees decide when voting ends. They can close before `closesAt`, and the block the election closed in shows that to everyone who can read the channel.
- Explorers publish each ballot's voter tag, even where they hide submitters, because the full check needs it. An X.509 voter's tag names no one, but anyone who knows or guesses the voter's MSP ID and enrolment ID can compute it for an election and see that the voter voted in it. The tag covers the channel and the election ID, so one voter's tags differ between elections and can't be linked across them. Within an election, re-enrolling doesn't give a voter a second tag.
- Reading the election is a signed proposal, so the relay and the endorsing peers see which identity read it.
- Verification limits how many ballots a second an endorsing peer accepts, and the explorer's full check of 10,000 ballots takes minutes.
- The Pedersen key generation lets a participant bias the distribution of the joint key, which FROST and ElectionGuard also accept.
- Who voted, and when, stays visible to every member unless ADR 0008's voter credentials are used too.

[What isn't hidden](../../apps/docs/src/content/docs/experimental/what-is-not-hidden.md) gives each limit in full, with the throughput figures.

## More information

- [Private tally specification](../../apps/docs/src/content/docs/experimental/private-tally-spec.md) defines the encodings, the proofs, the ceremony, the voter tag and the test vectors.
- [Key ceremony](../../apps/docs/src/content/docs/experimental/key-ceremony.md) covers the trustees' steps, and [Contract API](../../apps/docs/src/content/docs/experimental/contract-api.md) the contract's functions.
- [Casting a ballot](../../apps/docs/src/content/docs/experimental/cast-ballot.md) defines `weft_castBallot` and receipt version 2.
- Under [0009](0009-experimental-track.md), a change to the main product's records waits until this feature leaves the experimental track.
