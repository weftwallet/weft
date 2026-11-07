# 0002: Keep private keys as non-extractable WebCrypto keys

Accepted on 19 October 2026. Decided by Ifeanyi Ugwu.

## Context and problem

Fabric identities sign with ECDSA on P-256 (or P-384) over SHA-256, and peers reject signatures whose `S` value is in the upper half of the curve order ("high-S").

Browsers offer WebCrypto, which can generate and import P-256 keys and mark them non-extractable. Script can use a non-extractable key to sign and can never read the key material back out.

WebCrypto's ECDSA output differs from what Fabric accepts in two ways:

- It returns signatures in IEEE P1363 form (`r || s`), while Fabric expects ASN.1 DER.
- It never normalises `S`, and roughly half of all raw signatures are high-S.

WebCrypto also always hashes its input before signing.

## Decision

- Generated keys and imported PKCS#8 keys are stored as non-extractable `CryptoKey` objects in IndexedDB. Structured clone keeps them opaque.
- `@weftwallet/core` converts every signature to DER and flips `S` to `n - S` when it is high.
- The wallet signs the message bytes the relay returns, never a precomputed digest. ECDSA/SHA-256 over the bytes produces the same signature Fabric expects over `SHA-256(bytes)`.

## Consequences

- A compromised page or extension script can still use a key while the wallet is unlocked. Every signature therefore goes through the approval screen.
- Keys cannot be exported for backup. Recovery is re-enrolment with the organisation's CA, which matches how Fabric organisations already manage identities.
- The v0 vault relied on the browser profile for protection at rest. This record left that open, and ADR 0005 addresses it.

## More information

- [0005](0005-wallet-lock.md) encrypts keys at rest.
