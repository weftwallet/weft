---
title: What isn't hidden
description: What neither experimental feature hides, and the options that were considered and not taken.
---

:::caution[Experimental]
This page describes Weft Experimental, a separate build that is not part of the main product, and nothing on it applies to Weft as you install it. No one outside the project has reviewed its cryptography. The private tally and voter credentials are built, and what the page says of them describes the code.
:::

The [private tally](/experimental/private-tally-spec/) hides the choice and [voter credentials](/experimental/voter-credentials/) hide who voted. Neither hides everything. Tell voters what applies to their election.

## What stays visible

### To everyone who can read the channel

- That the election exists, its options, trustees, threshold, planned closing time and key, and the block in which the trustees closed it.
- How many ballots were cast, and when each one was committed.
- The final counts. In a small election, or a one-sided one, the counts can show how individuals voted: if every ballot chose the same option, everyone knows each voter's choice.
- With X.509 voters, who voted and who didn't, since every ballot transaction carries the voter's certificate.
- On an explorer, each ballot's voter tag, even where the explorer hides submitters. It names no one, but anyone with the voter's certificate can compute it for an election and see that the voter voted in it. The tag covers the channel and the election ID, so an X.509 voter's tags differ from one election to the next, and the published tags don't link one certificate's ballots across elections. See [What the explorer publishes](/experimental/cast-ballot/#what-the-explorer-publishes).
- With voter credentials, the voter organisation, the shared affiliation and the role on every ballot, the one-off identity that signed it with its Nym, and the per-election pseudonym, which is the same for any second attempt by the same credential in that election. Explorers publish all of these, even where they hide submitters, since none names anyone and the full check needs them. A pseudonym differs from one election to the next, so it doesn't link a credential's ballots across elections.

### To particular parties

| Party | Still sees |
|---|---|
| The relay | The voter's network address and the time of each request, which may identify the voter, and the encrypted ballot. With X.509 voters, the certificate too. Weft's relay logs nothing for a request with a voter credential, but the network and any proxy in front of it still see the address. |
| The voters' CA operator | Who holds a credential, and when they enrolled. It can't link a credential to a ballot. |
| Any k trustees together | Any single ballot, by combining their shares on it rather than on the totals. Nothing on the ledger would show that they did. With X.509 voters they also see whose ballot it is. |
| Weft, on the voter's device | The choice and the encryption randomness while it builds the ballot, and the voter credential's secret key while the approval window's worker signs. Anything that can read Weft's memory at that moment, such as a compromised browser, can see them too, and a bug or a side channel in JavaScript that leaks the randomness reveals the vote. |
| Someone beside the voter | Whatever is on the screen. |

### Coercion and vote selling

Weft discards the encryption randomness, so the receipt can't prove the vote, and an ordinary voter has nothing to sell or to be made to show. Discarding it doesn't stop:

- a voter running a modified Weft that keeps the randomness, and proves their vote with it;
- a coercer who watches the voter vote, or votes with the voter's device;
- with X.509 voters, a coercer who checks on the ledger that the voter voted, or didn't.

There is no re-voting in version 1, so a voter who was forced can't replace their ballot later.

### Small anonymity sets

A voter credential hides a voter among the other voters of the same organisation. With few voters, or when one person votes at an unusual time, or from a network address the relay recognises, the set can be small enough to single someone out.

## Other limits

### The election key

Weft reads the election through the relay, by endorsing `GetElection` without submitting, and checks the peers' signatures on the answer. For an X.509 voter, Weft Experimental checks that a peer of the voter's own organisation signed it, against the CA chain it keeps from enrolment. An identity imported from files, or enrolled before Weft Experimental kept the chain, has none, and Weft reads without the check. For a voter credential, whose organisation has no peers, it checks every endorsement against the trustee organisations' CA chains that the voter invite pins ([Reading the election](/experimental/voter-credentials/#reading-the-election)), so it trusts the invite for those as it does for the issuer key. Without a check, a dishonest relay could substitute a key it holds and read that one ballot, which the contract would then refuse, and the voter's check is the election fingerprint in the approval window, which explorers show too.

The Pedersen key generation lets a participant bias the distribution of the joint key (Gennaro, Jarecki, Krawczyk and Rabin). FROST and ElectionGuard accept this, and the private tally claims no more than they do.

### Closing

Voting ends when k trustees close the election on the ledger, not at `closesAt`, because a transaction's timestamp is set by the client and peers don't check it. The contract doesn't stop k trustees closing before `closesAt`, which would turn away voters who hadn't voted yet. Explorers show the block the election closed in beside its planned closing time, so an early close is visible to everyone who can read the channel.

### Throughput

Verification limits how many ballots a second an endorsing peer accepts: checking a three-option ballot takes about 0.7 ms of one core in Go, about 1,400 a second before the contract's ledger reads and writes, against about 65 in Node on the same machine. The explorer's full check takes about 27 ms per three-option ballot in each browser worker: 2.2 minutes for 10,000 ballots in the two workers of a two-core machine, about 4.5 minutes in one, and about 1.1 minutes in four. [Prototype results](/experimental/prototype-results/#timings) has the measurements.

## Fabric's limits

These come from Fabric. Weft doesn't fix them for now, and upstream changes are left for later:

- Fabric CA's idemix credentials can't be revoked, because it builds every credential revocation information with `ALG_NO_REVOCATION`. A fix would cross Fabric CA, Fabric's MSP and IBM's idemix, and calls for an upstream issue instead of a fork. Meanwhile each election gets a new issuer key, and a leaked credential votes only in its own election, where it can't be cancelled. Weft Experimental says so on the credential's detail and in the voter invite's review, and explorers in the election's Voters row.
- Fabric CA limits basic-authorisation enrolments with `maxenrollments`, but not the idemix credentials an X.509 certificate holder gets with token authorisation, and its bootstrap admin has no limit by default. The contract refuses credentials outside the election's affiliation and role, and the rest rests on the voters' CA's setup and a count of credentials per enrolment ID ([Which credentials can vote](/experimental/voter-credentials/#which-credentials-can-vote)). A limit on idemix credentials per enrolment ID in Fabric CA would be better, and may be proposed upstream later.
- Fabric CA's idemix curves are 254 or 256-bit Barreto-Naehrig curves (default `FP256BN_AMCL`). Published estimates since the 2016 improvements to the number field sieve put them below the 128-bit security level they were chosen for. ADR 0008 accepts this for ballots that close within days, and a ballot recorded today may be less protected in future.
- Node's `fabric-contract-api` rejects every call from an idemix caller, which is one reason the contract is written in Go. A small change to fabric-chaincode-node's `ClientIdentity`, so that it tolerates idemix creators, could fix this upstream.
- Idemix organisations can't endorse, so every election also relies on X.509 organisations as endorsers.

## Options not taken

| Option | What it would do | Why not |
|---|---|---|
| Doing nothing | Keep ADR 0004's limit and state it to voters. | This is still the main product's position. The experimental track tests whether a private tally and anonymous voters can work in Weft. |
| Verifiable mixnets | Shuffle encrypted ballots, with proofs, so any ballot shape works. | Checking a shuffle is linear in the number of ballots: about 100 seconds for 10,000 ballots in Node chaincode, past Fabric's 30-second default timeout. The maintained mixnet is Java under the AGPL, and no permissively licensed TypeScript prover was found. |
| Blind signatures | An authority blind-signs a token, and the voter submits the token with a plain ballot anonymously. | Fabric has no anonymous submission for X.509 identities. The signer can issue tokens for voters who never vote, and the token and ballot prove the vote. |
| ElectionGuard's 4096-bit group | ElectionGuard's own record format and verifiers. | A ciphertext is 1,024 bytes per option instead of 64, and each operation is about 6 to 25 times slower in JavaScript. Weft follows ElectionGuard's structure instead. |
| A re-randomising server, or fake credentials | Real receipt-freeness, or resistance to coercion. | It adds a party that must be trusted, and doesn't fit a ballot the voter's wallet signs. |
| MACI | Resistance to bribery. | Its coordinator can decrypt every vote, which is the trust the private tally removes. |
| zk-SNARK membership proofs | Hide which member voted. | They need the same anonymous submission as blind signatures, and the common JavaScript prover, snarkjs, is GPL-3.0, which doesn't fit Weft's Apache-2.0 licence. |
| Pseudonymous X.509 certificates per election | Hide voters from the member organisations, with revocation and no WebAssembly. | The issuing CA can record which certificate went to whom. Idemix hides voters from the CA too. |
| Blind-signed tokens under a shared identity | Hide voters behind one submitting identity. | A shared signing key at the relay undoes ADR 0001, and an anonymous Fabric identity is Idemix anyway. |
| Idemix as a general Weft identity | Anonymous identities for any contract. | Most contracts need to know who is calling, sign-in needs a certificate chain, and the costs (12.7 MB of WebAssembly, no revocation) are worth paying only for ballots. |
| A check before casting (the Benaloh challenge) | Let a voter check that Weft encrypted what they chose. | Left for a later version. Weft is open source, and the voter already trusts it with their key. |
| Re-voting | Let a voter replace a coerced ballot. | Not in version 1. A second ballot from an X.509 voter is visible to every member, so it protects little on Fabric. |
| A Node contract | One language with Weft and the explorer. | About 40 ballots a second per core, and the Node contract library rejects idemix callers. |
| Fixing Fabric's limits in Weft | Revocation, stronger curves, Node contract support. | Each belongs upstream, in Fabric CA, Fabric's MSP, IBM's idemix or fabric-chaincode-node. Upstream changes may be proposed later. |

## What the playground hides

The playground hides nothing from whoever runs it, because both trustees, the voters' CA and the relay run on one machine.
