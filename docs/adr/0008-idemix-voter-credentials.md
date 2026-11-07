# 0008: Hide who voted with Idemix voter credentials, as an experiment

Proposed on 1 November 2026 as an experiment. Decided by Ifeanyi Ugwu.

This record applies only to the Weft Experimental build, the playground's experimental channels and `examples/private-ballot-contract`, which it shares with ADR 0007. ADR 0004 and ADR 0006 remain the main product's decisions. Nothing in this record is built yet.

## Context and problem

Every Fabric transaction carries its submitter's identity, and every member organisation's peer stores it. With X.509 identities that names the voter on every ballot. An explorer can hide submitters from the public (ADR 0004) but not from the member organisations, and ADR 0007's private tally hides the choice and leaves the fact of voting visible.

Fabric's Identity Mixer (Idemix) is the only anonymous identity that Fabric verifies natively. An idemix organisation in the channel configuration holds an issuer public key from Fabric CA. A member signs with a zero-knowledge proof that it holds a credential from that issuer for an organisational unit and role, under a pseudonym that can be new for every transaction. The transaction shows the MSP ID, the organisational unit and the role, and not the enrolment ID.

No idemix signer exists for JavaScript or WebAssembly. The Node SDK never had one, and Fabric's documentation names only the Java SDK as a client API. Fabric's idemix MSP also has known limits: idemix organisations can't endorse, revocation doesn't work, credentials have no expiry, and the attributes are fixed to four.

I ran a study on 1 November 2026 that built a prototype: IBM's idemix library compiled to WebAssembly, driven through the relay's offline-signing flow, against a local Fabric 2.5.16 network with a voters' idemix organisation. Every voter signature came from the WebAssembly module, and the peer accepted them. The contract refused a second vote from one credential and a proof replayed by another voter. A voter holding an X.509 certificate got three credentials and voted three times. [Prototype results](../../apps/docs/src/content/docs/experimental/prototype-results.md) has every run and timing. This record follows the study's recommendations.

## Decision drivers

- Voters are hidden from the member organisations and from the CA.
- Every peer verifies the anonymity, without a system outside Fabric.
- The relay holds no secret and keeps offline signing (ADR 0001).
- One vote per person.

## Considered options

1. Idemix voter credentials, signed in Weft with IBM's idemix library compiled to WebAssembly (chosen).
2. Pseudonymous X.509 certificates per election, from a separate CA that drops the link to the voter after issuing. They need about 3 weeks of work and no WebAssembly, and revocation works. They hide voters from the member organisations only if the CA operator is trusted, because the CA can record the link at issuance.
3. Blind-signed ballot tokens (RFC 9474), submitted under a shared identity. The submission still needs a Fabric identity. A shared signing key at the relay undoes ADR 0001, and an anonymous Fabric identity is Idemix anyway.
4. Full cryptographic voting, such as mixnets or anonymous credentials of Weft's own outside Fabric's MSP. It would be a separate voting system whose anonymity Fabric doesn't verify.
5. Doing nothing, which keeps ADR 0004's limit, with explorers hiding submitters from the public. This remains the main product's position, and it is enough when voters need hiding only from the public. It is rejected for the experimental track, which tests whether voters can be hidden from the member organisations too.

## Decision

Weft Experimental adds Idemix as a voter credential, used only to cast ballots and built on ADR 0007's private tally.

### A voter credential for ballots only

The voter credential is one new identity kind, used for `weft_castBallot` and nothing else. Weft never connects it to a site, `weft_identity` never returns it, and `weft_signIn` isn't offered for it, because sign-in signs with ECDSA and the explorer checks a certificate chain. An idemix verifier in the explorer is out of scope for a first version. Weft's other identities stay X.509.

### One vote per credential

The main product's ballot contract keys its "voted" marker on the voter's MSP ID and client ID. An idemix creator has no client ID, and its pseudonym changes with every transaction. Fabric's verifier has no pseudonym that stays the same within a scope, so Weft adds one. A per-election pseudonym P is derived from the credential's secret key and the election ID. Weft sends P with each ballot, with a Schnorr proof that the secret key behind P is the one inside the transaction's pseudonym (Nym), which the peer has already checked against the channel's issuer key. The contract keys its marker on a hash of P, which is ADR 0007's voter tag.

The same credential in the same election always gives the same P, and the contract refuses a second ballot. Pseudonyms in different elections can't be linked, under the decisional Diffie-Hellman assumption in G1. The proof is bound to the transaction's Nym and to the ballot, so another voter can't reuse it. P isn't derived from the enrolment ID, because the CA, its registrars and anyone with the voter list know it and could compute every voter's pseudonym. P and its proof go in public arguments instead of transient data, so the explorer can check every ballot's proof and count distinct pseudonyms.

The proof is Weft's own cryptography, about 150 lines of Go on IBM's mathlib. It is a standard construction, and it needs an external review before anyone relies on it.

### One credential per voter, enforced at the CA

A voter with two credentials has two secret keys, two pseudonyms and two votes. Fabric CA issues as many idemix credentials as an X.509 holder asks for: its idemix endpoint accepts a token signed with an X.509 enrolment certificate, and that route isn't counted against `maxenrollments`. One vote per person therefore depends on the CA:

- The voters' CA registers voter IDs with `maxenrollments 1`, used only for idemix and never given an X.509 certificate.
- The operator checks the count of credentials per enrolment ID in the CA's `credentials` table before the election opens.
- A voter invite is a document that normal Weft refuses, and a voter can't spend the one enrolment on an X.509 certificate by accident.

A limit on idemix credentials per enrolment ID in Fabric CA itself would be better, and may be proposed upstream later.

### A new issuer key per election

Revocation doesn't work in Fabric's idemix and credentials don't expire, so a leaked credential could vote in every election under the same issuer key. Each election gets its own issuer key, from its own voters' Fabric CA server, and its own channel, whose only idemix MSP is the election's. Fabric recommends one idemix MSP per channel, and a channel per election keeps one election's voters from reading another's ballots. `CreateElection` runs as an X.509 identity of a trustee organisation and pins the issuer public key. The contract can't read the channel configuration, and the explorer compares the pinned key's hash with the configuration block.

### The contract

The contract is ADR 0007's Go contract, which verifies the pseudonym proof with IBM's idemix library natively. The Node contract library, `fabric-contract-api`, builds an X.509 client identity for every transaction, and in the prototype every call from an idemix creator failed with "Failed to find start line or end line of the certificate". The contract accepts anonymous ballots only from the election's voter MSP. Endorsement and lifecycle policies name only the X.509 organisations, since idemix organisations can't endorse.

### Signing in Weft

Weft signs with a Go build of IBM's idemix library compiled to WebAssembly, with about 300 lines of Go around the library. All dependencies are Apache 2.0 or BSD, and the build is pinned, reproducible and tested against Fabric 2.5 and 3.x networks. Weft makes a new Nym and proof for every transaction, and two ballots can't be linked through the creator field. Fabric's own MSP makes one Nym per process, which every transaction from it would share.

The module is 13.0 MB, 3.0 MB gzipped, against 1.3 MB for Weft's normal Chrome build. Only the experimental build carries it, and it loads only when a voter credential is used. WebAssembly needs `'wasm-unsafe-eval'` in the extension pages' content security policy, and only the experimental build's manifest has it.

The secret key is a scalar used inside WebAssembly and can't be a non-extractable `CryptoKey` (ADR 0002). Weft stores it encrypted with AES-GCM under a key derived from the vault key with HKDF, as ADR 0006 does for receipts, and decrypts it into WebAssembly memory to sign.

### Enrolment and the relay

A voter enrols from a voter invite. Weft does the two-step exchange with the CA's idemix endpoint using the enrolment ID and secret, checks the credential, and compares the CA's issuer key with the one the invite names. It never asks for an X.509 certificate for that ID.

The relay passes an idemix signer to fabric-gateway as credentials and caches no gateway for it. It still holds no secret and needs no signing change. The relay for an election sees the voter's network address and timing, and without ADR 0007 it would also see the choice. A party that doesn't count the election runs it, without request logs, and the approval window names that party.

The organisational unit is disclosed on every transaction, and a unique affiliation would name the voter. Every voter in an election is registered with the same one, for example `voters`. An anonymous ballot transaction then shows the voter MSP ID, the organisational unit, the role, a one-off Nym, P and its proof, the encrypted ballot and the time, and not the enrolment ID or the revocation handle. In the prototype's block 12, the strings `voter3`, `voter1` and `voter4` occurred 0 times.

### Fabric's limits

Weft doesn't fix Fabric's limits for now, and upstream changes are left for later. The Node contract library rejects idemix callers. Revocation is switched off, because Fabric CA builds every credential revocation information with `ALG_NO_REVOCATION`, and a new issuer key per election limits a credential to one election meanwhile. Fabric CA's idemix curves (default `FP256BN_AMCL`) are below the 128-bit level they were chosen for, which is accepted for ballots that close within days.

## Consequences

- Member organisations, the CA and the public see an anonymous member of the voter MSP. With ADR 0007 as well, they see neither who voted nor the choice.
- One vote per person rests on the CA's configuration and the operator's check as well as on cryptography. A mistake in that configuration allows several votes per person, as the prototype showed.
- The voters' CA operator decides who is a voter and can register extra IDs, and nothing on the ledger shows that.
- Each election costs a CA server, an issuer key and a channel.
- A leaked credential can vote, and can't be cancelled within its election.
- The experimental build carries 13 MB of compiled code that has to be pinned, rebuilt reproducibly and reviewed, and a content security policy that allows WebAssembly.
- A raw secret key sits in WebAssembly memory while Weft is unlocked and signing, and Go's garbage collector doesn't guarantee those bytes are wiped afterwards.
- The relay for an election learns the voter's network address and timing, and voters depend on whoever operates it.
- A small electorate, or timing, can still single a voter out. Counts are published only after the election closes.
- The pseudonym proof is new cryptography. It needs an external review before the feature leaves the experimental track (ADR 0009).

## More information

- [Voter credentials](../../apps/docs/src/content/docs/experimental/voter-credentials.md) has the voters' CA setup, the voter invite, enrolment, signing, the pseudonym proof and what Weft stores.
- [Prototype results](../../apps/docs/src/content/docs/experimental/prototype-results.md) has the prototype network, every run and the timings.
- [What isn't hidden](../../apps/docs/src/content/docs/experimental/what-is-not-hidden.md) gives Fabric's limits in full and the limits for voters.
- Under [0009](0009-experimental-track.md), a change to the main product's records waits until this feature leaves the experimental track.
