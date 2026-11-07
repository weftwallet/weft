---
title: Experimental features
description: Weft Experimental, a separate build with a private tally and anonymous voter credentials, and what each hides from whom.
---

:::caution[Experimental]
This page describes Weft Experimental, a separate build that is not part of the main product, and nothing on it applies to Weft as you install it. No one outside the project has reviewed its cryptography. None of it is built yet, and the page describes the planned design.
:::

## The experimental track

Weft Experimental is Weft built with `WEFT_EXPERIMENTAL=1`. It is a separate extension with its own name, extension ID and storage. It installs alongside Weft and shares no identities, keys or receipts with it, and only it carries the features on these pages. ([ADR 0009](/reference/decisions/))

The code lives on main behind the build switch, and no branch holds experimental work. A feature leaves the track only after an external cryptographic review and a maintainer's sign-off. Until then, the main product's decisions stand unchanged, and [Run an election](/guides/elections/) and the [security model](/reference/security/) describe Weft as you install it.

A page detects the experimental build from `window.weft.features`:

| Build | `features` |
|---|---|
| Weft | `["receipts"]` |
| Weft Experimental | `["receipts", "castBallot", "voterCredentials"]` |

Both report `version` 0.1.0, so a page checks `features` to tell them apart. See [Casting a ballot](/experimental/cast-ballot/#detecting-support).

## Two features

| Feature | Hides | From whom | Record |
|---|---|---|---|
| Private tally (`castBallot`) | The choice | Everyone, including the organisations, the relay and the voting web app, unless k trustee organisations combine their key shares on one ballot | [ADR 0007](/reference/decisions/) |
| Voter credentials (`voterCredentials`) | Who voted | The organisations, the public and the CA, which can't link a credential to a ballot | [ADR 0008](/reference/decisions/) |

They share one contract, `examples/private-ballot-contract`, written in Go. The main product's `examples/ballot-contract` stays as it is.

The private tally is built first, because it works with ordinary X.509 identities and needs no change at the CA. Voter credentials are built on top of it. An election with X.509 voters hides the choice and leaves the voter visible. An election with an idemix voter organisation hides both.

### The private tally

The trustee organisations jointly hold the election key. Any k of them can decrypt, and fewer can't. Weft encrypts the voter's choice under that key, with proofs that the ballot chooses exactly one option, and the contract checks the proofs. When voting closes, the contract adds up the encrypted ballots, and k trustees decrypt only the totals, each with a proof. Anyone who can read the ledger can re-check every step. See the [specification](/experimental/private-tally-spec/) and the [key ceremony](/experimental/key-ceremony/).

The voter chooses in Weft's approval window, and the web app's page never sees the choice. The receipt is a tracking code, which shows that the ballot was counted and holds nothing about the choice.

### Voter credentials

A voter credential is an Idemix credential from the election's own idemix CA, held in Weft and used only to cast ballots. A ballot signed with it shows the voter organisation, an affiliation every voter shares and a role. It doesn't show the voter's name or enrolment ID. A per-election pseudonym, with a proof Weft adds to the ballot, stops a second vote from the same credential. See [Voter credentials](/experimental/voter-credentials/).

## Who sees what

| Party | Main product | Private tally, X.509 voters | Private tally with voter credentials |
|---|---|---|---|
| Public explorer visitor | Neither who voted nor the choice, when the explorer hides submitters | Neither, and can re-check the whole count | Neither, and can re-check the whole count |
| Member organisations | Who voted, and the choice in the private collection | Who voted, not the choice | Neither: an anonymous member of the voter organisation |
| Endorsing peers | Who voted, and the choice | Who voted, not the choice | Neither |
| The relay | The certificate, the choice and the voter's network address | The certificate, a ciphertext and the network address | A ciphertext, the network address and the timing |
| The voting web app | The choice | Not the choice | Not the choice, and not which credential voted |
| The CA operator | Which certificate belongs to whom, so who voted | The same | Who holds a credential, not which ballot is theirs |
| k trustees together | Not applicable | Could read any one ballot, and see whose it is | Could read any one ballot, not whose it is |

Once both apply, the relay sees only ciphertext, and the organisations see neither who voted nor how. [What isn't hidden](/experimental/what-is-not-hidden/) lists what is still visible, and the options not taken.

## Run it

You need everything [the local test network](/dapps/test-network/) needs, and Go for the contract.

```sh
pnpm install
WEFT_EXPERIMENTAL=1 pnpm --filter @weftwallet/extension build   # Weft Experimental
pnpm playground:up --experimental                               # the network, plus the experimental channel
pnpm dev                                                        # the sites, in another terminal
```

Load Weft Experimental into a browser profile that doesn't have normal Weft. Both define `window.weft`, and the first to load on a page provides it.

`--experimental` adds, on top of everything `playground:up` runs:

| What | Planned value |
|---|---|
| Channel | `privatevote`, with Org1MSP and Org2MSP as endorsers and trustees, and VotersMSP, an idemix organisation |
| Contract | `private-ballot`, from `examples/private-ballot-contract`, endorsed by Org1 and Org2 |
| Key ceremony | Run with `weft trustee` for Org1 and Org2, 2 of 2 |
| Elections | `budget-2027`, with X.509 voters from Org1 and Org2 (private tally only), and `chair-2027`, with voter credentials from VotersMSP (both features) |
| Voters' CA | A CA of its own for `chair-2027`, with demo voters `voter1` to `voter5` |
| Explorers | Both organisations' explorers, started with `WEFT_EXPERIMENTAL=1`, with election pages for `privatevote` |

Weft Playground shows a "Private election" section only when Weft Experimental is present. Both trustees run on your machine, so the playground hides nothing from whoever runs it.

## Pages

- [Private tally specification](/experimental/private-tally-spec/): the cryptography, as a specification.
- [Key ceremony](/experimental/key-ceremony/): what trustees do, and what happens when something fails.
- [Contract API](/experimental/contract-api/): the Go contract's functions, state and errors.
- [Casting a ballot](/experimental/cast-ballot/): `weft_castBallot`, receipt version 2 and feature detection.
- [Voter credentials](/experimental/voter-credentials/): enrolment, the pseudonym proof, the relay and the explorer.
- [What isn't hidden](/experimental/what-is-not-hidden/): the limits, and the options not taken.
- [Prototype results](/experimental/prototype-results/): what the two prototypes ran, refused and measured.
