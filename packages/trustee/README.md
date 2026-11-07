# @weftwallet/trustee

`weft-trustee`, the tool a trustee organisation runs for a private election in Weft Experimental ([ADR 0007](../../docs/adr/0007-private-tally.md), [Key ceremony](../../apps/docs/src/content/docs/experimental/key-ceremony.md)). It is a private package: it isn't published, and you run it from a checkout of this repository. No one outside the project has reviewed its cryptography, which is [`@weftwallet/tally`](../tally).

It isn't part of `@weftwallet/cli`, which every operator installs, because it brings `@hyperledger/fabric-gateway`, gRPC and unreviewed cryptography ([ADR 0009](../../docs/adr/0009-experimental-track.md)).

```sh
pnpm install
pnpm --filter @weftwallet/trustee... build
alias weft-trustee="node $PWD/packages/trustee/dist/cli.js"
weft-trustee status --election budget-2027 --connection org1.yaml
```

## Commands

| Command | Does |
|---|---|
| `status` | Shows the election's state and each trustee's progress, and what to run next. `--json` prints the records. |
| `create` | Calls `CreateElection` with `--title`, an `--option` for each option, `--closes-at`, a `--trustee` for each trustee organisation in order, and optionally `--threshold` (a majority by default) and a `--voter` for each voter organisation (the trustees by default). |
| `commit` | Round 1: draws the polynomial and the one-time ceremony key, saves them encrypted, and posts the commitments, the proof of knowledge and the one-time public key. |
| `share` | Round 2: once every trustee has posted round 1, encrypts a share to each other trustee and posts them. |
| `confirm` | Round 3: once every trustee has posted round 2, decrypts and checks the shares sent to you, saves your key share encrypted, deletes the one-time ceremony key, and posts a proof that you hold the share. If a share fails, it posts a report instead, and the election fails. The last confirmation also calls `OpenElection`, checks the fingerprint, and prints it. |
| `open` | Calls `OpenElection` once every trustee has confirmed, for when the last `confirm` couldn't. |
| `close` | Calls `CloseElection`. Voting closes when k trustees have asked. Before `closesAt`, by this machine's clock, it refuses unless given `--early`. It needs no passphrase. |
| `decrypt` | Once voting has closed, posts your decryption share of each total, with proofs. The k-th share also calls `PublishTally`, checks the counts against the shares, and prints them. |
| `publish` | Calls `PublishTally` once k shares are in, for when the k-th `decrypt` couldn't. |
| `cancel` | Calls `CancelElection`, for a trustee of the creator's organisation while the election is in `keygen`. |
| `destroy` | Deletes the state folder, after asking you to type the election ID (`--yes` skips that). Before the tally is published it refuses unless given `--force`. |

Each command reads the election and its ceremony from the ledger first, and refuses, without asking for the passphrase or signing anything, when its step can't run yet. Every message says what happened first, then what to do.

## Connecting

`weft-trustee` connects to your organisation's own peer with the trustee identity, through the Fabric Gateway, as the explorer's indexer does. It uses no relay.

The trustee identity is an X.509 client identity of your organisation whose enrolment certificate carries the Fabric CA attribute `weft.trustee=true`:

```sh
fabric-ca-client register --id.name trustee1 --id.secret <secret> --id.type client --id.attrs 'weft.trustee=true:ecert' ...
fabric-ca-client enroll -u https://trustee1:<secret>@<ca> -M trustee1/msp ...
```

The recommended way to give the connection is one file per organisation and channel, with `--connection`. Flags of the same names give each setting instead, and override the file.

```yaml
peer: localhost:7051                    # --peer
peerHostAlias: peer0.org1.example.com   # --peer-host-alias, if the TLS certificate names another host
tlsCa: org1/tlsca/tlsca.org1.example.com-cert.pem   # --tls-ca
msp: Org1MSP                            # --msp
cert: trustee1/msp/signcerts            # --cert: a file, or a folder holding one
key: trustee1/msp/keystore              # --key
channel: privatevote-budget-2027        # --channel
contract: private-ballot                # --contract, this by default
home: trustee-state                     # --home, ~/.weft/trustee by default
```

Paths in the file are relative to the file. `WEFT_TRUSTEE_HOME` sets the home too, over the file's.

## The state folder

Each election's state is in `<home>/<channel>/<election>`, `~/.weft/trustee/privatevote-budget-2027/budget-2027` by default. The folder is created with mode 0700 and each file with 0600.

| File | Holds | Encrypted |
|---|---|---|
| `ceremony.json` | The polynomial and the one-time ceremony key, from round 1 until round 3 | Yes |
| `round1.json` | Your round 1 post, to post again if posting failed | No, it's public |
| `key-share.json` | Your key share, from round 3 until `destroy` | Yes |
| `confirmation.json` | Your round 3 post, to post again if posting failed | No, it's public |

The secrets are encrypted with a key from the passphrase: scrypt with N = 2^17, r = 8 and p = 1, and AES-256-GCM, with the file's header (organisation, channel, election and scrypt settings) as additional data. `commit` asks for a new passphrase twice; the other commands ask for it once. Scripts set `WEFT_TRUSTEE_PASSPHRASE` instead. The passphrase is written nowhere.

Deleting a file first overwrites it once with random bytes. SSDs and journaling or copy-on-write file systems can keep the old blocks, so keep the folder on a machine only the trustee's operators use, out of backups that outlive the election, as [Keeping a share](../../apps/docs/src/content/docs/experimental/key-ceremony.md#keeping-a-share) says.

## In the playground

`pnpm playground:up --experimental` registers `trustee1` at Org1's CA and `trustee2` at Org2's, writes a connection file for each election's channel in `playground/.state/trustees/<org>/<channel>.yaml`, with a random passphrase in `passphrase` beside it, and runs the ceremony for `budget-2027`. To run a command by hand there:

```sh
WEFT_TRUSTEE_PASSPHRASE=$(cat playground/.state/trustees/org1/passphrase) \
  weft-trustee status --election budget-2027 --connection playground/.state/trustees/org1/privatevote-budget-2027.yaml
```

`pnpm playground:count budget-2027` closes it early with both trustees, decrypts it and prints the counts.

## Tests

```sh
pnpm --filter @weftwallet/trustee test
```

The unit tests run every command against an in-memory stand-in for the contract, with the contract's checks from `@weftwallet/tally/verify` and its messages, and check each message in the step 4 model's transcripts, the state folder, the connection file and the trustee attribute. `src/integration.test.ts` runs a whole election on a running network when `WEFT_TRUSTEE_IT_ORG1` and `WEFT_TRUSTEE_IT_ORG2` name each trustee's connection file, and is skipped otherwise.
