---
title: Voter credentials
description: "Idemix voter credentials in Weft Experimental: the voters' CA, enrolment from an invite, the per-election pseudonym, what Weft stores, the relay and the explorer."
---

:::caution[Experimental]
This page describes Weft Experimental, a separate build that is not part of the main product, and nothing on it applies to Weft as you install it. No one outside the project has reviewed its cryptography. None of it is built yet, and the page describes the planned design.
:::

A voter credential is an Idemix credential from an election's own idemix CA. Weft Experimental holds it and uses it for one thing: casting ballots with [`weft_castBallot`](/experimental/cast-ballot/) in that election. A ballot signed with it names the voter organisation, an affiliation every voter shares and a role, and not the voter. ([ADR 0008](/reference/decisions/))

Weft never connects a voter credential to a site, `weft_identity` never returns it, and `weft_signIn` isn't offered for it.

## For the organisers: the voters' CA

Each election gets its own issuer key, because Fabric's idemix has no revocation and its credentials don't expire. A leaked credential under a standing issuer key could vote in every later election.

1. Add a CA for the election to the voters' Fabric CA server, with its own CA name, for example `ca-chair-2027`. Its `fabric-ca-server init` writes the idemix `IssuerPublicKey` and `IssuerRevocationPublicKey`.
2. Add an idemix organisation for it to the channel, with a channel configuration update: an MSP of type idemix, for example `ChairVoters2027MSP`, whose MSP folder holds those two keys. Fabric recommends one idemix MSP per channel, because the MSP ID tells idemix organisations apart.
3. Register every voter with the same affiliation, for example `voters`, and `maxenrollments 1`:

   ```sh
   fabric-ca-client register --caname ca-chair-2027 \
     --id.name voter1 --id.secret <secret> --id.type client \
     --id.affiliation voters --id.maxenrollments 1
   ```

   The affiliation is disclosed in every transaction, so a unique one would name the voter.
4. Never issue an X.509 certificate to a voter ID. Fabric CA's idemix endpoint also accepts a token signed with an X.509 enrolment certificate, and that route isn't counted against `maxenrollments`. In the prototype, a voter with an X.509 certificate got three credentials and voted three times.
5. Create the election with `voters.kind` `idemix`, naming the MSP and pinning the issuer public key ([`CreateElection`](/experimental/contract-api/#createelection)).
6. Before opening the election, count the credentials issued per enrolment ID in the CA's `credentials` table. Each voter must have at most one.
7. Publish a voter invite, and give each voter their enrolment ID and secret.

The CA operator decides who is a voter and can register IDs that no person holds. Nothing on the ledger shows that, so the voter roll is a matter for the organisers, as it is for any election.

## The voter invite

A voter invite is a JSON document, served over HTTPS and shared as a link, like an [organisation's invite](/operators/invites/). It has no `weft` field, so normal Weft refuses it ('"weft" must be 1') and a voter can't spend their one enrolment on an X.509 certificate by accident.

```json
{
  "weftVoterInvite": 1,
  "network": "Weft Playground",
  "organization": "Chair 2027 voters",
  "mspId": "ChairVoters2027MSP",
  "caUrl": "https://ca.voters.example.org",
  "caName": "ca-chair-2027",
  "relayUrl": "https://relay.election.example.org",
  "channel": "privatevote",
  "chaincode": "private-ballot",
  "electionId": "chair-2027",
  "issuerKeyHash": "<64 hex characters>",
  "curve": "FP256BN_AMCL",
  "explorerUrl": "https://explorer.org1.example.org"
}
```

`issuerKeyHash` is SHA-256 of the `IssuerPublicKey` bytes the CA serves. `relayUrl` is the election's relay, which may differ from the organisations' own (see [The relay](#the-relay)).

## Enrolment

When the voter opens a voter invite, Weft Experimental shows what they are joining, asks for the enrolment ID and secret, and then:

1. Reads the CA's `/cainfo` for the CA name and compares SHA-256 of its issuer public key with `issuerKeyHash`. If they differ, it stops: "The voters' CA has a different issuer key from the invite's. Ask the election's organisers."
2. Sends an empty request to `/api/v1/idemix/credential` with the enrolment ID and secret, and gets a nonce and the issuer key.
3. Loads the idemix module, draws a secret key and builds the credential request, bound to the nonce.
4. Sends the request to the same endpoint, again with the enrolment ID and secret, and gets the credential and the credential revocation information.
5. Checks the credential against the issuer key and its attributes: the organisational unit, the role and the enrolment ID.
6. Seals the secret key and the credential, and saves the voter credential.

It never asks the CA for an X.509 certificate for that ID, and never uses token authorisation. A second enrolment with the same secret fails at the CA ("Authentication failure"), as `maxenrollments 1` requires.

## What Weft stores

| Field | Stored |
|---|---|
| MSP ID, curve, issuer public key, revocation public key | Readable |
| Organisational unit and role | Readable |
| Enrolment ID | Readable, on this device only. It is sent to the CA during enrolment and never afterwards. |
| Credential revocation information, revocation handle | Readable |
| Channel, contract and election ID, from the invite | Readable |
| Secret key and credential | Sealed with AES-GCM, under a key derived from the vault key with HKDF-SHA-256 (info `weft voter credentials v1`), with the record's ID as additional data |

The secret key is a scalar used inside WebAssembly, so it can't be a non-extractable `CryptoKey` like Weft's other keys. Weft opens it into the module's memory to sign, while Weft is unlocked. Go's garbage collector doesn't guarantee those bytes are wiped afterwards.

A voter credential has no expiry, so the certificate watch doesn't apply. Removing it deletes it, and with `maxenrollments 1` the voter can't enrol again for that election. Weft says so before removing it.

## Signing

Weft signs with IBM's idemix library, the one Fabric's idemix MSP uses, compiled from Go to WebAssembly. About 300 lines of Go around the library build the CA credential request, check the credential, make a fresh identity, make the Nym signature and make the per-election pseudonym. Only Weft Experimental carries the module, 13.0 MB or 3.0 MB gzipped, and it loads only when a voter credential is used. Starting it takes about half a second, and it starts again each time the browser stops Weft's background worker.

- Weft makes a new idemix identity, with a new pseudonym (Nym) and proof, for every transaction, so two transactions from one credential can't be linked through the creator field. That takes 171 to 254 ms.
- It signs the inner message bytes, the same bytes it signs with ECDSA for an X.509 identity: the proposal, the transaction and the commit status request, 5 to 13 ms each. It never signs fabric-gateway's wrapper bytes, which the peer refuses.
- Weft's proposal check compares the transaction's creator byte for byte with the identity Weft made for that request.
- Weft Experimental's extension pages have `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';` as their content security policy. Chrome's Manifest V3 default disables WebAssembly, and Firefox needs the same policy. Normal Weft's manifest doesn't have it.

## The per-election pseudonym

The transaction's Nym changes every time, so on its own it can't stop a second vote. Weft adds a pseudonym that is the same for one credential within one election, and unrelated across elections:

```text
B   = HashToG1("weft-scope-v1" || 0x00 || electionId)
P   = B^sk                         the per-election pseudonym
Nym = HSk^sk · HRand^r             the transaction's pseudonym, from its creator

prove:
  a, b = random elements of Zr
  t1 = HSk^a · HRand^b
  t2 = B^a
  c  = HashToZr("weft-scope-proof-v1" || 0x00 || B || Nym || P || t1 || t2
                || issuerKeyHash || electionId || 0x00 || tracking)
  s1 = a + c·sk
  s2 = b + c·r

verify:
  t1' = HSk^s1 · HRand^s2 · Nym^(-c)
  t2' = B^s1 · P^(-c)
  accept if P isn't the identity and c = HashToZr(... B, Nym, P, t1', t2' ...)
```

`HSk` and `HRand` come from the issuer public key, `HashToG1` and `HashToZr` are IBM mathlib's for the `FP256BN_AMCL` curve, points are written as their X and Y coordinates, and `tracking` is the ballot's 32-byte tracking code. `pseudonymJson` carries P, c, s1 and s2 in base64, 160 bytes in all.

The proof shows the sk behind P is the sk inside the transaction's Nym, which the peer has already checked against the channel's issuer key. It is bound to that Nym and to the ballot, so another voter can't reuse it, and a replay was refused in the prototype. Pseudonyms in different elections can't be linked, under the decisional Diffie-Hellman assumption in G1. The enrolment ID isn't used as the input, because the CA and anyone with the voter list know it.

The voter tag that binds the ballot's proofs is made from P (see the [specification](/experimental/private-tally-spec/#the-voter-tag)), and the contract marks the tag as voted. This proof is Weft's own cryptography, about 150 lines of Go, and needs an external review.

## The relay

The relay accepts an idemix signer, `{ "mspId": "ChairVoters2027MSP", "idemixIdentity": "<base64>" }`, and passes it to fabric-gateway as credentials. It caches no gateway for it, so each vote gets a new one. It still holds no secret, and builds and forwards messages exactly as for an X.509 signer.

It accepts idemix signers only when started with `WEFT_EXPERIMENTAL=1`, and only from the MSP IDs in `WEFT_IDEMIX_MSP_IDS`.

The relay sees the voter's network address and the time of each request. With the private tally it sees only ciphertext, but the address may still identify the voter. The election's relay therefore:

- is run by a party that doesn't count the election and isn't a trustee;
- keeps no request logs, at the relay or at any proxy in front of it;
- is named in Weft's approval window and in the voter invite.

## What the explorer shows

An explorer started with `WEFT_EXPERIMENTAL=1`, with the channel's `privateElections: private-ballot` in its policy:

- reads idemix organisations in the channel configuration and shows each issuer key's hash;
- labels anonymous submitters "Anonymous member of ChairVoters2027MSP" and doesn't show the Nym;
- compares each election's pinned issuer key with the voter organisation's key in the configuration block, and warns on the election page if they differ;
- in the full check, verifies every ballot's pseudonym proof and counts distinct pseudonyms, which must equal the number of ballots. It does this with the same idemix module, loaded only when a visitor asks for the full check of an election with voter credentials.

## What a ballot still shows

A ballot shows the voter organisation's MSP ID, the shared affiliation, the role, a one-off Nym, the per-election pseudonym P, the encrypted ballot and the time. It doesn't show the enrolment ID or the revocation handle. [What isn't hidden](/experimental/what-is-not-hidden/) has the rest.
