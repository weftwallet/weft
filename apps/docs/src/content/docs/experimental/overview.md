---
title: Experimental features
description: Weft Experimental, a separate build with a private tally and anonymous voter credentials, and what each hides from whom.
---

:::caution[Experimental]
This page describes Weft Experimental, a separate build that is not part of the main product, and nothing on it applies to Weft as you install it. No one outside the project has reviewed its cryptography. Only the build switch and the experimental channels are built so far. The two features aren't built yet, and the page describes their planned design.
:::

## The experimental track

Weft Experimental is Weft built with `WEFT_EXPERIMENTAL=1`. It is a separate extension with its own name, extension ID and storage. It installs alongside Weft and shares no identities, keys or receipts with it, and only it carries the features on these pages. ([ADR 0009](/reference/decisions/))

The code lives on main behind the build switch, and no branch holds experimental work. A feature leaves the track only after an external cryptographic review and a maintainer's sign-off. Until then, the main product's decisions stand unchanged, and [Run an election](/guides/elections/) and the [security model](/reference/security/) describe Weft as you install it.

A page detects the experimental build from `window.weft.features`:

| Build | `features` |
|---|---|
| Weft | `["receipts"]` |
| Weft Experimental | `["receipts", "castBallot", "voterCredentials"]`, each once it's built. Today it lists `["receipts"]`. |

Both report `version` 0.1.0, so a page checks `features` to tell them apart. See [Casting a ballot](/experimental/cast-ballot/#detecting-support).

## Two features

| Feature | Hides | From whom | Record |
|---|---|---|---|
| Private tally (`castBallot`) | The choice | Everyone, including the organisations, the relay and the voting web app, unless k trustee organisations combine their key shares on one ballot | [ADR 0007](/reference/decisions/) |
| Voter credentials (`voterCredentials`) | Who voted | The organisations, the public and the CA, which can't link a credential to a ballot | [ADR 0008](/reference/decisions/) |

They share one contract, `examples/private-ballot-contract`, written in Go. The main product's `examples/ballot-contract` stays as it is.

The private tally is built first, because it works with ordinary X.509 identities and needs no change at the CA. Voter credentials are built on top of it. An election with X.509 voters hides the choice and leaves the voter visible. An election with an idemix voter organisation hides both.

### The private tally

The trustee organisations jointly hold the election key. Any k of them can decrypt, and fewer can't. Weft encrypts the voter's choice under that key, with proofs that the ballot chooses exactly one option, and the contract checks the proofs. When k trustees close voting on the ledger, the contract adds up the encrypted ballots, and k trustees decrypt only the totals, each with a proof. Anyone who can read the ledger can re-check every step. See the [specification](/experimental/private-tally-spec/) and the [key ceremony](/experimental/key-ceremony/).

The voter chooses in Weft's approval window, and the web app's page never sees the choice. The receipt is a tracking code, which shows that the ballot was counted and holds nothing about the choice.

### Voter credentials

A voter credential is an Idemix credential from the election's own idemix CA, held in Weft and used only to cast ballots. A ballot signed with it shows the voter organisation, an affiliation every voter shares and a role. It doesn't show the voter's name or enrolment ID. A per-election pseudonym, with a proof Weft adds to the ballot, stops a second vote from the same credential. See [Voter credentials](/experimental/voter-credentials/).

## Who sees what

| Party | Main product | Private tally, X.509 voters | Private tally with voter credentials |
|---|---|---|---|
| Public explorer visitor | Neither who voted nor the choice, when the explorer hides submitters | Not the choice. A voter tag for each ballot, which names no one, and who voted when the explorer shows submitters. Can re-check the whole count | Neither, and can re-check the whole count |
| Member organisations | Who voted, and the choice in the private collection | Who voted, not the choice | Neither: an anonymous member of the voter organisation |
| Endorsing peers | Who voted, and the choice | Who voted, not the choice | Neither |
| The relay | The certificate, the choice and the voter's network address | The certificate, a ciphertext and the network address | A ciphertext, the network address and the timing |
| The voting web app | The choice | Not the choice | Not the choice, and not which credential voted |
| The CA operator | Which certificate belongs to whom, so who voted | The same | Who holds a credential, not which ballot is theirs |
| k trustees together | Not applicable | Could read any one ballot, and see whose it is | Could read any one ballot, not whose it is |

Once both apply, the relay sees only ciphertext, and the organisations see neither who voted nor how. [What isn't hidden](/experimental/what-is-not-hidden/) lists what is still visible, and the options not taken.

## Run it

You need everything [the local test network](/dapps/test-network/) needs, and Go for the contract. `pnpm playground:up --experimental` checks for Go and stops before starting anything if `go` isn't on your `PATH` (macOS: `brew install go`; others: [go.dev/dl](https://go.dev/dl/)).

```sh
pnpm install
pnpm --filter @weftwallet/extension build:experimental   # Weft Experimental, in apps/extension/.output-experimental
pnpm playground:up --experimental                         # the network, plus the experimental channels
pnpm dev                                                  # the sites, in another terminal
```

Load `apps/extension/.output-experimental/chrome-mv3` into a browser profile that doesn't have normal Weft, from `chrome://extensions` with Developer mode and Load unpacked. Both builds define `window.weft`, and the first to load on a page provides it. `pnpm dev:extension:experimental` instead opens its own Chrome with Weft Experimental loaded, in a profile of its own, and reloads it as you edit. The [extension's README](https://github.com/ifeanyi-ugwu/weft/tree/main/apps/extension) has the Firefox commands.

Weft Experimental's popup and windows say "Weft Experimental", and its welcome says it is a separate build. It has its own extension ID (in Firefox, `experimental@weft.ifeanyiugwu.dev`), so you enrol in it separately.

`--experimental` adds, on top of everything `playground:up` runs:

| What | Value | Now |
|---|---|---|
| Channels | One per election in the playground's list, `privatevote-<election id>`, each with Org1MSP and Org2MSP as endorsers, administrators and trustees. An election with voter credentials adds its own idemix organisation: `privatevote-chair-2027` has ChairVoters2027MSP for `chair-2027` | `privatevote-chair-2027` created. `privatevote-budget-2027` not yet. |
| Voters' CA | A Fabric CA for each such election, each with its own issuer key, in Docker like test-network's CAs. For `chair-2027`, the CA `ca-chair-2027` on `https://localhost:7058`, whose idemix issuer key is ChairVoters2027MSP's, with demo voters `voter1` to `voter5` (secret `voter1pw` and so on), each registered with affiliation `voters` and one enrolment | Running. No CA proxy for the browser yet. |
| Contract | `private-ballot`, from `examples/private-ballot-contract`, endorsed by Org1 and Org2 | Not built yet |
| Key ceremony | Run with `weft-trustee` for Org1 and Org2, 2 of 2, with a trustee identity (`weft.trustee=true`) at each organisation's CA | Not built yet |
| Elections | One list in `playground/experimental.mjs`, each with an optional voter organisation. `budget-2027` on `privatevote-budget-2027`, with X.509 voters from Org1 and Org2 (private tally only), seeded open for 30 days. `chair-2027` on `privatevote-chair-2027`, with voter credentials from ChairVoters2027MSP (both features), gets the contract and isn't seeded until voter credentials are built | Not built yet |
| Counting | `pnpm playground:count <election>` closes the election and decrypts it for Org1 and Org2, so a tester sees a count without waiting for `closesAt` | Not built yet |
| Relay | Started with `WEFT_EXPERIMENTAL=1` and `WEFT_IDEMIX_MSP_IDS=ChairVoters2027MSP`, and its invite lists every election's channel | Running. It accepts no idemix signers yet. |
| Explorers | Both organisations' explorers, started with `WEFT_EXPERIMENTAL=1`, with `privateElections: private-ballot` for every election's channel in their policies. Org1's shows submitters and Org2's hides them, and both publish each ballot's voter tag for the [full check](/experimental/cast-ballot/#what-the-explorer-publishes) | Running. They show those channels as ordinary channels until election pages are built. |

`pnpm playground:down` removes the experimental channels and the voters' CAs with everything else. Another election with voter credentials is one more entry in the playground's list of elections, and the next `pnpm playground:up --experimental` starts its CA and creates its channel. The [playground's README](https://github.com/ifeanyi-ugwu/weft/tree/main/playground#adding-an-election) has the details. Run `pnpm playground:up` without `--experimental` to go back to the normal relay and explorers on the same network.

Weft Playground shows a "Private election" section only when `window.weft.features` includes `"castBallot"`, which no build lists yet. Both trustees run on your machine, so the playground hides nothing from whoever runs it.

### The switches

| Part | Switch | Off by default |
|---|---|---|
| Extension | `WEFT_EXPERIMENTAL=1` at build time, which `dev:experimental`, `build:experimental` and `build:e2e:experimental` set. It changes the name, the extension ID, the output folder and `features`, and the normal build contains none of the experimental code. | Yes |
| Relay | `WEFT_EXPERIMENTAL=1`, and `WEFT_IDEMIX_MSP_IDS` for the voter MSPs. It refuses to start with `WEFT_IDEMIX_MSP_IDS` and without `WEFT_EXPERIMENTAL=1`. | Yes |
| Explorer | `WEFT_EXPERIMENTAL=1`, and a channel's `privateElections` in the policy. It refuses to start with `privateElections` and without `WEFT_EXPERIMENTAL=1`, or with `privateElections` and `values: hash` on the same channel. With `privateElections`, it publishes each ballot's voter tag even when `submitter: hide`. | Yes |
| Playground stack | `pnpm playground:up --experimental` | Yes |

## Pages

- [Private tally specification](/experimental/private-tally-spec/): the cryptography, as a specification.
- [Key ceremony](/experimental/key-ceremony/): what trustees do, and what happens when something fails.
- [Contract API](/experimental/contract-api/): the Go contract's functions, state and errors.
- [Casting a ballot](/experimental/cast-ballot/): `weft_castBallot`, receipt version 2 and feature detection.
- [Voter credentials](/experimental/voter-credentials/): enrolment, the pseudonym proof, the relay and the explorer.
- [What isn't hidden](/experimental/what-is-not-hidden/): the limits, and the options not taken.
- [Prototype results](/experimental/prototype-results/): what the two prototypes ran, refused and measured.
