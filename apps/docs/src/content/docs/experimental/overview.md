---
title: Experimental features
description: Weft Experimental, a separate build with a private tally and anonymous voter credentials, and what each hides from whom.
---

:::caution[Experimental]
This page describes Weft Experimental, a separate build that is not part of the main product, and nothing on it applies to Weft as you install it. No one outside the project has reviewed its cryptography. The private tally is built: the build switch, the experimental channels, its cryptography (`@weftwallet/tally` and the contract's verifiers), the contract, the trustee tool, `weft-trustee`, casting a private ballot in Weft Experimental with `weft_castBallot`, the explorer's private election pages with the full check, and the playground's Private election section. The playground seeds and counts an election with them. For voter credentials, the contract, the idemix module, the relay's part and the playground's voters' CAs, CA proxies and voter invites are built; Weft Experimental can't hold a voter credential yet, and the page describes the rest as planned.
:::

## The experimental track

Weft Experimental is Weft built with `WEFT_EXPERIMENTAL=1`. It is a separate extension with its own name, extension ID and storage. It installs alongside Weft and shares no identities, keys or receipts with it, and only it carries the features on these pages. ([ADR 0009](/reference/decisions/))

The code lives on main behind the build switch, and no branch holds experimental work. A feature leaves the track only after an external cryptographic review and a maintainer's sign-off. Until then, the main product's decisions stand unchanged, and [Run an election](/guides/elections/) and the [security model](/reference/security/) describe Weft as you install it.

A page detects the experimental build from `window.weft.features`:

| Build | `features` |
|---|---|
| Weft | `["receipts"]` |
| Weft Experimental | `["receipts", "castBallot", "voterCredentials"]`, each once it's built. Today it lists `["receipts", "castBallot"]`. |

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

The voter chooses in Weft's approval window, and the web app's page never sees the choice. The receipt is a tracking code, which shows that the ballot was counted and holds nothing about the choice. Weft Experimental casts ballots this way today: see [Casting a ballot](/experimental/cast-ballot/).

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

Weft Experimental's popup and windows say "Weft Experimental" and draw its pinked mark, and its welcome says it is a separate build. It has its own extension ID (in Firefox, `experimental@weft.ifeanyiugwu.dev`), so you enrol in it separately.

`--experimental` adds, on top of everything `playground:up` runs:

| What | Value | Now |
|---|---|---|
| Channels | One per election in the playground's list, `privatevote-<election id>`, each with Org1MSP and Org2MSP as endorsers, administrators and trustees. An election with voter credentials adds its own idemix organisation: `privatevote-chair-2027` has ChairVoters2027MSP for `chair-2027` | Both created: `privatevote-budget-2027` with no idemix organisation, `privatevote-chair-2027` with ChairVoters2027MSP. |
| Voters' CA | A Fabric CA for each such election, each with its own issuer key, in Docker like test-network's CAs. For `chair-2027`, the CA `ca-chair-2027` on `https://localhost:7058`, whose idemix issuer key is ChairVoters2027MSP's, with demo voters `voter1` to `voter5` (secret `voter1pw` and so on), each registered with affiliation `voters` and one enrolment. In front of it, a proxy for the browser on the port in the election's entry, `http://localhost:7081` for `chair-2027` | Running, with its proxy, which passes only `GET /api/v1/cainfo`, and `POST /api/v1/idemix/credential` with basic authorisation, and refuses every other request with a message that says so. With `--https`, the proxy serves HTTPS with the mkcert certificate Org1's CA proxy uses. |
| Contract | `private-ballot`, from `examples/private-ballot-contract`, endorsed by Org1 and Org2 | Deployed on both channels with `AND('Org1MSP.peer','Org2MSP.peer')`, and deployed again when its source changes. It takes elections with X.509 voters and with voter credentials. |
| Key ceremony | Run with `weft-trustee` for Org1 and Org2, 2 of 2, with a trustee identity (`weft.trustee=true`) at each organisation's CA | Built. `trustee1` at Org1's CA and `trustee2` at Org2's, with a connection file for each election's channel in `playground/.state/trustees/<org>`. |
| Elections | One list in `playground/experimental.mjs`, each with an optional voter organisation. `budget-2027` on `privatevote-budget-2027`, with X.509 voters from Org1 and Org2 (private tally only), seeded open for 30 days. `chair-2027` on `privatevote-chair-2027`, with voter credentials from ChairVoters2027MSP (both features), seeded open for 30 days | Built. Both are created, their key ceremonies run and opened by `pnpm playground:up --experimental`, and an election that already exists is left as it is. `chair-2027` pins its CA's issuer key and the affiliation `voters`, and `up` prints its election fingerprint and how many credentials its CA has issued. |
| Counting | `pnpm playground:count <election>` closes the election and decrypts it for Org1 and Org2, so a tester sees a count without waiting for `closesAt` | Built. It closes with `--early`, posts both decryption shares, publishes the tally and prints the counts. With `--channel <channel>` it counts an election that isn't in the list, such as the one the e2e tests create on `privatevote-budget-2027` for each run. For an election with voter credentials, it first counts the credentials and refuses to close the election if a voter ID holds more than one, unless given `--accept-extra-credentials`. |
| Credentials | `pnpm playground:credentials <election>` counts the credentials an election's voters' CA has issued, per enrolment ID, from the CA's own database | Built. It exits with status 1 and names the ID when one holds more than one. |
| Relay | Started with `WEFT_EXPERIMENTAL=1`, `WEFT_IDEMIX_MSP_IDS=ChairVoters2027MSP` and `WEFT_VOTER_INVITES=playground/.state/voter-invites`, and its invite lists every election's channel | Running. It accepts idemix signers from ChairVoters2027MSP, with a new gateway for each of their requests, logs nothing for those requests, and serves `chair-2027`'s voter invite at `http://localhost:8787/.well-known/weft-voter-invite/chair-2027.json`. |
| Weft Playground | A Private election section, shown only to Weft Experimental, which lists the elections from the invite's explorer, casts with `weft_castBallot` and shows the receipt and the count | Built. It reads the elections from Org1's explorer's JSON API, sends Weft only the channel, the contract and the election ID, and shows the block, the version 2 receipt, every error with its code, and the tally once it is published. |
| Explorers | Both organisations' explorers, started with `WEFT_EXPERIMENTAL=1`, with `privateElections: private-ballot` for every election's channel in their policies. Org1's shows submitters and Org2's hides them, and both publish each ballot's voter tag for the [full check](/experimental/cast-ballot/#what-the-explorer-publishes) | Running, with election pages: each election's state from its key ceremony to its count, the ceremony, each ballot's proof status, the totals with each trustee's decryption share, the tracking code check Weft links to, and Check every ballot, which re-checks the whole election in the browser's workers. Org1's ballots table also shows who submitted each ballot. A page left open updates in place, and shows the checks once an election opens. See [Run an explorer](/operators/explorer/#private-elections). |

`pnpm playground:down` removes the experimental channels, the voters' CAs, their proxies and the voter invites with everything else. Another election with voter credentials is one more entry in the playground's list of elections, and the next `pnpm playground:up --experimental` starts its CA and its proxy, creates its channel, writes its voter invite and seeds it. The [playground's README](https://github.com/ifeanyi-ugwu/weft/tree/main/playground#adding-an-election) has the details. Run `pnpm playground:up` without `--experimental` to go back to the normal relay and explorers on the same network.

Weft Playground, at `http://localhost:4323`, shows a "Private election" section only when `window.weft.features` includes `"castBallot"`, which Weft Experimental lists. It lists the elections that Org1's explorer publishes, with `budget-2027` open. Join and choose `budget-2027`, then press Vote in Weft: you choose in Weft Experimental's window, and the page gets the block and a version 2 receipt, never your choice. Its provider log shows the whole conversation with Weft. `pnpm playground:count budget-2027` closes and counts the election, and the section then shows the tally. Either explorer's page for the election, at `/channels/privatevote-budget-2027/elections/budget-2027`, shows it with its proofs, and checks the tracking code from the receipt. Both trustees run on your machine, so the playground hides nothing from whoever runs it.

### The switches

| Part | Switch | Off by default |
|---|---|---|
| Extension | `WEFT_EXPERIMENTAL=1` at build time, which `dev:experimental`, `build:experimental` and `build:e2e:experimental` set. It changes the name, the extension ID, the output folder, the mark and `features`, adds `weft_castBallot`, and keeps the CA chain at enrolment. The normal build contains none of the experimental code. | Yes |
| Relay | `WEFT_EXPERIMENTAL=1`, `WEFT_IDEMIX_MSP_IDS` for the voter MSPs, and `WEFT_VOTER_INVITES` for the voter invites. It refuses to start with `WEFT_IDEMIX_MSP_IDS` or `WEFT_VOTER_INVITES` and without `WEFT_EXPERIMENTAL=1`. Without the switch it refuses every idemix signer, and logs as it always has. | Yes |
| Explorer | `WEFT_EXPERIMENTAL=1`, and a channel's `privateElections` in the policy. It refuses to start with `privateElections` and without `WEFT_EXPERIMENTAL=1`, or with `privateElections` and `values: hash` on the same channel. With `privateElections`, it publishes each ballot's voter tag even when `submitter: hide`. Without the switch it indexes, serves and allows in its content security policy none of the private election pages, their API or the full check's worker. | Yes |
| Playground stack | `pnpm playground:up --experimental` | Yes |

## Pages

- [Private tally specification](/experimental/private-tally-spec/): the cryptography, as a specification.
- [Key ceremony](/experimental/key-ceremony/): what trustees do, and what happens when something fails.
- [Contract API](/experimental/contract-api/): the Go contract's functions, state and errors.
- [Casting a ballot](/experimental/cast-ballot/): `weft_castBallot`, receipt version 2 and feature detection.
- [Voter credentials](/experimental/voter-credentials/): enrolment, the pseudonym proof, the relay and the explorer.
- [What isn't hidden](/experimental/what-is-not-hidden/): the limits, and the options not taken.
- [Prototype results](/experimental/prototype-results/): what the two prototypes ran, refused and measured.
