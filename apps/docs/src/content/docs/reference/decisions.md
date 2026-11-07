---
title: Architecture decisions
description: The decisions that shape Weft, and why.
---

Full records live in [`docs/adr`](https://github.com/ifeanyi-ugwu/weft/tree/main/docs/adr) in the repository.

## 0001: Reach the network through a stateless relay

Accepted on 19 October 2026.

Browsers can't open gRPC connections to Fabric peers. Rather than asking every organisation to run Envoy for gRPC-web and building Fabric protobufs in the browser, each organisation runs a relay that uses `@hyperledger/fabric-gateway` in offline-signing mode. The relay builds unsigned messages, the wallet signs, the relay forwards. Every request carries the bytes it needs, so the relay keeps no state.

The trade-off: one more service per organisation, and the relay sees transaction contents (as peers do). The wallet must verify everything it signs, because the relay builds it.

## 0002: Keep private keys as non-extractable WebCrypto keys

Accepted on 19 October 2026.

P-256 keys live in IndexedDB as non-extractable `CryptoKey` objects. Weft converts WebCrypto's `r‖s` signatures to low-S DER, which Fabric requires, and signs the message bytes rather than a digest, because WebCrypto always hashes.

The trade-off: keys can't be exported for backup. Recovery is re-enrolment with the CA, which is how Fabric organisations already work. ADR 0005 adds encryption at rest.

## 0003: Use a request-based provider API, and onboard through invites

Accepted on 19 October 2026, extended on 20 October 2026.

dApps call `window.weft.request({ method, params })` with `weft_*` methods and EIP-1193-style error codes, so they're unaffected if the transport under the wallet changes. Organisations publish an invite (JSON over HTTPS) so users join a network from one link instead of typing CA and relay URLs.

## 0004: Build an explorer that each organisation hosts

Accepted on 20 October 2026.

A Fabric ledger is readable only by channel members, so an explorer runs as an organisation, from its own peers, with a read-only identity. Each organisation publishes channels and contracts at `public`, `members` (sign in with Weft) or `hidden`. Instances publish signed checkpoints of block hashes and cross-check each other, so a page shows how many organisations agree on each block.

The trade-off: a second service per organisation, with its own identity and database. Publishing is a disclosure decision, so everything starts hidden. For voting, the explorer can prove ballots were counted, not hide who voted from member organisations.

All four phases are built: one organisation's explorer, `public` and `members` levels with sign-in with Weft, signed checkpoints compared between organisations, and a ballot contract with election pages and receipt checks. See [Run an explorer](/operators/explorer/) and [Run an election](/guides/elections/).

## 0005: Encrypt keys at rest and lock the wallet

Accepted on 20 October 2026.

A random vault key encrypts every private key. Your password (PBKDF2) and any passkeys you add (WebAuthn PRF) each encrypt a copy of the vault key. Unlocking puts the vault key in the browser's in-memory session storage, so the background worker survives restarts; locking clears it. Weft locks after a period without use, on request, and when the browser closes.

The trade-off: a forgotten password with no passkey means enrolling again. Keys saved before this change can't be encrypted after the fact, so Weft asks you to re-enrol them.

## 0006: Keep ballot receipts in Weft, when the voter asks

Accepted on 1 November 2026.

A voting web app sends the receipt with the vote: `receipt` on `weft_submit`, with the election, the choice and the salt, or `"generate"` for Weft to choose the salt. Weft checks it against the private input being signed before any window opens. "Keep the receipt in Weft" starts off on every request, and only the voter can turn it on. The choice and salt are encrypted at signing with a key derived from the vault key, so Weft locking while the vote commits loses nothing, and kept until the voter removes the receipt, removes the identity or resets Weft. The app gets the finished receipt either way, and whether Weft kept it.

The explorer's receipt check gets the choice and salt by message from the page that opened it, never in its address, which the browser's history would keep. See [Run an election](/guides/elections/).

The trade-off: the app learns whether the voter kept the receipt in Weft. Copy and Download still leave a copy outside Weft, and say so.

## 0007: Hide the choice with a homomorphic tally, as an experiment

Proposed on 1 November 2026 as an experiment, and revised on 7 November 2026. It applies only to the Weft Experimental build, the playground's experimental channels and `examples/private-ballot-contract`. ADR 0004 and ADR 0006 remain the main product's decisions.

Each ballot is encrypted under a key that the trustee organisations share, k of n, with a majority by default and 2 of 2 in the playground. The scheme is exponential ElGamal on ristretto255, in the style of Helios and ElectionGuard. Each ballot carries proofs that it chooses exactly one option, bound to the election, the voter and the ciphertext. Voting ends when k trustees close the election on the ledger, not at a time the client sets. The contract then adds up the encrypted ballots, and k trustees decrypt only the totals, each with a proof. Trustees use `weft-trustee`, a private package that isn't part of `@weftwallet/cli`. The voter chooses in Weft's window through `weft_castBallot`, and the web app never learns the choice. Weft reads the election key from the ledger itself, never from the web app, and shows an election fingerprint that every explorer shows too. The receipt is a tracking code, and Weft discards the encryption randomness, which leaves the receipt unable to prove the vote. The contract is written in Go, the proofs exist in Go and in one private TypeScript package, `@weftwallet/tally`, and shared test vectors keep them in step. Explorers can re-check the whole count. See [Experimental features](/experimental/overview/).

The trade-off: k colluding trustees could read any ballot, too few trustees stop the count, and a voter with modified software can still prove their vote. The cryptography is hand-written, and the feature stays experimental until an external cryptographic review and a maintainer's sign-off.

## 0008: Hide who voted with Idemix voter credentials, as an experiment

Proposed on 1 November 2026 as an experiment, under the same terms as 0007, and built on top of it.

A voter enrols with the election's idemix CA and gets a voter credential, an identity kind used only for casting ballots. Weft signs with IBM's idemix library compiled to WebAssembly, with a new pseudonym for every transaction. One vote per credential comes from a per-election pseudonym with a proof that Weft adds to the ballot. One credential per voter is enforced at the CA, because in the prototype a voter with an X.509 certificate got three credentials and voted three times. Each election gets a new issuer key, because Fabric's idemix has no revocation. See [Voter credentials](/experimental/voter-credentials/) and [Prototype results](/experimental/prototype-results/).

The trade-off: one vote per person depends on the CA's configuration, the experimental build carries 13 MB of WebAssembly, the relay sees the voter's network address, and Fabric's idemix curves are below the 128-bit level. The pseudonym proof needs an external review.

## 0009: Build experiments on main, behind a build switch

Accepted on 1 November 2026.

`WEFT_EXPERIMENTAL=1` builds Weft Experimental, a separate extension that installs alongside Weft with its own storage. Only it carries the idemix module and offers `weft_castBallot`, and pages detect it through `window.weft.features`. The playground, relay and explorer have matching switches, and the docs have an Experimental section. A feature leaves the track only after an external cryptographic review and a maintainer's sign-off. Until then, its records don't amend the main product's.

The trade-off: main holds code most users never run, and both builds must be tested.
