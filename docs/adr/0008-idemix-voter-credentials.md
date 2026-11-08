# 0008: Hide who voted with Idemix voter credentials, as an experiment

Proposed on 1 November 2026 as an experiment, revised on 8 November 2026, and built on 8 November 2026. Decided by Ifeanyi Ugwu.

This record applies only to the Weft Experimental build, the playground's experimental channels and `examples/private-ballot-contract`, which it shares with ADR 0007. ADR 0004 and ADR 0006 remain the main product's decisions. All of it is built, behind the experimental switches: the idemix module in `packages/idemix`, the per-election pseudonym in the contract's `pseudonym` package, `CastAnonymousBallot`, idemix signers and voter invites in the relay, enrolment and anonymous ballots in Weft Experimental, the explorer's reading of idemix organisations and anonymous ballots, and the playground's voters' CA, its `chair-2027` election and its Private election section for voter credentials. No one outside the project has reviewed the pseudonym proof.

## Context and problem

Every Fabric transaction carries its submitter's identity, and every member organisation's peer stores it. With X.509 identities that names the voter on every ballot. An explorer can hide submitters from the public (ADR 0004) but not from the member organisations, and ADR 0007's private tally hides the choice and leaves the fact of voting visible.

Fabric's Identity Mixer (Idemix) is the only anonymous identity that Fabric verifies natively. An idemix organisation in the channel configuration holds an issuer public key from Fabric CA. A member signs with a zero-knowledge proof that it holds a credential from that issuer for an organisational unit and role, under a pseudonym that can be new for every transaction. The transaction shows the MSP ID, the organisational unit and the role, and not the enrolment ID.

No idemix signer exists for JavaScript or WebAssembly. The Node SDK never had one, and Fabric's documentation names only the Java SDK as a client API. Fabric's idemix MSP also has known limits: idemix organisations can't endorse, revocation doesn't work, credentials have no expiry, and the attributes are fixed to four. It accepts every credential from the channel's issuer key, whatever its organisational unit and role, and Fabric CA issues credentials beyond the voters': with its default configuration, its bootstrap admin can enrol for as many as it likes under the root affiliation, and every identity a registrar creates gets credentials with its own affiliation and role.

I ran a study on 1 November 2026 that built a prototype: IBM's idemix library compiled to WebAssembly, driven through the relay's offline-signing flow, against a local Fabric 2.5.16 network with a voters' idemix organisation. Every voter signature came from the WebAssembly module, and the peer accepted them. The contract refused a second vote from one credential and a proof replayed by another voter. A voter holding an X.509 certificate got three credentials and voted three times. [Prototype results](../../apps/docs/src/content/docs/experimental/prototype-results.md) has every run and timing. This record follows the study's recommendations, revised on 8 November 2026 with the decisions from modelling the step that builds it.

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

The voter credential is one new identity kind, used for `weft_castBallot` and nothing else. Weft never connects it to a site, `weft_identity` never returns it, and `weft_signIn` isn't offered for it, because sign-in signs with ECDSA and the explorer checks a certificate chain. An idemix verifier for sign-in is out of scope for a first version. Weft's other identities stay X.509.

A voter credential is never the active identity. Weft lists it in a group of its own under Identities, named by the election, and never offers it in Home's identity picker or to `weft_connect`, `weft_submit` or `weft_evaluate`. A site can't reach it, so nothing a site does depends on it, and with only voter credentials Weft has no identity for sites.

### One vote per credential

The main product's ballot contract keys its "voted" marker on the voter's MSP ID and client ID. An idemix creator has no client ID, and its pseudonym changes with every transaction. Fabric's verifier has no pseudonym that stays the same within a scope, so Weft adds one. A per-election pseudonym P is derived from the credential's secret key and a point hashed from the channel and the election ID. Weft sends P with each ballot, with a Schnorr proof that the secret key behind P is the one inside the transaction's pseudonym (Nym), which the peer has already checked against the channel's issuer key. The contract keys its marker on a hash of P, which is ADR 0007's voter tag.

The same credential in the same election always gives the same P, and the contract refuses a second ballot. Pseudonyms in different elections can't be linked, under the decisional Diffie-Hellman assumption in G1. The proof is bound to the transaction's Nym and to the ballot, so another voter can't reuse it. P isn't derived from the enrolment ID, because the CA, its registrars and anyone with the voter list know it and could compute every voter's pseudonym. P and its proof go in public arguments instead of transient data, so the explorer can check every ballot's proof and count distinct pseudonyms.

The proof is Weft's own cryptography, about 150 lines of Go on IBM's mathlib. It is a standard construction, and it needs an external review before anyone relies on it. It is specified before any code, to the private tally specification's standard: exact bytes, the specification's framing and label style, `issuerKeyHash` as SHA-256 of the issuer key's bytes, every check the verifier makes, and a written security argument for the review. The prover and the verifier are one Go package in the contract's module, which Weft's WebAssembly module compiles too, so one source is reviewed and the same test vectors run against both builds. There is no TypeScript verifier: FP256BN has no maintained, audited JavaScript library, and the explorer can run the same module.

### One credential per voter, enforced at the CA

A voter with two credentials has two secret keys, two pseudonyms and two votes. Fabric CA issues as many idemix credentials as an X.509 holder asks for: its idemix endpoint accepts a token signed with an X.509 enrolment certificate, and that route isn't counted against `maxenrollments`. Its bootstrap admin, and any identity a registrar creates, get credentials too.

The contract accepts an anonymous ballot only from an idemix creator of the election's voter MSP whose organisational unit is the affiliation the election names and whose role is member. The peer's idemix MSP has already checked that the credential behind the Nym carries both. This refuses the bootstrap admin's credentials, which have the root affiliation, every identity outside the voters' affiliation, and every admin credential, however they were issued.

The contract can't tell two credentials of one voter ID apart, so one vote per person also depends on the voters' CA:

- It registers only voters in the election's affiliation, each with `maxenrollments 1` and no role attribute.
- Voters reach it only through a proxy that passes its `cainfo` and idemix credential requests with basic authorisation and refuses everything else, so no voter ID gets an X.509 certificate or uses token authorisation. The playground's CA proxy does this for each voters' CA.
- The operator counts the credentials per enrolment ID in the CA's `credentials` table while voters enrol and before the trustees close the election, because voters enrol while it is open. The playground counts on every `playground:up` and `playground:count`, and `playground:count` refuses to close an election with an ID that has more than one, unless told otherwise.
- A voter invite is a document that normal Weft recognises and doesn't enrol from, saying that only Weft Experimental can hold voter credentials, so a voter can't spend the one enrolment on an X.509 certificate by accident.

A limit on idemix credentials per enrolment ID in Fabric CA itself would be better, and may be proposed upstream later.

### A new issuer key per election

Revocation doesn't work in Fabric's idemix and credentials don't expire, so a leaked credential could vote in every election under the same issuer key. Each election gets its own issuer key, from its own voters' Fabric CA server, and its own channel, whose only idemix MSP is the election's. Fabric recommends one idemix MSP per channel, and a channel per election keeps one election's voters from reading another's ballots. `CreateElection` runs as an X.509 identity of a trustee organisation and pins the issuer public key, its SHA-256, the affiliation and the role. It checks that the key passes IBM idemix's own check and that the hash is SHA-256 of the key's bytes. The contract can't read the channel configuration, and the explorer compares the pinned hash with SHA-256 of the key in the configuration block, so a record whose hash didn't match its key would make that comparison meaningless.

### The contract

The contract is ADR 0007's Go contract, which verifies the pseudonym proof natively, with its `pseudonym` package on IBM's mathlib, and decodes the issuer key with IBM's idemix library. The Node contract library, `fabric-contract-api`, builds an X.509 client identity for every transaction, and in the prototype every call from an idemix creator failed with "Failed to find start line or end line of the certificate". The contract accepts anonymous ballots only from idemix creators of the election's voter MSP, with its affiliation and the role member. Endorsement and lifecycle policies name only the X.509 organisations, since idemix organisations can't endorse.

### Signing in Weft

Weft signs with a Go build of IBM's idemix library compiled to WebAssembly, with about 300 lines of Go around the library. All dependencies are Apache 2.0 or BSD, and the build is pinned, reproducible and tested against Fabric 2.5 and 3.x networks. The module is built from Go source in `packages/idemix` with a pinned Go toolchain, and only its SHA-256 is committed: a 13 MB binary in git would stay in its history permanently and can't be reviewed in a diff, and a fetched release would add a host to trust. The build refuses a module whose hash isn't the committed one, and building it twice must give the same hash. Weft makes a new Nym and proof for every transaction, and two ballots can't be linked through the creator field. Fabric's own MSP makes one Nym per process, which every transaction from it would share.

The module is 12.7 MB, 2.9 MB gzipped, against 1.3 MB for Weft's normal Chrome build. Only the experimental build carries it, and it loads only when a voter credential is used. WebAssembly needs `'wasm-unsafe-eval'` in the extension pages' content security policy, and only the experimental build's manifest has it.

The module runs in a dedicated worker that the page needing it starts, the popup to enrol and the approval window to vote, and terminates when it is done. Terminating it frees the whole Go heap, which is the only wipe Go can promise. The background worker keeps the relay calls and passes the bytes to sign: Chrome's extension service worker can't start a worker, can stop in the middle of the module's start, and would keep the module, and the secret key, in memory between votes.

The secret key is a scalar used inside WebAssembly and can't be a non-extractable `CryptoKey` (ADR 0002). Weft stores it encrypted with AES-GCM under a key derived from the vault key with HKDF, as ADR 0006 does for receipts, and decrypts it into the worker to sign. It seals the credential, the enrolment ID and the revocation handle the same way, and an anonymous ballot's activity record too: a readable enrolment ID beside a readable transaction ID would link the voter to the ballot for anyone who can read the browser's files, such as an organisation's managed device.

### Enrolment and the relay

A voter enrols from a voter invite, which the election's relay serves. Besides the CA, the election, the channel and `issuerKeyHash`, the invite names the affiliation, the relay's operator, and each trustee organisation's MSP ID and CA chain. Weft compares the CA's issuer key with the invite's and starts the module before it sends the enrolment ID and secret, so a CA with another key, or a module that won't start, leaves the voter's one enrolment unused. It then does the two-step exchange with the CA's idemix endpoint and checks the credential. It never asks for an X.509 certificate for that ID.

A voter credential's organisation has no peers, so Weft can't check that a peer of the voter's own organisation signed the election it reads. It reads the election with a one-off identity and accepts the answer only when every endorsement in it verifies against a CA chain the voter invite pins, and there is at least one. The invite is already the source Weft trusts for the issuer key, so this adds no party to trust.

The relay passes an idemix signer to fabric-gateway as credentials and makes a gateway for each such request, since each identity signs one transaction and a cache would hold every one. It logs nothing for those requests, because its request log records the network address, which is what the election's relay must not keep. It still holds no secret and needs no signing change. The relay for an election sees the voter's network address and timing, and without ADR 0007 it would also see the choice. A party that doesn't count the election runs it, without request logs, and the voter invite names that party for the approval window to show.

The organisational unit is disclosed on every transaction, and a unique affiliation would name the voter. Every voter in an election is registered with the same one, for example `voters`. An anonymous ballot transaction then shows the voter MSP ID, the organisational unit, the role, a one-off Nym, P and its proof, the encrypted ballot and the time, and not the enrolment ID or the revocation handle. In the prototype's block 12, the strings `voter3`, `voter1` and `voter4` occurred 0 times.

### Fabric's limits

Weft doesn't fix Fabric's limits for now, and upstream changes are left for later. The Node contract library rejects idemix callers. Revocation is switched off, because Fabric CA builds every credential revocation information with `ALG_NO_REVOCATION`, and a new issuer key per election limits a credential to one election meanwhile. Weft says so on the credential's detail and in the voter invite's review, before the secret is typed, and explorers say so in the election's Voters row. The approval window doesn't, because by then it changes nothing the voter can do.

Explorers publish an anonymous ballot's creator, the voter MSP ID, the affiliation, the role, the one-off Nym and its proof, even where they hide submitters. It names no one and links nothing, and without it the browser's full check couldn't check that each pseudonym belongs to the identity that signed. An explorer checks each anonymous ballot's creator against the election's pinned issuer key, as a peer's idemix MSP checks it, and its pseudonym proof against that creator's Nym, with the same WebAssembly module Weft signs with: in its own process as it indexes each block, and in the reader's browser in the full check. The module has two functions for this, which need no secret. The explorer also compares the pinned issuer key with the voter organisation's key in the channel's configuration, and says so on the election's page when they differ. Fabric CA's idemix curves (default `FP256BN_AMCL`) are below the 128-bit level they were chosen for, which is accepted for ballots that close within days.

## Consequences

- Member organisations, the CA and the public see an anonymous member of the voter MSP. With ADR 0007 as well, they see neither who voted nor the choice.
- The contract refuses credentials of other affiliations and the admin role, so the voters' CA's own identities can't vote. One vote per person still rests on the CA's configuration, its proxy and the operator's count as well as on cryptography. A mistake in them allows several votes per person, as the prototype showed.
- The voters' CA operator decides who is a voter and can register extra IDs, and nothing on the ledger shows that.
- Each election costs a CA server, an issuer key and a channel.
- A leaked credential can vote, and can't be cancelled within its election.
- The experimental build carries 12.7 MB of compiled code that has to be pinned, rebuilt reproducibly and reviewed, and a content security policy that allows WebAssembly. An experimental explorer that shows private elections needs the same module, built with Go, and its pages allow WebAssembly too.
- Checking an anonymous ballot costs an explorer about 120 ms in Node as it indexes the block, most of it the creator's proof, and the browser's full check about 100 ms per ballot in one worker after the module's start.
- A raw secret key sits in WebAssembly memory in a page's worker while it signs. Go's garbage collector doesn't guarantee those bytes are wiped, so Weft terminates the worker when the page is done.
- The voter invite is trusted for the issuer key, the relay's operator and the endorsers' CA chains. A forged invite could name another network, and the voter's check against it is the election fingerprint, which every explorer shows.
- The relay for an election learns the voter's network address and timing, and voters depend on whoever operates it.
- A small electorate, or timing, can still single a voter out. Counts are published only after the election closes.
- The pseudonym proof is new cryptography. It needs an external review before the feature leaves the experimental track (ADR 0009).

## More information

- [Voter credentials](../../apps/docs/src/content/docs/experimental/voter-credentials.md) has the voters' CA setup, the voter invite, enrolment, signing, the pseudonym proof and what Weft stores.
- [Prototype results](../../apps/docs/src/content/docs/experimental/prototype-results.md) has the prototype network, every run and the timings.
- [What isn't hidden](../../apps/docs/src/content/docs/experimental/what-is-not-hidden.md) gives Fabric's limits in full and the limits for voters.
- Under [0009](0009-experimental-track.md), a change to the main product's records waits until this feature leaves the experimental track.
