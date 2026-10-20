---
title: Architecture decisions
description: The decisions that shape Weft, and why.
---

Full records live in [`docs/adr`](https://github.com/ifeanyi-ugwu/weft/tree/main/docs/adr) in the repository.

## 0001: A stateless relay reaches the network

Browsers can't speak native gRPC. Rather than asking every organisation to run Envoy for gRPC-web and building Fabric protobufs in the browser, each organisation runs a thin relay that uses `@hyperledger/fabric-gateway` in **offline-signing** mode. The relay builds unsigned messages, the wallet signs, the relay forwards. Every request carries the bytes it needs, so the relay keeps no state.

**Trade-off:** one more small service per organisation, and the relay sees transaction contents (as peers do). The wallet must verify everything it signs, because the relay builds it.

## 0002: Keys are non-extractable WebCrypto keys

P-256 keys live in IndexedDB as non-extractable `CryptoKey` objects. Weft converts WebCrypto's `r‖s` signatures to low-S DER, which Fabric requires, and signs the message bytes rather than a digest, because WebCrypto always hashes.

**Trade-off:** keys can't be exported for backup. Recovery is re-enrolment with the CA, which is how Fabric organisations already work. ADR 0005 adds encryption at rest.

## 0003: A request-based provider, and org invites

dApps talk to `window.weft.request({ method, params })` with `weft_*` methods and EIP-1193-style error codes, so they're unaffected if the transport under the wallet changes. Organisations publish an **invite** (JSON over HTTPS) so users join a network from one link instead of typing CA and relay URLs.

## 0004: An explorer that each organisation hosts (proposed)

A Fabric ledger is readable only by channel members, so an explorer runs as an organisation, from its own peers, with a read-only identity. Each organisation publishes channels and contracts at `public`, `members` (sign in with Weft) or `hidden`. Instances publish signed checkpoints of block hashes and cross-check each other, so a page shows how many organisations agree on each block.

**Trade-off:** a second service per organisation, with its own identity and database. Publishing is a disclosure decision, so everything starts hidden. For voting, the explorer can prove ballots were counted, not hide who voted from member organisations.

## 0005: Keys are encrypted with a password, and Weft locks

A random vault key encrypts every private key. Your password (PBKDF2) and any passkeys you add (WebAuthn PRF) each seal a copy of the vault key. Unlocking puts the vault key in the browser's in-memory session storage, so the background worker survives restarts; locking clears it. Weft locks after a period without use, on request, and when the browser closes.

**Trade-off:** a forgotten password with no passkey means enrolling again. Keys saved before this change can't be encrypted after the fact, so Weft asks you to re-enrol them.
