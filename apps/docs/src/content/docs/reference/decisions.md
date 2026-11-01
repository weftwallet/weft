---
title: Architecture decisions
description: The decisions that shape Weft, and why.
---

Full records live in [`docs/adr`](https://github.com/ifeanyi-ugwu/weft/tree/main/docs/adr) in the repository.

## 0001: A stateless relay reaches the network

Browsers can't open gRPC connections to Fabric peers. Rather than asking every organisation to run Envoy for gRPC-web and building Fabric protobufs in the browser, each organisation runs a relay that uses `@hyperledger/fabric-gateway` in **offline-signing** mode. The relay builds unsigned messages, the wallet signs, the relay forwards. Every request carries the bytes it needs, so the relay keeps no state.

The trade-off: one more service per organisation, and the relay sees transaction contents (as peers do). The wallet must verify everything it signs, because the relay builds it.

## 0002: Keys are non-extractable WebCrypto keys

P-256 keys live in IndexedDB as non-extractable `CryptoKey` objects. Weft converts WebCrypto's `r‖s` signatures to low-S DER, which Fabric requires, and signs the message bytes rather than a digest, because WebCrypto always hashes.

The trade-off: keys can't be exported for backup. Recovery is re-enrolment with the CA, which is how Fabric organisations already work. ADR 0005 adds encryption at rest.

## 0003: A request-based provider, and invites

dApps call `window.weft.request({ method, params })` with `weft_*` methods and EIP-1193-style error codes, so they're unaffected if the transport under the wallet changes. Organisations publish an **invite** (JSON over HTTPS) so users join a network from one link instead of typing CA and relay URLs.

## 0004: An explorer that each organisation hosts

A Fabric ledger is readable only by channel members, so an explorer runs as an organisation, from its own peers, with a read-only identity. Each organisation publishes channels and contracts at `public`, `members` (sign in with Weft) or `hidden`. Instances publish signed checkpoints of block hashes and cross-check each other, so a page shows how many organisations agree on each block.

The trade-off: a second service per organisation, with its own identity and database. Publishing is a disclosure decision, so everything starts hidden. For voting, the explorer can prove ballots were counted, not hide who voted from member organisations.

All four phases are built: one organisation's explorer, `public` and `members` levels with sign-in with Weft, signed checkpoints compared between organisations, and a ballot contract with election pages and receipt checks. See [Run an explorer](/operators/explorer/) and [Run an election](/guides/elections/).

## 0005: Keys are encrypted with a password, and Weft locks

A random vault key encrypts every private key. Your password (PBKDF2) and any passkeys you add (WebAuthn PRF) each encrypt a copy of the vault key. Unlocking puts the vault key in the browser's in-memory session storage, so the background worker survives restarts; locking clears it. Weft locks after a period without use, on request, and when the browser closes.

The trade-off: a forgotten password with no passkey means enrolling again. Keys saved before this change can't be encrypted after the fact, so Weft asks you to re-enrol them.

## 0006: Weft keeps ballot receipts, when the voter asks

A voting web app sends the receipt with the vote: `receipt` on `weft_submit`, with the election, the choice and the salt, or `"generate"` for Weft to choose the salt. Weft checks it against the private input being signed before any window opens. **Keep the receipt in Weft** starts off on every request, and only the voter can turn it on. The choice and salt are encrypted at signing with a key derived from the vault key, so Weft locking while the vote commits loses nothing, and kept until the voter removes the receipt, removes the identity or resets Weft. The app gets the finished receipt either way, and whether Weft kept it.

The explorer's receipt check gets the choice and salt by message from the page that opened it, never in its address, which the browser's history would keep. See [Run an election](/guides/elections/).

The trade-off: the app learns whether the voter kept the receipt in Weft. Copy and Download still leave a copy outside Weft, and say so.
