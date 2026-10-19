# 0002: Keep private keys as non-extractable WebCrypto keys

**Status:** Accepted
**Date:** 2026-10-19

## Context

Fabric identities sign with ECDSA on P-256 (or P-384) over SHA-256, and peers reject signatures whose `S` value is in the upper half of the curve order ("high-S"). Browsers offer WebCrypto, which can generate and import P-256 keys and mark them **non-extractable**: script can use the key to sign but can never read the key material back out.

WebCrypto ECDSA has two quirks we have to handle:

- It returns signatures in IEEE P1363 form (`r || s`), while Fabric expects ASN.1 DER.
- It never normalises `S`, so roughly half of all raw signatures are high-S.

## Decision

- Generated keys and imported PKCS#8 keys are stored as non-extractable `CryptoKey` objects in IndexedDB (structured clone keeps them opaque).
- `@weftwallet/core` converts every signature to DER and flips `S` to `n - S` when it is high.
- The wallet signs the **message bytes** the relay returns, never a precomputed digest, because WebCrypto always hashes its input. Signing the bytes with ECDSA/SHA-256 produces the same signature Fabric expects over `SHA-256(bytes)`.

## Consequences

- A compromised page or extension script can still *use* a key while the wallet is unlocked, so every signature goes through the approval screen.
- Keys cannot be exported for backup. Recovery is re-enrolment with the organisation's CA, which matches how Fabric organisations already manage identities.
- **Open item:** the v0 vault relies on the browser profile for protection at rest. A later version wraps each key with a passkey-derived key (WebAuthn PRF extension) so a stolen profile alone is not enough.
