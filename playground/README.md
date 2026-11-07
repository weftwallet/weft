# Weft playground stack

`pnpm playground:up` starts a local Hyperledger Fabric network configured for Weft. Use it to try the wallet, build a dApp, or run Weft Playground against a real network on your machine.

```sh
pnpm playground:up       # first run downloads Fabric (5 to 10 minutes)
pnpm playground:up --https   # the same, with the CA on https://localhost:7443 (needs mkcert)
pnpm playground:up --experimental   # also Weft Experimental's channels (needs Go)
pnpm playground:count budget-2027   # with --experimental: close an election early and count it
pnpm dev                 # in another terminal: the sites, then open http://localhost:4323
pnpm playground:down     # stop everything and remove the network
pnpm playground:status   # what's running
pnpm playground:explorer # start or restart only the explorers, on a running stack
```

## Requirements

- Docker (Docker Desktop or OrbStack), running
- git and curl
- [mkcert](https://github.com/FiloSottile/mkcert), only for `--https` (`brew install mkcert` on macOS)
- [Go](https://go.dev/dl/), only for `--experimental` (`brew install go` on macOS). The experimental contract is written in Go. If `go` isn't on your `PATH`, `--experimental` stops before doing anything and says so.

## What it runs

| Piece | Where | Notes |
|---|---|---|
| Fabric `test-network` | Docker | Two organisations, Raft orderer, a CA per organisation, channels `mychannel` and `members` |
| `basic` contract | `mychannel` | fabric-samples' asset-transfer (TypeScript) |
| `ballot` contract | `mychannel` | `examples/ballot-contract`, with its private collection. `seed-elections.mjs` adds `team-lunch` (counted) and `board-2026` (open); receipts for the seeded ballots are in `.state/receipts.json` |
| `basic` contract | `members` | A second channel both explorers publish to signed-in members only. `seed-members.mjs` adds the sample's starting assets. Sign in on an explorer or on Weft Network to see it |
| Org1 CA proxy | `http://localhost:7080`, or `https://localhost:7443` with `--https` | Forwards to the CA's HTTPS on 7054, so the browser can enrol (see below) |
| Relay | `http://localhost:8787` | Connects to `peer0.org1`; serves the invite at `/.well-known/weft-invite.json` |
| Explorers | `http://localhost:8790` (Org1), `http://localhost:8791` (Org2) | Each reads `mychannel` and `members` from its own organisation's peer, publishes what `explorer.yaml` or `explorer-org2.yaml` allows, and cross-checks with the other. Org1's also publishes the ballots' private data hashes. Org2's publishes less: no submitters, private data by name only, and `basic` for members only. The invite names Org1's, so Weft links activity to it |

## The experimental channels

> [!CAUTION]
> This part is experimental. It sets up for Weft Experimental, a separate build that is not part of Weft, and no one outside the project has reviewed its cryptography. See [ADR 0009](../docs/adr/0009-experimental-track.md) and [Experimental features](../apps/docs/src/content/docs/experimental/overview.md).

`pnpm playground:up --experimental` runs everything above, and `experimental.mjs` adds:

| Piece | Where | Notes |
|---|---|---|
| Voters' CA | Docker, `https://localhost:7058`, CA `ca-chair-2027` | One per election with voter credentials, each with its own issuer key ([ADR 0008](../docs/adr/0008-idemix-voter-credentials.md)). The playground has one, `chair-2027`. Its CA runs in the container `ca_voters_chair_2027` from `compose-voters-ca.yaml`, with the same image and start command as test-network's CAs, and its home mounted from `.state/voters-ca/chair-2027/server`. Its idemix issuer key is ChairVoters2027MSP's. Demo voters `voter1` to `voter5`, secrets `voter1pw` to `voter5pw`, affiliation `voters`, one enrolment each. No CA proxy for the browser yet |
| A channel per election, `privatevote-<election id>` | Both peers and the orderer | `privatevote-budget-2027` for `budget-2027` and `privatevote-chair-2027` for `chair-2027`. Each is created from its own genesis block (`.state/private-channels/<channel>`), with Org1MSP and Org2MSP, which endorse and administer it, and the election's idemix organisation if it has one, ChairVoters2027MSP for `chair-2027`. Contracts and their lifecycle need both organisations' peers, and channel configuration updates need both organisations' admins |
| `private-ballot` contract | Every election's channel | [`examples/private-ballot-contract`](../examples/private-ballot-contract), in Go, deployed with test-network's `deployCC -ccl go` and the endorsement policy `AND('Org1MSP.peer','Org2MSP.peer')`. `.state/private-channels/<channel>/private-ballot.json` records the sequence and a hash of the source, and a change to the source deploys it again with the next sequence. Each organisation's peer then answers `GetElection` |
| Trustees | Each organisation's CA | `trustee1` at Org1's CA and `trustee2` at Org2's, secrets `trustee1pw` and `trustee2pw`, registered with `weft.trustee=true` in the enrolment certificate. Their credentials, a connection file for [`weft-trustee`](../packages/trustee) on each election's channel and a random passphrase are in `.state/trustees/org1` and `.state/trustees/org2`. See [the key ceremony and counting](#the-key-ceremony-and-counting) |
| Seeded election | `privatevote-budget-2027` | `budget-2027`, Budget 2027, with Plan A, Plan B and Plan C, open for 30 days, with Org1MSP and Org2MSP as trustees, 2 of 2, and X.509 voters from both. `chair-2027` isn't seeded, since its voters use voter credentials ([ADR 0008](../docs/adr/0008-idemix-voter-credentials.md)) |
| Relay | `http://localhost:8787` | Started with `WEFT_EXPERIMENTAL=1` and `WEFT_IDEMIX_MSP_IDS=ChairVoters2027MSP`, one MSP ID per election. The invite also lists every election's channel |
| Explorers | As above | Started with `WEFT_EXPERIMENTAL=1`, with a copy of their policy in `.state` that also publishes every election's channel with `privateElections: private-ballot` |

Build the wallet with `pnpm --filter @weftwallet/extension build:experimental` and load it in a browser profile without Weft. Weft Playground then shows its Private election section, which lists the elections from Org1's explorer and casts with `weft_castBallot`: join as `alice` or `bob`, choose `budget-2027` and press Vote in Weft. `pnpm playground:up` without the flag on a running stack restarts the relay and the explorers without the experimental settings and stops the voters' CA containers. The channels stay on the network until `pnpm playground:down`, which removes them, the voters' CA containers and their homes, and the trustees' folders in `.state` with everything else.

### The key ceremony and counting

After the contract, `seedElections` in `experimental.mjs` builds `weft-trustee` (`packages/trustee`), registers and enrols the two trustee identities, and writes, for each organisation:

| File in `.state/trustees/<org>` | Holds |
|---|---|
| `msp/` | The trustee identity's certificate and key, from `fabric-ca-client enroll` |
| `<channel>.yaml` | `weft-trustee`'s connection file for that election's channel: the organisation's peer, its TLS CA, the MSP ID, the certificate and key, the channel, the contract, and `home: state` |
| `passphrase` | A random passphrase for the state folders, mode 0600 |
| `state/<channel>/<election>/` | `weft-trustee`'s state folder: the key share, encrypted with that passphrase |

Then, for each election in `ELECTIONS` with a `seed` and X.509 voters, it runs as Org1's trustee `weft-trustee create`, and then `commit`, `share` and `confirm` for Org1 and Org2 in turn. The last `confirm` opens the election and checks its fingerprint. An election that already exists is left as it is, so running `up` again changes nothing; one left in its key ceremony gets the rounds it is missing. Last, each organisation's trustee reads every election through its own peer's gateway, and `up` prints what each answered.

To run `weft-trustee` by hand as Org1's trustee, from the repository's root:

```sh
WEFT_TRUSTEE_PASSPHRASE=$(cat playground/.state/trustees/org1/passphrase) \
  node packages/trustee/dist/cli.js status --election budget-2027 \
  --connection playground/.state/trustees/org1/privatevote-budget-2027.yaml
```

`pnpm playground:count <election>` counts an election without waiting for its planned closing time. As each organisation's trustee in turn, it runs `weft-trustee close --early`, until the election closes, then `decrypt`, the second of which publishes the tally, and prints the counts. After eight ballots:

```
[1] Counting budget-2027 with Org1MSP and Org2MSP
    Org1MSP  ✓ Asked to close budget-2027 in block 20. 1 of 2 trustees have asked; voting closes when 2 have.
    Org2MSP  ✓ Closed budget-2027 in block 21: 2 of 2 trustees asked. Added up 8 ballots per option.
    ...
    Org2MSP  ✓ 2 of 2 shares are in. Published the tally in block 24.

Budget 2027 (budget-2027), counted

  Plan A   3
  Plan B   4
  Plan C   1
  8 ballots
```

A step that has already happened is skipped, so it can run again. A counted election stays counted: `pnpm playground:down` and `up --experimental` seed a new one.

An election that isn't in `ELECTIONS`, on one of their channels, is counted with its channel: `pnpm playground:count e2e-mw6z8voa --channel privatevote-budget-2027`. The e2e tests' experimental-stack project creates such an election for each run, with `seedElection` and the trustees above, votes in it from a site and from Weft Playground, and counts it this way (`e2e/support/experimental.ts`).

### Adding an election

Each election is one entry in `ELECTIONS` in `experimental.mjs`. An election with X.509 voters, the private tally only, has its ID, and a `seed` if `up` should create and open it:

```js
{ id: "budget-2028", seed: { title: "Budget 2028", options: ["Plan A", "Plan B", "Plan C"], openForDays: 30 } },
```

An election with voter credentials also has `voterOrg`, its MSP ID and its CA's name and ports:

```js
{ id: "chair-2028", voterOrg: { mspId: "ChairVoters2028MSP", ca: { name: "ca-chair-2028", port: 7158, operations: 17158 } } },
```

The next `pnpm playground:up --experimental` creates the election's channel, `privatevote-budget-2028` or `privatevote-chair-2028`, joins the orderer and both peers to it, deploys `private-ballot` on it, seeds it if it has a `seed`, and restarts the relay and the explorers with the new channel in the invite and the policies. With `voterOrg`, it first starts the election's CA in its own container, registers the demo voters and writes its MSP folder to `.state/voters-msp/ChairVoters2028MSP`, and the relay gets the new MSP ID in `WEFT_IDEMIX_MSP_IDS`. The other elections' channels don't change. The election's ID names its channel, so it uses lower-case letters, digits, dots and hyphens, starting with a letter, as Fabric's channel names do.

A channel holds one election's idemix organisation at most. Fabric recommends one idemix MSP per channel, because the MSP ID tells idemix organisations apart, and a channel per election keeps elections apart: one election's voters can't read another's ballots, and closing one election changes no other channel. The channel's Admins policy names Org1's and Org2's admins, so a configuration update needs both. Under `MAJORITY Admins`, which test-network's channels use, the idemix organisation would count, and one organisation's admin with an admin credential from the voters' CA would be enough.

A network started before the playground had a channel per election has every election on one channel, `privatevote`. Run `pnpm playground:down`, then `pnpm playground:up --experimental`, to replace it.

## Demo users (Org1)

| Enrolment ID | Secret | Attributes |
|---|---|---|
| `alice` | `alicepw` | `role=auditor` |
| `bob` | `bobpw` | `role=trader` |

## Why the playground uses a CA proxy

The test network's CA serves HTTPS with a self-signed certificate. Browsers reject it, and accepting it in a tab doesn't help: the extension's background worker still refuses it, so enrolment fails with "Failed to fetch". The proxy connects to the CA over HTTPS, verifying it against the CA's own root certificate, and serves plain HTTP on `localhost`, which browsers allow. This mode needs no certificate installed or trusted.

### HTTPS with `--https`

Real organisations give an `https://` CA URL, so use `pnpm playground:up --https` to test that path. The script runs `mkcert -install`, which adds mkcert's root to your system's trusted certificates (it may ask for your password the first time), makes a `localhost` certificate in `playground/.state`, and serves the proxy on `https://localhost:7443`. Chrome trusts the system's certificates, and unlike a certificate accepted in a tab, that trust reaches the extension too. Firefox keeps its own list: mkcert adds its root there if `certutil` is installed (`brew install nss`).

If mkcert isn't installed, `--https` stops before doing anything and tells you to install it or drop the flag.

Restart the stack to switch between the two (`pnpm playground:down`, then `up` with or without `--https`), and rejoin from the playground, since the invite's CA URL changes.

## Using your own fabric-samples

Set `WEFT_FABRIC_SAMPLES` to an existing checkout that has `bin/` and `test-network/`; otherwise the script downloads Fabric 2.5 and Fabric CA 1.5 into `playground/.fabric` (git-ignored).

## Hosting it

The same pieces run on a server. Put the relay and the CA proxy behind real TLS (the proxy takes `--cert` and `--key`), set the relay's `WEFT_PUBLIC_URL`, and point the playground's `?invite=` at the public invite. For a public demo, add rate limiting and reset the network on a schedule.
