---
title: Private tally specification
description: The private tally's cryptography as a specification, with its encodings, proofs, sizes and test vectors.
---

:::caution[Experimental]
This page describes Weft Experimental, a separate build that is not part of the main product, and nothing on it applies to Weft as you install it. No one outside the project has reviewed its cryptography. None of it is built yet, and the page describes the planned design.
:::

This is the scheme from [ADR 0007](/reference/decisions/), written so that the Go contract and the TypeScript code in Weft, the trustee CLI and the explorer can be built from it and checked against each other. It follows the prototype from the private tally study, except where a section says version 1 differs.

## Scope

Weft, the trustee CLI and the explorer implement it in TypeScript with `@noble/curves` and `@noble/hashes`. The contract implements it in Go. Both run the same [test vectors](#test-vectors).

Randomness is drawn only in Weft (encryption and ballot proofs) and in the trustee CLI (key ceremony and decryption shares). Every step the contract runs is deterministic. It draws no randomness and reads no clock other than the transaction's timestamp, so every endorser computes the same result.

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
| `weft-election-key v1` | The key fingerprint |
| `weft-ballot-v1 share` | Key-share encryption in the ceremony |

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

Ballot proofs are bound to the voter through a tag `v` that the contract computes from the transaction itself:

```text
X.509 voter:       v = SHA-256(frame(["weft-voter x509 v1", mspId, idBytes]))
voter credential:  v = SHA-256(frame(["weft-voter idemix v1", mspId, P]))
```

`mspId` and `idBytes` are the fields of the transaction creator's `SerializedIdentity`. For an X.509 identity, `idBytes` is the PEM certificate as Fabric carries it, and Weft has it because it signs with that certificate. `P` is the 64-byte per-election pseudonym from [Voter credentials](/experimental/voter-credentials/#the-per-election-pseudonym). A ballot copied into another voter's transaction fails its proofs.

## Random scalars

A random scalar is 64 bytes from the platform's secure random generator, read as a little-endian integer and reduced modulo l, drawn again if the result is 0.

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

In this order, stopping at the first failure:

1. The election is open and the transaction's timestamp is before its closing time.
2. The ballot parses, its `v` is 1, its `electionId` is the election's, and it has L ciphertexts and L bit proofs.
3. Every point and scalar decodes canonically, and no `a_j` is the identity.
4. Every bit proof verifies.
5. The sum proof verifies.
6. No `a_j` is already on the ledger for this election.
7. The voter hasn't voted in this election: by `v` for an X.509 voter, by SHA-256 of `P` for a voter credential, after the pseudonym proof verifies.

## Totals

After the closing time, the contract adds up every accepted ballot per option:

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

It posts `C_i0` to `C_i(k-1)`, a proof of knowledge of `a_i0` in the format of noble's FROST DKG round 1 package, and `E_i`. The contract checks the proof of knowledge. The Go code reproduces noble's proof and hash exactly, and the test vectors fix their bytes. Noble's DKG is outside RFC 9591, which leaves key generation out of scope.

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

It posts one `{ to: id_j, nonce, box }` per recipient. The ledger keeps them permanently, which is why each trustee deletes its one-time key after round 3.

### Round 3, checked by each trustee

Trustee j decrypts each `y_ij` and checks it against i's commitments:

```text
y_ij·G = sum over t of (id_j^t)·C_it
```

A share that fails is reported, and the ceremony stops. Otherwise trustee j's secret share is `s_j = y_1j + ... + y_nj` (with its own `f_j(id_j)`), and `s_j·G` equals the `S_j` the contract computed. The trustee posts a proof that it holds `s_j`:

```text
w = a random scalar,  R = w·G
c = Hs("confirm", [ctx, id_j, S_j, R])
z = w + c·s_j
verify: c = Hs("confirm", [ctx, id_j, S_j, z·G - c·S_j])
```

The prototype had each trustee confirm without a proof. Version 1 adds this one, so the election opens only when every trustee has shown it holds a working share.

### The key fingerprint

```text
fingerprint = the first 10 bytes of SHA-256(frame(["weft-election-key v1", ctx]))
```

Shown as 20 hex characters in five groups of four, for example `3f9a 61c2 08de 77b1 c4e0`, in Weft's approval window and on every explorer's election page.

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

A trustee's share is `{ trustee: id_i, shares: [{ d, c, z }] }`, with one entry per option.

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
| Ballot | 192 bytes per option plus 64: 640 for three options, 1,520 as hex JSON |
| Decryption share | 96 bytes per option: 288 for three options, 734 as JSON |
| Round 1 public data, three trustees | 1,081 bytes as JSON, before one-time keys |

## Timings

[Prototype results](/experimental/prototype-results/#timings) has the prototype's timings for encryption, verification, the ceremony, the count and the explorer's full check, and the estimate for Go.

## Test vectors

The proofs exist twice, so the two implementations are tied together by vectors that both test suites run. They are planned to live in one folder in the repository, read by the TypeScript tests and by the contract's Go tests.

- Each vector has fixed inputs, including the randomness that would normally be drawn, and every intermediate and final output: framed bytes, `ctx`, voter tags, ciphertexts, each proof's commitments and challenges, the tracking code, totals, decryption shares, Lagrange coefficients and counts.
- Provers take their randomness as an argument in tests, so the TypeScript side can reproduce a vector and the Go side, which never proves ballots, can check the same bytes.
- The key ceremony vectors fix noble's round 1 proof bytes, the derived key and verifying shares, the share encryption with a fixed nonce, and the confirmation proofs.
- Negative vectors are inputs that must be refused, each with the reason: the prototype's eight refusals (a ballot sent by another voter, a repeated ballot, a slot holding 2, two options chosen, another key, a changed proof value, a share made with another key, a tally from too few trustees), and non-canonical points and scalars, identity points, unknown fields and wrong lengths.
- A change to the scheme changes the vectors first. A version bump in a label is the only way to change an encoding.

## What is library code

From `@noble/curves` 2.4.0 (MIT): the ristretto255 group (RFC 9496), hashing to a scalar (RFC 9380's `expand_message_xmd`), and the DKG in its FROST module. From `@noble/hashes` 2.4.0: SHA-256 and HKDF. The noble-curves README lists audits by Trail of Bits, Kudelski Security and Cure53. AES-GCM comes from WebCrypto in TypeScript and the standard library in Go.

Hand-written, and to be reviewed: the encryption, the 0-or-1, sum, share and confirmation proofs, the share encryption's construction, the Lagrange combination, the count search and the framing. In Go, the ristretto255 library is still to be chosen, and `expand_message_xmd` and the reproduction of noble's DKG proof are hand-written too.
