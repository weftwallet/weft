---
title: Private tally specification
description: The private tally's cryptography as a specification, with its encodings, proofs, sizes and test vectors.
---

:::caution[Experimental]
This page describes Weft Experimental, a separate build that is not part of the main product, and nothing on it applies to Weft as you install it. No one outside the project has reviewed its cryptography. The cryptography on this page is built, in `@weftwallet/tally` and the contract's `internal/tally`, except [the per-election pseudonym](#the-per-election-pseudonym) for voter credentials, which is specified and not built yet. The contract, Weft Experimental, `weft-trustee` and the explorer use it.
:::

This is the scheme from [ADR 0007](/reference/decisions/), written so that the Go contract and the TypeScript code in Weft, the trustee tool and the explorer can be built from it and checked against each other. It follows the prototype from the private tally study, except where a section says version 1 differs.

## Scope

Weft Experimental, the trustee tool (`weft-trustee`) and the explorer share one TypeScript implementation, `@weftwallet/tally` in `packages/tally`, on `@noble/curves` and `@noble/hashes`. It is a private package: it isn't published, and Weft's normal build doesn't depend on it. The contract implements only what it runs, the verifying half, in Go, in `internal/tally` of its own module. Both run the same [test vectors](#test-vectors).

The [per-election pseudonym](#the-per-election-pseudonym), which voter credentials add to a ballot, is specified on this page to the same standard. It works in another group, and its prover and verifier are one Go package, `pseudonym` in the contract's module, which the contract and Weft's idemix WebAssembly module both compile.

Randomness is drawn only in Weft (encryption, ballot proofs and the pseudonym proof) and in the trustee tool (key ceremony and decryption shares). Every step the contract runs is deterministic. It draws no randomness and reads no clock, so every endorser computes the same result. The one time it reads is the transaction's timestamp, which the client sets and every endorser reads the same from the proposal, and only `CreateElection` reads it, to refuse a `closesAt` that has already passed. Nothing in this specification, from casting a ballot to publishing the tally, reads a time.

## Notation

```text
G        the ristretto255 base point
l        the group order, 2^252 + 27742317777372353535851937790883648493
x·P      scalar multiplication
P + Q    the group operation; P - Q adds the inverse of Q
H        the election key
L        the number of options
n, k     the number of trustees, and the threshold
id_i     trustee i's identifier: the scalar i, for i = 1 to n, in the order of the election's trustee list
```

## Group and encoding

The group is ristretto255 (RFC 9496), a prime-order group of order l built on Curve25519.

| Value | Encoding | Decoding rule |
|---|---|---|
| Point | 32 bytes, RFC 9496 encoding | Refuse any input that isn't a canonical encoding. |
| Scalar | 32 bytes, little-endian | Refuse any value of l or more. |
| In JSON | Lowercase hex of the bytes above | Refuse uppercase, odd lengths and other lengths. |

A ciphertext's first component must not be the identity point: a ballot with one has no randomness and is refused.

The per-election pseudonym uses another group, G1 of the FP256BN curve, with its own encodings: see [Group and encoding for the pseudonym](#group-and-encoding-for-the-pseudonym).

Implementations use constant-time multiplication for secret scalars (encryption randomness, proof nonces, trustee shares, one-time keys) and may use variable-time multiplication for public values only, as when verifying.

## Framing

Every hash input is a list of parts, framed so that no two different lists give the same bytes:

```text
frame([p_1, ..., p_m]) = len(p_1) || p_1 || ... || len(p_m) || p_m
```

`len` is the part's length in bytes as a 4-byte big-endian integer. A string part is its UTF-8 bytes. An integer part (an option count, a slot index, a threshold) is first written as a 4-byte big-endian integer, so it is framed as `00 00 00 04` and its 4 bytes. Points and scalars are their 32-byte encodings.

## Hashing and domain separation

Challenges are scalars:

```text
Hs(label, parts) = OS2IP_LE(expand_message_xmd(frame([label, ...parts]), DST, 64)) mod l
DST              = "weft-ballot-v1-challenge"
```

`expand_message_xmd` is RFC 9380's, with SHA-512, giving 64 bytes that are read as a little-endian integer and reduced modulo l. This is what noble's `ristretto255_hasher.hashToScalar` computes with that DST.

Other digests are SHA-256 of a framed list. Every hash starts with a label of its own:

| Label | Used for |
|---|---|
| `weft-ballot v1` | The election context, `ctx` |
| `weft-voter x509 v1` | The voter tag of an X.509 voter |
| `weft-voter idemix v1` | The voter tag of a voter credential |
| `bit` | A slot's 0-or-1 proof (under the DST above) |
| `sum` | A ballot's sum proof (under the DST) |
| `share` | A decryption share's proof (under the DST) |
| `confirm` | A trustee's proof that it holds its share (under the DST) |
| `weft-ballot-hash v1` | The tracking code |
| `weft-election-fingerprint v1` | The election fingerprint |
| `weft-ballot-v1 share` | Key-share encryption in the ceremony |
| `weft-scope v1` | The per-election base point B of a voter credential's pseudonym, under HashToG1 |
| `weft-scope-proof v1` | The pseudonym proof's challenge, under Hz |
| `FROST-RISTRETTO255-SHA512-v1dkg` | Noble's round 1 proof of knowledge, as a prefix to plain SHA-512 |

The key ceremony's round 1 proofs use the hash of noble's FROST module, as described under [Key ceremony](#key-ceremony).

## The election context

Every proof is bound to the election through `ctx`:

```text
ctx = SHA-256(frame(["weft-ballot v1", channel, chaincode, electionId,
                     H, L, option_1, ..., option_L,
                     k, n, id_1, S_1, ..., id_n, S_n]))
```

`S_i` is trustee i's verifying share. The prototype bound only the election ID, the key and the options. Version 1 adds the channel, the contract name, the threshold and the trustees' verifying shares, in the way ElectionGuard's extended base hash binds its guardians, so a proof can't be moved to another channel, contract or key setup.

## The voter tag

Ballot proofs are bound to the voter through a tag `v` that the contract computes from the transaction itself, for one election on one channel:

```text
X.509 voter:       v = SHA-256(frame(["weft-voter x509 v1", channel, electionId, mspId, idBytes]))
voter credential:  v = SHA-256(frame(["weft-voter idemix v1", channel, electionId, mspId, P]))
```

The parts, in this order:

| Part | Bytes |
|---|---|
| The label | The UTF-8 bytes of `weft-voter x509 v1` or `weft-voter idemix v1`. No other hash in the scheme starts with either label. |
| `channel` | The UTF-8 bytes of the channel name, as the contract's `GetChannelID` returns it. |
| `electionId` | The UTF-8 bytes of the election ID. |
| `mspId` | The UTF-8 bytes of the `mspid` field of the transaction creator's `SerializedIdentity`. |
| `idBytes` | The `id_bytes` field of the creator's `SerializedIdentity`, unchanged. For an X.509 identity it is the PEM certificate as Fabric carries it, and Weft has it because it signs with that certificate. |
| `P` | The 64-byte encoding of the [per-election pseudonym](#the-per-election-pseudonym), its x then its y. |

Each part is framed as in [Framing](#framing), and `v` is the 32-byte SHA-256 digest. A ballot copied into another voter's transaction fails its proofs. Because the channel and the election ID are in the tag, one X.509 certificate has a different tag in every election, and the tags an explorer publishes can't be matched across elections. Within one election, anyone who holds the certificate can still compute its tag.

## Random scalars

A random scalar is 64 bytes from the platform's secure random generator, read as a little-endian integer and reduced modulo l, drawn again if the result is 0. In TypeScript the generator is `crypto.getRandomValues`, and only the test path, `@weftwallet/tally/testing`, passes any other source.

The key ceremony's polynomial and its proof of knowledge are drawn by noble's FROST DKG, which maps 48 random bytes to a scalar from 1 to l - 1 as (the little-endian integer mod (l - 1)) + 1.

## Ciphertexts and encryption

A ballot for L options, choosing option `c` (0-based), is L ciphertexts of the form `(r·G, r·H + m·G)`:

```text
for j = 0 to L - 1:
  m_j = 1 if j = c, else 0
  r_j = a random scalar
  a_j = r_j·G
  b_j = r_j·H + m_j·G
```

Ciphertexts add componentwise: `(a, b) + (a', b')` encrypts `m + m'`. Weft discards every `r_j` once the ballot and its proofs are built.

## Validity proofs

### Each slot holds 0 or 1

A disjunctive Chaum-Pedersen proof (Cramer, Damgård and Schoenmakers) for slot j shows `(a_j, b_j)` encrypts 0 or 1. Write `Y_0 = b_j` and `Y_1 = b_j - G`, so `Y_m = r_j·H` for the real `m = m_j`.

```text
prove (s = 1 - m is the simulated branch):
  c_s, z_s = random scalars
  A_s = z_s·G - c_s·a_j
  B_s = z_s·H - c_s·Y_s
  w   = a random scalar
  A_m = w·G
  B_m = w·H
  c   = Hs("bit", [ctx, v, j, a_j, b_j, A_0, B_0, A_1, B_1])
  c_m = c - c_s
  z_m = w + c_m·r_j
  proof = (c_0, c_1, z_0, z_1)

verify:
  A_t = z_t·G - c_t·a_j          for t = 0, 1
  B_t = z_t·H - c_t·Y_t          for t = 0, 1
  accept if c_0 + c_1 = Hs("bit", [ctx, v, j, a_j, b_j, A_0, B_0, A_1, B_1])
```

### The ballot chooses exactly one option

A Chaum-Pedersen proof that the sum of the ballot's ciphertexts encrypts 1:

```text
A = a_0 + ... + a_(L-1)
B = b_0 + ... + b_(L-1)
R = r_0 + ... + r_(L-1)          so B - G = R·H

prove:
  w = a random scalar
  c = Hs("sum", [ctx, v, A, B, w·G, w·H])
  z = w + c·R
  proof = (c, z)

verify:
  T_1 = z·G - c·A
  T_2 = z·H - c·(B - G)
  accept if c = Hs("sum", [ctx, v, A, B, T_1, T_2])
```

Every challenge covers the statement (the context, the voter, the ciphertext) and the proof's commitments, which is the strong Fiat-Shamir form. A challenge that left out the statement allowed forged proofs in Helios (Bernhard, Pereira and Warinschi).

## The ballot

```json
{
  "v": 1,
  "electionId": "budget-2027",
  "ciphertexts": [{ "a": "<point>", "b": "<point>" }],
  "bitProofs": [{ "c0": "<scalar>", "c1": "<scalar>", "z0": "<scalar>", "z1": "<scalar>" }],
  "sumProof": { "c": "<scalar>", "z": "<scalar>" }
}
```

`ciphertexts` and `bitProofs` have exactly L entries each, in option order. A parser reads these fields and no others, and refuses unknown fields, missing fields and wrong lengths.

### Parsing the contract's arguments

Every JSON argument, the election, the ballot and each ceremony and decryption post, is parsed the same way, and the order of the checks is part of the specification, because the first failure decides the [error message](/experimental/contract-api/#errors):

1. The text must be JSON, and its value an object.
2. At each object, an unknown field is refused first. If there are several, the message names the first in the byte order of their UTF-8 names.
3. Then each field, in the order the format lists it, must be present and of its type: a string, a number, a list or an object. An object or a list is checked completely, item by item, before the next field.
4. A duplicated name keeps its last value, as both JSON parsers do. A number is compared as the double that JavaScript's `JSON.parse` gives, so `1`, `1.0` and `1e0` are all 1.
5. Then the values decode, in the order they appear in the format: for a ballot, `a` then `b` of each ciphertext in order, with the identity check on each `a_j` as it decodes, then each bit proof's `c0`, `c1`, `z0` and `z1`, then `c` and `z` of the sum proof.
6. `CreateElection`'s `voters` is the last field of the election, and its fields depend on its kind. Once the rest of the election has been checked, `voters.kind` must be present and a string, and then the rest of `voters` is checked as in steps 2 and 3 against the fields of that kind.

A message names a field by its path, such as `ciphertexts[1].a` or `sumProof.z`.

### The tracking code

```text
tracking = SHA-256(frame(["weft-ballot-hash v1", ctx, v,
                          a_0, b_0, c0_0, c1_0, z0_0, z1_0,
                          ...,
                          a_(L-1), b_(L-1), c0_(L-1), c1_(L-1), z0_(L-1), z1_(L-1),
                          c, z]))
```

As 64 lowercase hex characters, it is the voter's receipt and the key the explorer finds a ballot by.

### What the contract checks

`CastBallot` checks, in this order, stopping at the first failure:

1. The election is `open`. No time is compared with `closesAt`: the election stops accepting ballots when the transaction that [closes it](/experimental/contract-api/#closeelection) commits.
2. The election has X.509 voters, and the creator is an X.509 identity of one of its voter organisations.
3. The ballot parses, its `v` is 1, its `electionId` is the election's, and it has L ciphertexts and L bit proofs.
4. Every point and scalar decodes canonically, and no `a_j` is the identity.
5. Every bit proof verifies, with `v` from the creator's certificate.
6. The sum proof verifies.
7. No two ciphertexts of the ballot have the same `a_j`, which two identical ciphertexts also do, and no `a_j` is already on the ledger for this election. The points are canonical, so the contract compares their hex. A repeat within the ballot is refused with the first pair, i before j.
8. The voter hasn't voted in this election, by `v`.

`CastAnonymousBallot` checks, in this order, stopping at the first failure:

1. The election is `open`, as for `CastBallot`.
2. The election has voter credentials.
3. The creator's MSP ID is the election's voter MSP.
4. The creator is an idemix identity: its `id_bytes` decode as a `SerializedIdemixIdentity` whose `nym_x` and `nym_y` are a point of G1.
5. The creator's organisational unit is the election's affiliation, and its role is member.
6. The ballot parses and decodes, as steps 3 and 4 of `CastBallot` check it.
7. The pseudonym proof parses, and its pseudonym and scalars decode.
8. The contract makes `v` from P, and the tracking code from the ballot, `ctx` and `v`. Neither can fail.
9. The pseudonym proof verifies against the creator's Nym, the pinned issuer key and the tracking code.
10. Every bit proof verifies, with `v` from P.
11. The sum proof verifies.
12. The ciphertexts don't repeat, as step 7 of `CastBallot` checks them.
13. The credential hasn't voted in this election, by `v`.

The pseudonym proof is checked before the ballot proofs because its challenge covers the tracking code, which needs only the ballot's bytes and `v`, and because a ballot copied with its pseudonym from another voter's transaction fails there, with the pseudonym proof's message, whatever else is wrong with it. Steps 2 to 5 come before any argument is parsed, so a caller of the wrong kind is told so whatever it sent.

## The per-election pseudonym

A voter credential's transaction carries a Nym that is new for every transaction, so on its own it can't stop a second vote ([ADR 0008](/reference/decisions/)). Weft adds a pseudonym P that is the same for one credential within one election on one channel and unrelated across elections, with a proof that P comes from the secret key inside the transaction's Nym. The contract makes the [voter tag](#the-voter-tag) from P and marks it as voted.

This section is the specification for version 1. The study's prototype differs from it in ways listed in [Where the prototype differs](#where-the-prototype-differs), and its proofs don't verify under version 1.

### Notation for the pseudonym

```text
p            the modulus of FP256BN's base field
r            the order of G1
G1           the points (x, y) with y^2 = x^3 + 3 over GF(p), and the identity; G1 has prime order r
x·Q          scalar multiplication in G1
Q + R        the group operation; Q - R adds the inverse of R
HSk, HRand   the issuer public key's points of those names
sk           the credential's secret key, a scalar from 1 to r - 1
rNym         the randomness of the transaction's Nym, a scalar
Nym          sk·HSk + rNym·HRand, the Nym in the transaction's creator
```

```text
p = 0xfffffffffffcf0cd46e5f25eee71a49f0cdc65fb12980a82d3292ddbaed33013
r = 0xfffffffffffcf0cd46e5f25eee71a49e0cdc65fb1299921af62d536cd10b500d
```

FP256BN is Fabric CA's default idemix curve, `FP256BN_AMCL`. Its G1 has cofactor 1, so every point on the curve other than the identity has order r, and decoding needs no subgroup check.

### Group and encoding for the pseudonym

| Value | Encoding | Decoding rule |
|---|---|---|
| Point of G1 | 64 bytes: x then y, each as 32 bytes big-endian. This is how Fabric's `SerializedIdemixIdentity` carries the Nym, as `nym_x` and `nym_y`. | Refuse any input that isn't 64 bytes, whose x or y is p or more, or that isn't on the curve. The identity has no encoding, so it is always refused. |
| Scalar | 32 bytes, big-endian, as IBM mathlib writes a scalar. | Refuse any value of r or more. |
| In JSON | Lowercase hex of the bytes above. | Refuse uppercase, odd lengths and other lengths. |

These are big-endian, unlike the ristretto255 scalars of the rest of the scheme, which are little-endian.

### Hashing for the pseudonym

```text
Hz(label, parts) = OS2IP(SHA-256(frame([label, ...parts]))) mod r
H1(label, parts) = HashToG1(frame([label, ...parts]))
```

`frame` is the one in [Framing](#framing), and the labels are in the [label table](#hashing-and-domain-separation). `OS2IP` reads the 32-byte digest as a big-endian integer. Hz is IBM mathlib's `HashToZr` for `FP256BN_AMCL` applied to the framed bytes. A digest of r or more wraps, which happens with probability about 2^-46.

HashToG1 is IBM mathlib's `HashToG1` for `FP256BN_AMCL`, which is AMCL's `Bls_hash`. No standard defines it, so here it is in full:

```text
HashToG1(m):
  x = OS2IP(SHAKE256(m, 32 bytes)) mod p
  loop:
    t = x^3 + 3 mod p
    if t is a non-zero square mod p:
      y = the square root of t whose integer value is even
      return (x, y)
    x = x + 1 mod p
```

p is 3 mod 4, so a square root of t is t^((p+1)/4) mod p, and the even one is it or p minus it. The loop runs about twice on average. It isn't constant time, which doesn't matter here: its input is public.

### The base point and the pseudonym

```text
B = H1("weft-scope v1", [channel, electionId])
P = sk·B
```

`channel` and `electionId` are their UTF-8 bytes, as in the [voter tag](#the-voter-tag). B depends on the channel and the election and on nothing about the voter, so every voter of an election has the same B, and one credential has one P in it.

### The proof

The prover is Weft, which holds sk and, for the identity it made for this transaction, rNym. It makes the proof after the ballot, because the challenge covers the ballot's tracking code:

```text
prove:
  a, b = scalars drawn uniformly from 0 to r - 1
  T1 = a·HSk + b·HRand
  T2 = a·B
  if T1 or T2 is the identity, draw a and b again
  c   = Hz("weft-scope-proof v1", [issuerKeyHash, channel, electionId, tracking,
                                   B, Nym, P, T1, T2])
  ssk = a + c·sk    mod r
  sr  = b + c·rNym  mod r
  proof = (P, c, ssk, sr)
```

The parts of the challenge, in this order:

| Part | Bytes |
|---|---|
| The label | The UTF-8 bytes of `weft-scope-proof v1`. |
| `issuerKeyHash` | The 32 bytes of SHA-256 of the issuer public key's bytes, as Fabric CA writes the `IssuerPublicKey` file and serves it from `/cainfo`. It is the record's `voters.issuerKeyHash` as bytes, and not the key's own `hash` field, which IBM idemix computes differently. |
| `channel`, `electionId` | Their UTF-8 bytes. |
| `tracking` | The ballot's 32-byte [tracking code](#the-tracking-code). |
| `B`, `Nym`, `P`, `T1`, `T2` | Each as its 64-byte encoding. `Nym` is the creator's `nym_x` followed by `nym_y`, exactly as the transaction carries them. |

```text
verify (P, c, ssk, sr), given Nym from the creator, HSk and HRand from the
pinned issuer key, and the tracking code the contract computed:
  T1' = ssk·HSk + sr·HRand - c·Nym
  T2' = ssk·B - c·P
  refuse if T1' or T2' is the identity
  accept if c = Hz("weft-scope-proof v1", [issuerKeyHash, channel, electionId, tracking,
                                          B, Nym, P, T1', T2'])
```

Before that, the verifier has decoded P and Nym as points of G1, which refuses the identity, and c, ssk and sr as scalars below r. A proof that fails any of these is refused. In the contract, decoding failures have the [parsing messages](/experimental/contract-api/#errors) and every other failure has "The pseudonym proof is not valid."

`a` and `b` are secret, like the encryption randomness, and Weft discards them, and the identity's rNym, once the transaction's commit status is in.

### The proof as an argument

`pseudonymJson`, the third argument of `CastAnonymousBallot`, is:

```json
{ "pseudonym": "<128 hex>", "c": "<64 hex>", "ssk": "<64 hex>", "sr": "<64 hex>" }
```

`pseudonym` is P's 64-byte encoding, and `c`, `ssk` and `sr` are scalars, all in lowercase hex. It is parsed as every other argument is ([Parsing the contract's arguments](#parsing-the-contracts-arguments)), with "The pseudonym proof" in the messages, and its values decode in the order `pseudonym`, `c`, `ssk`, `sr`. It is 160 bytes, and 360 characters as JSON. The contract stores it with the ballot, and explorers publish it.

### Security argument

This is the argument the external review checks, alongside the private tally's. The proof is a Schnorr proof of knowledge of sk and rNym such that Nym = sk·HSk + rNym·HRand and P = sk·B, made non-interactive with the Fiat-Shamir transform, with every public value of the statement in the challenge.

- The proof is complete. For an honest prover, T1' = (a + c·sk)·HSk + (b + c·rNym)·HRand - c·(sk·HSk + rNym·HRand) = a·HSk + b·HRand = T1, and T2' = (a + c·sk)·B - c·sk·B = a·B = T2, so the verifier computes the same c.
- It is special sound. Two accepting answers (c, ssk, sr) and (c', ssk', sr') to the same T1 and T2, with c ≠ c', give sk = (ssk - ssk')/(c - c') and rNym = (sr - sr')/(c - c') mod r, which satisfy both equations. With Hz modelled as a random oracle, the forking lemma turns any prover that convinces the verifier into one that knows sk and rNym.
- It is honest-verifier zero knowledge. Picking c, ssk and sr uniformly and setting T1 = ssk·HSk + sr·HRand - c·Nym and T2 = ssk·B - c·P, with the oracle answering c, gives transcripts with exactly the distribution of real ones, because a and b are uniform. The proof shows nothing about sk or rNym beyond the two equations.
- It binds P to the credential behind the Nym. The peer's idemix MSP has checked the creator's proof that its Nym is sk·HSk + rNym·HRand for the sk of a credential from the channel's issuer key. A prover that could also prove Nym = sk*·HSk + r*·HRand with sk* ≠ sk would know log_HRand(HSk) = (r* - rNym)/(sk - sk*) mod r. Without that logarithm, a credential holder can make a valid proof only for P = sk·B with the sk inside its credential. The issuer chose HSk and HRand, and IBM idemix makes each as a random multiple of G1's generator, so an issuer that kept those scalars could give one credential several pseudonyms. That issuer can already issue several credentials, and one vote per person already depends on the voters' CA ([Voter credentials](/experimental/voter-credentials/#which-credentials-can-vote)).
- A credential has one pseudonym in an election. P is a function of sk and B, and B of the channel and the election ID, so a credential has one P, and one voter tag, in an election.
- Pseudonyms can't be linked across elections. For two elections, B_1 and B_2 are independent outputs of HashToG1, and nobody knows their logarithms to each other or to the issuer key's points. Telling whether P_1 = sk·B_1 and P_2 = sk·B_2 have the same sk is the decisional Diffie-Hellman problem in G1. FP256BN's pairing is asymmetric (type 3), so DDH in G1 isn't broken by the pairing, and is believed hard there (the XDH assumption). The same holds for the voters' CA, which saw sk·HSk in the credential request: linking it to a P is DDH in G1 too.
- A proof belongs to one transaction and one ballot. The challenge covers the issuer key's hash, the channel, the election ID, the tracking code, B, the Nym and P. A proof copied into another transaction is checked against another Nym, and a proof moved to another ballot against another tracking code, and either fails. The Nym signature covers the whole proposal, the arguments included, so no one without sk and rNym can change the ballot or the proof under a valid Nym. The statement in the challenge is the strong Fiat-Shamir form, whose absence allowed forged proofs in Helios (Bernhard, Pereira and Warinschi).
- Hz is biased by about 2^-46, which changes no step above by more than that. HashToG1 is try-and-increment rather than an RFC 9380 map, and its outputs aren't uniform over G1, since an x that follows a run of non-squares is likelier. The argument needs only that nobody knows the logarithm of B to the issuer key's points or to another election's B, which the review checks for this map.
- FP256BN is below the 128-bit level it was chosen for (see [What isn't hidden](/experimental/what-is-not-hidden/#fabrics-limits)), which ADR 0008 accepts for ballots that close within days.

### Where the prototype differs

The study's prototype (`lib.go`, `ScopePseudonym` and `VerifyScopePseudonym`) is the starting point for the Go package, which version 1 changes:

- B was HashToG1 of `weft-scope-v1`, a zero byte and the election ID, with no framing and without the channel.
- The challenge was HashToZr of `weft-scope-proof-v1`, a zero byte, the x and y of B, Nym, P, T1 and T2, the issuer key's own `hash` field, the election ID, a zero byte and the context, with no framing. Version 1 frames every part, puts the statement before the commitments, uses issuerKeyHash, which the election pins and explorers compare with the channel's configuration, and adds the channel.
- Its context was the prototype contract's ballot commitment. Version 1's is the tracking code.
- Its fields were base64. Version 1's are lowercase hex, like every other point and scalar in the contract's arguments.
- It didn't refuse scalars of r or more, and didn't check T1' and T2' for the identity.
- Its labels, `weft-scope-v1` and `weft-scope-proof-v1`, weren't in the style of the scheme's other labels.

## Totals

When k trustees close the election, the contract adds up every accepted ballot per option:

```text
(A_j, B_j) = sum over accepted ballots of (a_j, b_j),   for j = 0 to L - 1
N          = the number of accepted ballots
```

## Key ceremony

A Pedersen distributed key generation with proofs of knowledge, in the three-round structure of noble's FROST module (`ristretto255_FROST.DKG`), which follows frost-rs. The [key ceremony page](/experimental/key-ceremony/) has the trustee's steps.

### Round 1, public

Trustee i draws a polynomial of degree k - 1 and a one-time ceremony key:

```text
f_i(x) = a_i0 + a_i1·x + ... + a_i(k-1)·x^(k-1)      random coefficients
C_it   = a_it·G                                     for t = 0 to k - 1
e_i    = a random scalar,  E_i = e_i·G              the one-time ceremony key
```

It posts `C_i0` to `C_i(k-1)`, a proof of knowledge of `a_i0` in the format of noble's FROST DKG round 1 package, and `E_i`. The proof is noble's 64 bytes, `R` then `z`, as 128 lowercase hex characters:

```text
prove (noble's DKG.round1):
  k = a random scalar,  R = k·G
  c = OS2IP_LE(SHA-512("FROST-RISTRETTO255-SHA512-v1dkg" || id_i || C_i0 || R)) mod l
  z = k + a_i0·c

verify:
  accept if R isn't the identity and R = z·G - c·C_i0
```

The hash is plain SHA-512 of the prefix and the three 32-byte encodings, not `expand_message_xmd`, as noble 2.4.0 computes it for `ristretto255_FROST`. The contract checks this proof, that there are k commitments and none is the identity, and that `E_i` isn't the identity, which are the checks noble's round 2 makes, so a round 1 the contract accepts is one every honest trustee's round 2 accepts too. Noble's DKG is outside RFC 9591, which leaves key generation out of scope.

Once every trustee has posted round 1, the key and every verifying share follow from the commitments alone:

```text
H   = C_10 + C_20 + ... + C_n0
S_j = sum over i of sum over t of (id_j^t)·C_it       trustee j's verifying share
```

### Round 2, encrypted shares through the ledger

Trustee i sends `y_ij = f_i(id_j)` to every other trustee j, encrypted to j's one-time key:

```text
K    = e_i·E_j                                        (equal to e_j·E_i)
info = frame(["weft-ballot-v1 share", channel, electionId, id_i, id_j])
key  = HKDF-SHA-256(ikm = encoding of K, salt = empty, info = info, length = 32)
box  = AES-256-GCM(key, nonce = 12 random bytes, aad = info, plaintext = y_ij as 32 bytes)
```

It posts one `{ to: id_j, nonce, box }` per recipient, with `id_j` as a 32-byte scalar, `nonce` as 12 bytes and `box`, the 32-byte ciphertext and the 16-byte tag, as 48 bytes, all in lowercase hex. The ledger keeps them permanently, which is why each trustee deletes its one-time key after round 3.

### Round 3, checked by each trustee

Trustee j decrypts each `y_ij` and checks it against i's commitments:

```text
y_ij·G = sum over t of (id_j^t)·C_it
```

A share that fails, or a box that doesn't open, is reported with the sender's identifier, and the ceremony stops. Otherwise noble's round 3 sums trustee j's secret share, `s_j = y_1j + ... + y_nj` (with its own `f_j(id_j)`), and `s_j·G` equals the `S_j` the contract computed. The trustee posts a proof that it holds `s_j`:

```text
w = a random scalar,  R = w·G
c = Hs("confirm", [ctx, id_j, S_j, R])
z = w + c·s_j
verify: c = Hs("confirm", [ctx, id_j, S_j, z·G - c·S_j])
```

The prototype had each trustee confirm without a proof. Version 1 adds this one, so the election opens only when every trustee has shown it holds a working share.

### The election fingerprint

```text
fingerprint = the first 10 bytes of SHA-256(frame(["weft-election-fingerprint v1", ctx,
                                                   msp_(1), ..., msp_(n)]))
```

`msp_(1)` to `msp_(n)` are the trustees' MSP IDs, each as its UTF-8 bytes, sorted in ascending byte order and framed one part each. Sorting makes the fingerprint depend on which organisations are trustees and not on the order of the trustee list. The order still sets each trustee's identifier, which `ctx` covers.

The fingerprint covers the whole election context and the trustee organisations: the channel, the contract, the election ID, the key, the options, the threshold, each trustee's identifier and verifying share, and the trustees' MSP IDs, which Weft's window names as the key holders. A changed option list, trustee setup or trustee organisation changes it, as a changed key does.

The title and `closesAt` aren't covered. A record with a different title or planned closing time has the same fingerprint, so the fingerprint can't be used to check either of them.

The election record and the `ElectionOpened` event store it as 20 lowercase hex characters without spaces, for example `3f9a61c208de77b1c4e0`. Weft's approval window and every explorer's election page show it in five groups of four, `3f9a 61c2 08de 77b1 c4e0`, in the monospaced font, labelled "Election fingerprint".

## Decryption shares

For each total, trustee i posts `D_ij = s_i·A_j` with a proof that it used the same secret as its verifying share:

```text
prove:
  w = a random scalar
  c = Hs("share", [ctx, id_i, j, A_j, D_ij, S_i, w·G, w·A_j])
  z = w + c·s_i

verify:
  T_1 = z·G - c·S_i
  T_2 = z·A_j - c·D_ij
  accept if c = Hs("share", [ctx, id_i, j, A_j, D_ij, S_i, T_1, T_2])
```

A trustee posts `{ "shares": [{ "d", "c", "z" }] }`, with one entry per option. The contract works out the trustee from the caller's MSP ID, so a `trustee` field is refused as unknown, and stores the share with the trustee's identifier.

## Recovering the tally

Once at least k trustees have posted verified shares, take the k with the lowest identifiers, as the set Q:

```text
lambda_i = product over m in Q, m != i, of id_m / (id_m - id_i)      mod l
M_j      = B_j - sum over i in Q of lambda_i·D_ij                     = t_j·G
```

Find each count `t_j` in 0 to N by stepping from 0. Refuse the tally if any `t_j` isn't found in that range, or if the counts don't add up to N. Stepping is enough for the prototype's sizes. Baby-step giant-step would take about the square root of N in steps.

## Sizes

| Item | Size |
|---|---|
| Ciphertext | 64 bytes |
| 0-or-1 proof | 128 bytes |
| Sum proof | 64 bytes |
| Ballot | 192 bytes per option plus 64: 640 for three options, 1,521 as hex JSON for `budget-2027`, and 4,560 for ten options |
| Decryption share | 96 bytes per option: 288 for three options, 657 as JSON |
| Round 1 post, a threshold of 2 | 371 bytes as JSON, with the one-time key |
| Round 2 post, three trustees | 440 bytes as JSON |
| Confirmation | 143 bytes as JSON |
| Pseudonym proof, with a voter credential | 160 bytes, 360 as JSON |

## Timings

[Prototype results](/experimental/prototype-results/#timings) has the prototype's timings for encryption, verification, the ceremony, the count and the explorer's full check, and version 1's timings in Go and Node.

## Test vectors

The proofs exist twice, so the two implementations are tied together by vectors that both test suites run.

- They live in `packages/tally/vectors/v1/`, one JSON file per group: `framing.json` (framing, `expand_message_xmd` and Hs), `context.json` (contexts, fingerprints and voter tags), `ballots.json`, `tracking.json`, `ceremony.json`, `shares.json` (totals and decryption shares), `tally.json` and `negative.json`. Every byte string is lowercase hex.
- `packages/tally/scripts/vectors.ts` writes them from fixed seeds, and they are committed. Running it again changes no file, and a TypeScript test regenerates them in memory and compares every byte.
- Each step draws from its own seed, so adding a vector doesn't change the others. A seed's stream is `SHA-512(frame(["weft-tally test rng v1", seed, i]))` for i = 0, 1 and so on, and each draw takes the next bytes.
- The TypeScript tests in `packages/tally` and the contract's Go tests read the same files, the Go tests by relative path.
- Each vector has fixed inputs, including the randomness that would normally be drawn, and every intermediate and final output: framed bytes, `ctx`, voter tags, ciphertexts, each proof's commitments and challenges, the tracking code, totals, decryption shares, Lagrange coefficients and counts.
- Provers take their randomness as an argument through `@weftwallet/tally/testing`, so the TypeScript side can reproduce a vector and the Go side, which never proves ballots, can check the same bytes.
- The key ceremony vectors fix noble's round 1 proof bytes, the derived key and verifying shares, the share encryption with a fixed nonce, and the confirmation proofs.
- Negative vectors are inputs that must be refused, each with the contract's exact error message from the [error table](/experimental/contract-api/#errors): the prototype's eight refusals (a ballot sent by another voter, a repeated ballot, a slot holding 2, two options chosen, another key, a changed proof value, a share made with another key, a tally from too few trustees), ballots whose own ciphertexts repeat, with proofs that verify, and non-canonical points and scalars, identity points, unknown fields, missing fields, wrong types and wrong lengths, for ballots, every ceremony post, decryption shares and the tally.
- The per-election pseudonym has vectors of its own, in `packages/idemix/vectors/v1/pseudonym.json`, from fixed sk, rNym, a and b, with B, P, every framed challenge input, T1, T2, c, ssk, sr and the voter tag. The pseudonym package's Go tests and the WebAssembly module's tests read them. Its negative vectors carry the contract's messages: a proof for another Nym, another election, another channel, another tracking code or another issuer key, P as an off-curve point, a scalar of r or more, and a proof replayed in another transaction.
- A change to the scheme changes the vectors first. A new label version is the only way to change an encoding, and its vectors go in a new folder, `v2/`.

## What is library code

From `@noble/curves` 2.4.0 (MIT): the ristretto255 group (RFC 9496), hashing to a scalar (RFC 9380's `expand_message_xmd`), and the DKG's three rounds in its FROST module. From `@noble/hashes` 2.4.0: SHA-256, SHA-512 and HKDF. The noble-curves README lists audits by Trail of Bits, Kudelski Security and Cure53. AES-GCM comes from WebCrypto.

In Go, the group comes from `github.com/gtank/ristretto255` v0.2.0 on `filippo.io/edwards25519` v1.2.0 (both BSD 3-Clause), and SHA-256 and SHA-512 from the standard library. `filippo.io/edwards25519` is the standard library's edwards25519 code, which was in the scope of Trail of Bits' 2025 audit of Go's cryptography. No published audit of `gtank/ristretto255` itself was found. The [contract's README](https://github.com/ifeanyi-ugwu/weft/tree/main/examples/private-ballot-contract) gives the reasons for the choice.

For the per-election pseudonym, in Go only: FP256BN's group, HashToG1 and HashToZr from IBM mathlib v0.3.2 on AMCL (`hyperledger/fabric-amcl`), and the issuer key's decoding from IBM idemix v0.3.1, both Apache 2.0. Fabric's idemix MSP runs the same code. No published audit of either was found.

Hand-written, and to be reviewed: the encryption, the 0-or-1, sum, share and confirmation proofs, the share encryption's construction, the check that names the sender of a bad share, the Lagrange combination, the count search, the framing and the strict JSON parsing. In Go, `expand_message_xmd`, the check of noble's DKG proof and every verifier are hand-written too, and `gtank/ristretto255`'s encoding layer joins the review. So do the pseudonym proof, its prover and verifier, its encodings and the [security argument](#security-argument) above.
