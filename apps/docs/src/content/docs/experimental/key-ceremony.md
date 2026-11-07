---
title: Key ceremony
description: What a trustee organisation does before and after a private election, what happens when a step fails, and how to choose the threshold.
---

:::caution[Experimental]
This page describes Weft Experimental, a separate build that is not part of the main product, and nothing on it applies to Weft as you install it. No one outside the project has reviewed its cryptography. The contract and `weft-trustee` are built, and the playground runs the ceremony for its seeded election.
:::

A private election's key is shared among its trustee organisations. Before voting, they run a key ceremony over the ledger, which ends with an election key whose secret none of them holds. After voting, k of them each post a decryption share of the totals. The [specification](/experimental/private-tally-spec/#key-ceremony) has the cryptography, and this page covers what a trustee does.

## Who the trustees are

A trustee identity of one of the trustee organisations creates the election with [`CreateElection`](/experimental/contract-api/#createelection), naming the trustee organisations by MSP ID and the threshold k. Its organisation becomes the election's creator. Trustees must be X.509 organisations in the channel. Their order in the list gives each its identifier, 1 to n.

Each trustee organisation acts through a trustee identity: an X.509 client identity of that organisation whose certificate carries the Fabric CA attribute `weft.trustee=true`, so not every member of the organisation can act for it. Register one for the purpose, as for an explorer.

## The trustee tool

Trustees use `weft-trustee`, the command of `@weftwallet/trustee` in `packages/trustee`. It is a private package in Weft's repository, run from a checkout of it, and isn't published. It isn't part of `@weftwallet/cli`, which every operator installs: the trustee tool brings `@hyperledger/fabric-gateway`, gRPC and cryptography no one outside the project has reviewed, and [ADR 0009](/reference/decisions/) keeps experiments away from people who install Weft. Its cryptography is `@weftwallet/tally`, the same package Weft Experimental and the explorer use.

It connects to the organisation's own peer with `@hyperledger/fabric-gateway` and the trustee identity, as the explorer's indexer does, without a relay. It keeps the trustee's one-time ceremony key and key share in a state folder, encrypted with a passphrase it asks for. Run it from a checkout, after `pnpm --filter @weftwallet/trustee... build`, as `node packages/trustee/dist/cli.js`, which this page writes as `weft-trustee`.

Each command reads the election from the ledger first and refuses, without asking for the passphrase or signing anything, when its step can't run yet. `status` says what to run next.

Commands:

| Command | Does |
|---|---|
| `weft-trustee status --election <id>` | Shows the election's state and each trustee's progress, including who has asked to close, and what to run next. `--json` prints the records. |
| `weft-trustee create --election <id>` | Calls `CreateElection` with `--title`, an `--option` for each option, `--closes-at`, a `--trustee` for each trustee organisation in order, `--threshold` (a majority by default) and a `--voter` for each voter organisation (the trustees by default). |
| `weft-trustee commit --election <id>` | Round 1: draws the polynomial and the one-time key, and posts the commitments, the proof of knowledge and the one-time public key. |
| `weft-trustee share --election <id>` | Round 2: once every trustee has posted round 1, encrypts a share to each other trustee and posts them. |
| `weft-trustee confirm --election <id>` | Round 3: once every trustee has posted round 2, decrypts and checks its shares, saves its key share, posts a proof that it holds it, and deletes the one-time key. Reports a bad share instead, if one fails. When its confirmation is the last, it also calls `OpenElection`, checks the election fingerprint against the one it works out itself, and prints it. |
| `weft-trustee open --election <id>` | Calls `OpenElection` once every trustee has confirmed, if the last `confirm` couldn't. |
| `weft-trustee close --election <id>` | Asks to close voting with `CloseElection`. When it brings the number of trustees who have asked to k, the election closes. Before `closesAt`, by this machine's clock, it refuses unless given `--early`. It needs no key share and no passphrase. |
| `weft-trustee decrypt --election <id>` | Once the election has closed: posts its decryption share of each total, with proofs. When its share is the k-th, it also calls `PublishTally`, works out the counts again from the shares, and prints them. |
| `weft-trustee publish --election <id>` | Calls `PublishTally` once k shares are in, if the k-th `decrypt` couldn't. |
| `weft-trustee destroy --election <id>` | After the tally is published: deletes its key share and the state folder, once you type the election ID (`--yes` skips that). Before the tally it refuses unless given `--force`. |
| `weft-trustee cancel --election <id>` | For a trustee of the creator's organisation, while the election is in `keygen`: calls `CancelElection`. |

Every command also takes the connection settings: the peer endpoint and its TLS CA certificate, the MSP ID, the trustee identity's certificate and key, the channel and the contract name, as the explorer does. They go in one file per organisation and channel, given with `--connection`, and flags of the same names give or override each setting:

```yaml
peer: localhost:7051                    # --peer
peerHostAlias: peer0.org1.example.com   # --peer-host-alias, if the TLS certificate names another host
tlsCa: org1/tlsca/tlsca.org1.example.com-cert.pem   # --tls-ca
msp: Org1MSP                            # --msp
cert: trustee1/msp/signcerts            # --cert: a file, or a folder holding one
key: trustee1/msp/keystore              # --key
channel: privatevote-budget-2027        # --channel
contract: private-ballot                # --contract, this by default
home: trustee-state                     # --home or WEFT_TRUSTEE_HOME, ~/.weft/trustee by default
```

Paths in the file are relative to the file.

### The state folder

Each election's state is in its own folder, `<home>/<channel>/<election>`, so `~/.weft/trustee/privatevote-budget-2027/budget-2027` by default. The folder is created with mode 0700 and each file in it with mode 0600. It holds:

- `ceremony.json`: the polynomial and the one-time ceremony key, from round 1 until round 3, encrypted;
- `key-share.json`: the key share, from round 3 until `destroy`, encrypted;
- `round1.json` and `confirmation.json`: the trustee's own round 1 and round 3 posts, which are public, so a post that failed can be sent again.

Each secret is encrypted with AES-256-GCM, under a key derived from the passphrase with scrypt (N = 2^17, r = 8, p = 1), and the file's header, naming the organisation, the channel and the election, is bound to it as additional data. `commit` asks for a new passphrase twice, and the other commands ask once. Scripts set `WEFT_TRUSTEE_PASSPHRASE` instead. The passphrase isn't written anywhere. Deleting a file overwrites it once with random bytes first.

`OpenElection` and `PublishTally` stay open to anyone with an X.509 identity in the channel, since each only computes what the ledger already fixes. The commands call them so that trustees need no other tool.

## The steps

1. A trustee identity of one of the trustee organisations runs `create`, which calls `CreateElection`. The election is in the `keygen` state.
2. Every trustee runs `commit`. The contract checks each proof of knowledge as it's posted.
3. Every trustee runs `share`. The contract checks only that each trustee sends one share to every other trustee, because it can't read them.
4. Every trustee runs `confirm`. The contract checks each proof that the trustee holds its share.
5. The last `confirm` calls `OpenElection`. The contract computes the election key and verifying shares from the round 1 commitments, and the election opens. Weft and every explorer show the election fingerprint.
6. Voters cast ballots. `closesAt` is the planned closing time, and the contract doesn't act on it: after it, the election stays open, and keeps accepting ballots, until step 7.
7. At least k trustees run `close`. The request that brings the number to k closes the election and adds up the ballots. A ballot committed after that transaction is refused.
8. At least k trustees run `decrypt`. The contract checks each share's proofs, and the k-th `decrypt` calls `PublishTally`, which combines k shares and writes the counts.
9. Every trustee runs `destroy`.

Rounds 1 to 3 can't be run by one trustee alone: each waits for every trustee to finish the round before. `status` says who the ceremony is waiting for.

In the playground, `pnpm playground:up --experimental` runs steps 1 to 5 for Org1 and Org2, 2 of 2, on your machine, and `pnpm playground:count <election>` runs steps 7 and 8 with `--early`. The [playground's README](https://github.com/ifeanyi-ugwu/weft/tree/main/playground#the-key-ceremony-and-counting) has the details.

## When something fails

| What happens | Result | What to do |
|---|---|---|
| A trustee's round 1 proof doesn't verify | The contract refuses that transaction. | Run `commit` again. It posts the round 1 it saved. |
| A post fails validation, or the connection drops | Nothing changed on the ledger. | Run the command again. `commit` and `confirm` send the post they saved. |
| The passphrase doesn't open the state folder | Nothing is posted. | Run the command again with the passphrase set in round 1. |
| A trustee doesn't post a round | The election stays in `keygen`. Voting can't start. | Ask the trustee. A trustee of the creator's organisation can run `cancel` and create a new election, under a new ID, without that trustee. |
| A trustee loses its one-time key before round 3 | It can't decrypt the shares sent to it. | `cancel`, and create a new election. |
| A received share doesn't match the sender's commitments | `confirm` posts a report naming the sender, and the election moves to `failed`. | Find out why with the sender, and create a new election. |
| Fewer than k trustees run `close` | The election stays open and keeps accepting ballots. | Ask the trustees. Those who ran `close` keep their requests. |
| `close` fails validation with `PHANTOM_READ_CONFLICT` | A ballot committed while the close was being endorsed. Nothing changed. | Run `close` again. |
| A decryption share's proof doesn't verify | The contract refuses that transaction. | The trustee runs `decrypt` again with its own share. A share made with any other secret can't pass. |
| A trustee loses its key share after the election opens | If at least k trustees still hold theirs, the count goes ahead without it. | Nothing, as long as k remain. |
| Fewer than k trustees can or will decrypt | The totals can't be decrypted. The ballots stay on the ledger, encrypted. | There is no recovery: run the election again. |

Version 1 can't tell a trustee who sent a bad share from one who reports a good share as bad, so a report doesn't show which trustee is at fault. Either way the ceremony stops, which any trustee could already cause by not posting. Nothing about the key is learned, because the election never opens.

Key shares aren't re-shared or refreshed in version 1. A trustee that leaves the consortium during an election keeps its share until it destroys it.

## Keeping a share

A key share decrypts nothing alone. Any k shares together could decrypt any single ballot as well as the totals, at any time, and the ballots stay on the ledger permanently. To limit that:

- keep the state folder as you keep a CA's private key: on a machine only the trustee's operators use, with a passphrase they don't share;
- don't copy the folder into backups that outlive the election;
- run `destroy` once the tally is published. It overwrites each file once before deleting it, and SSDs and journaling or copy-on-write file systems can still keep the old blocks. Deletion can't be proved to anyone else, so voters still rely on fewer than k trustees colluding, before and after.

## Choosing the threshold

Any k trustees together can read a ballot, and any n - k + 1 together can stop the count by withholding their shares. A higher k protects secrecy and makes the count easier to stop. Closing voting needs the same k, so no smaller group can end voting, and the n - k + 1 who could stop a close by not asking could already stop the count.

| Trustees n | Default k (a majority) | Trustees needed to read a ballot | Trustees needed to stop the count |
|---|---|---|---|
| 2 | 2 | 2 | 1 |
| 3 | 2 | 2 | 2 |
| 4 | 3 | 3 | 2 |
| 5 | 3 | 3 | 3 |
| 7 | 4 | 4 | 4 |

The default is a majority, `floor(n / 2) + 1`, set per election. Choose k = n only when every trustee is certain to be there for the count. Weft shows the trustees and the threshold in the approval window before each vote, so voters can see who they are trusting.
