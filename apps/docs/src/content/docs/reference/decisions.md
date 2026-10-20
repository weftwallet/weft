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

**Trade-off:** keys can't be exported for backup. Recovery is re-enrolment with the CA, which is how Fabric organisations already work. Protection at rest currently relies on the browser profile; passkey wrapping is planned.

## 0003: A request-based provider, and org invites

dApps talk to `window.weft.request({ method, params })` with `weft_*` methods and EIP-1193-style error codes, so they're unaffected if the transport under the wallet changes. Organisations publish an **invite** (JSON over HTTPS) so users join a network from one link instead of typing CA and relay URLs.
