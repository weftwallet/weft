---
title: Security model
description: What Weft protects against, how, and what it does not cover yet.
---

## What Weft protects

1. Nobody, including web pages, the relay and Weft's own UI code, should be able to read private keys, and a copy of your browser profile shouldn't be enough to use them.
2. Nothing should be signed that you didn't see and approve.
3. Web apps learn who you are only after you connect them, and only for the identities you connect them to.

## How

### Keys are encrypted with your password

The first time Weft saves a key, it asks you for a password and creates a random vault key. Each private key is encrypted with the vault key (AES-GCM) before it's stored in the extension's IndexedDB. The vault key itself is stored only in encrypted form: once with a key derived from your password (PBKDF2-SHA-256, 600,000 iterations) and once per passkey you add (from the passkey's PRF output). ([ADR 0005](/reference/decisions/))

When you unlock, the vault key is held in the browser's session storage, which lives in memory, is cleared when the browser closes, and can't be read by web pages or content scripts. Keys are decrypted into **non-extractable** `CryptoKey` objects: Weft can sign with them but its own code can't read them back. The background worker is the only place signing happens. ([ADR 0002](/reference/decisions/))

Fabric requires low-S DER signatures; Weft converts WebCrypto's output accordingly.

### Weft locks itself

Weft locks after 15 minutes without use (you can choose 5 minutes to 4 hours, or only when the browser closes), when you choose **Lock now** under **Security**, and when the browser closes. While locked, nothing can be signed and no identity can be added. A web app that asks for a signature gets an approval window that asks you to unlock first.

Web apps you connected can still read your public identity while Weft is locked, because they already have it.

Passkeys are optional and need the WebAuthn PRF extension, which most phone and laptop passkeys and recent security keys support. Your password always works, so losing a security key doesn't lock you out of Weft. Weft can't recover a forgotten password. **Forgot your password?** on the lock screen resets Weft instead: after you type a phrase to confirm, it deletes every identity and key in the browser and keeps your networks, so you can enrol again with your CA.

### Pages have no privileges

The provider in the page (`window.weft`) only posts messages. A separate content script forwards them to the background worker. The background worker takes the requesting site's origin from the browser, never from the message, so a page can't pretend to be another site.

### Every signature is checked

The relay builds the Fabric messages; Weft doesn't trust it to build the right ones. Before each signature, Weft decodes the protobuf bytes and checks:

- In the proposal: channel, chaincode, function (with contract prefix), every argument, every private input (names and values), endorsing organisations if requested, signer MSP ID and certificate, and that the transaction ID in the header matches.
- In the transaction: the same transaction ID and channel, and your certificate as creator.
- In the commit status request: the same transaction ID and channel.

Any mismatch stops the flow with "Weft refused to sign". This is covered by tests that build real messages with `@hyperledger/fabric-gateway` and tamper with them.

### Approval is explicit

Connecting a web app doesn't authorise signing. Each read and each write opens an approval window; closing it rejects. Reads and writes look different (teal and amber) so a write can't pass as a read.

### Sign-in signs text, never a transaction

`weft_signIn` signs a message Weft writes from fixed fields: the web app's origin as the browser reports it, the MSP ID, the web app's nonce, and five minutes of validity. A web app can add one line of text and nothing else. The message is text starting `weft-sign-in:v1`, so its signature can't be used as a signature over a Fabric proposal or transaction, which are protobuf bytes. The approval window says it doesn't sign a transaction.

### Ballot receipts are kept only when you ask

A voting web app can send a ballot receipt with a vote. Weft checks it against what you sign: the choice and salt in it must be the ones in a private input of the transaction, so a site can't have Weft keep anything else. Weft keeps it only if you turn on **Keep the receipt in Weft** in the approval window, which starts off on every request. ([ADR 0006](/reference/decisions/))

The choice and salt are the secret part: with them anyone can show which way you voted. Weft encrypts them (AES-GCM) when you press **Sign and submit**, with a key derived from the vault key, so they open only while Weft is unlocked and the encrypted value can't be moved onto another receipt. The election, transaction, block and commitment stay readable, since your activity and the ledger already show them. No site can read a kept receipt back. Removing the identity, or resetting Weft, deletes its receipts.

Copy receipt puts the salt on the clipboard, where clipboard history may keep it, and Download receipt writes a plain file. **Check in the explorer** doesn't put the choice or salt in an address, where the browser's history would keep them: a small window of Weft's opens the network's explorer with the transaction and commitment only, and gives the explorer's page the choice and salt by message once it asks, at its exact origin. The explorer takes them only from pages it trusts, and only to check them in your browser; it sends nothing back.

### Hosts are granted one by one

The extension's manifest asks for no host access up front. When you add a network, the browser asks you to allow its CA and relay hosts.

## Not covered yet

- While Weft is unlocked, anyone using your browser can approve requests. Auto-lock limits how long that lasts.
- Identities saved before Weft encrypted keys have keys that aren't encrypted on disk. Weft marks them and offers to re-enrol, which replaces the key.
- Weft doesn't check revocation before signing: it can't read the channel's revocation lists without a member identity. Peers refuse revoked certificates, and when they do, Weft checks the lists the network's explorer publishes and says the certificate was revoked rather than that access was denied.
- Relays don't authenticate wallets: any wallet can ask a relay to build proposals, and peers enforce which identities may transact. Restrict signers with `WEFT_ALLOWED_MSP_IDS`.

## Reporting a vulnerability

Please don't open a public issue. See `SECURITY.md` in the repository.
