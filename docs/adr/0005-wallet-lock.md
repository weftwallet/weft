# 0005: Encrypt keys at rest and lock the wallet

**Status:** Accepted
**Date:** 2026-10-20

## Context

ADR 0002 keeps private keys as non-extractable `CryptoKey` objects in IndexedDB. Script can't read them, but anyone who copies the browser profile, or sits at an unlocked computer, can use them. The browser stores IndexedDB unencrypted on disk, and a non-extractable key in a copied profile still signs. ADR 0002 left this open.

People expect a wallet to have a password and to lock itself. They also expect to unlock with a fingerprint or a security key where they can.

Constraints:

- A non-extractable key can't be encrypted afterwards. WebCrypto's `wrapKey` needs an extractable key.
- An MV3 background worker is stopped after about 30 seconds idle and loses its memory. A wallet that forgets its unlocked state every time the worker stops is unusable.
- WebAuthn's PRF extension gives a stable secret per passkey that a page can turn into an encryption key. Chromium supports it, but only some passkeys do (most platform passkeys and recent security keys; some password managers don't). Extension pages can call WebAuthn with the extension as the relying party.
- The popup closes when it loses focus, and the browser's passkey dialog takes focus.

## Decision

**A vault key encrypts every private key.** When Weft first needs to save a key, it asks for a password and creates a random 256-bit AES-GCM vault key. Keys are generated or imported as extractable for that moment only, encrypted with the vault key (`wrapKey`, PKCS#8, AES-GCM) and stored encrypted. The extractable `CryptoKey` is then dropped.

**The vault key is sealed once per way of unlocking.**

- Password: PBKDF2-SHA-256 with 600,000 iterations and a random salt derives a key that seals the vault key with AES-GCM.
- Passkeys (optional, any number): the PRF output for a random per-passkey salt goes through HKDF-SHA-256 to a key that seals the same vault key.

A wrong password or passkey fails AES-GCM's authentication, so it is detected rather than producing a wrong key. The password stays required; a passkey is a faster way in, never the only one, so losing a security key never loses the wallet.

**Unlocked means the vault key is in session storage.** On unlock the raw vault key goes into `chrome.storage.session`, which lives in memory, is cleared when the browser closes, and is readable only by the extension's own pages and worker (not content scripts). A worker that restarts reads it back. Keys are decrypted as non-extractable `CryptoKey` objects when first used and cached in the worker's memory.

**Locking** removes the vault key from session storage and clears the cache. It happens:

- when the user locks Weft,
- after a period without use (15 minutes by default; 5, 15, 60 or 240 minutes, or only when the browser closes), using an alarm,
- when the browser closes.

**What needs unlocking.** Signing does, and so do adding identities and changing security settings. Every approval window asks to unlock first if Weft is locked. Reading the active identity's public certificate and the network list does not, because sites already hold that information once connected; a lock that also hid it would break sites without protecting a secret.

**Passkey unlock runs in its own window**, because the popup would close when the passkey dialog opens. Approval windows run it inline.

**Keys saved before this change** are non-extractable and can't be encrypted. Weft keeps using them once unlocked, marks them in the identity list, and suggests re-enrolment, which creates a new, encrypted key.

## Consequences

- A copied profile without the password (or a passkey) gives encrypted keys only. The password is the weakest link; Weft asks for at least 8 characters and PBKDF2 slows guessing.
- While unlocked, anyone using the browser can approve requests, as before. Auto-lock limits how long that lasts.
- Forgetting the password with no passkey means re-enrolling every identity with its CA. There is no recovery by Weft, which matches ADR 0002's recovery story.
- For a moment after generation or import a key exists in extractable form inside the worker. Nothing reads it except `wrapKey`.
- PRF depends on the passkey. Weft checks for it when adding a passkey and explains when the passkey can't be used for unlocking.
