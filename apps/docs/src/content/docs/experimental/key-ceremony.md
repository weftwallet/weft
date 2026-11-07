---
title: Key ceremony
description: What a trustee organisation does before and after a private election, what happens when a step fails, and how to choose the threshold.
---

:::caution[Experimental]
This page describes Weft Experimental, a separate build that is not part of the main product, and nothing on it applies to Weft as you install it. No one outside the project has reviewed its cryptography. None of it is built yet, and the page describes the planned design.
:::

A private election's key is shared among its trustee organisations. Before voting, they run a key ceremony over the ledger, which ends with an election key whose secret none of them holds. After voting, k of them each post a decryption share of the totals. The [specification](/experimental/private-tally-spec/#key-ceremony) has the cryptography, and this page covers what a trustee does.

## Who the trustees are

The election's creator names the trustee organisations by MSP ID and the threshold k when calling [`CreateElection`](/experimental/contract-api/#createelection). Trustees must be X.509 organisations in the channel. Their order in the list gives each its identifier, 1 to n.

Each trustee organisation acts through a trustee identity: an X.509 client identity of that organisation whose certificate carries the Fabric CA attribute `weft.trustee=true`, so not every member of the organisation can act for it. Register one for the purpose, as for an explorer.

## The trustee CLI

Trustees use `weft trustee`, planned as part of `@weftwallet/cli`. It connects to the organisation's own peer with `@hyperledger/fabric-gateway` and the trustee identity, as the explorer's indexer does, without a relay. It keeps the trustee's one-time ceremony key and key share in a state folder, encrypted with a passphrase it asks for.

Planned commands:

| Command | Does |
|---|---|
| `weft trustee status --election <id>` | Shows the election's state and each trustee's progress. |
| `weft trustee commit --election <id>` | Round 1: draws the polynomial and the one-time key, and posts the commitments, the proof of knowledge and the one-time public key. |
| `weft trustee share --election <id>` | Round 2: once every trustee has posted round 1, encrypts a share to each other trustee and posts them. |
| `weft trustee confirm --election <id>` | Round 3: once every trustee has posted round 2, decrypts and checks its shares, saves its key share, posts a proof that it holds it, and deletes the one-time key. Reports a bad share instead, if one fails. |
| `weft trustee decrypt --election <id>` | After the election closes: posts its decryption share of each total, with proofs. |
| `weft trustee destroy --election <id>` | After the tally is published: deletes its key share. |

Every command also takes the connection settings: the peer endpoint and its TLS CA certificate, the MSP ID, the trustee identity's certificate and key, the channel and the contract name, as the explorer does. The state folder defaults to one folder per election.

## The steps

1. The creator calls `CreateElection`. The election is in the `keygen` state.
2. Every trustee runs `commit`. The contract checks each proof of knowledge as it's posted.
3. Every trustee runs `share`. The contract checks only that each trustee sends one share to every other trustee, because it can't read them.
4. Every trustee runs `confirm`. The contract checks each proof that the trustee holds its share.
5. Anyone calls `OpenElection`. The contract computes the election key and verifying shares from the round 1 commitments, and the election opens. Weft and every explorer show the key's fingerprint.
6. After the closing time, anyone calls `CloseElection`, which adds up the ballots.
7. At least k trustees run `decrypt`. The contract checks each share's proofs.
8. Anyone calls `PublishTally`, which combines k shares and writes the counts.
9. Every trustee runs `destroy`.

Rounds 1 to 3 can't be run by one trustee alone: each waits for every trustee to finish the round before. `status` says who the ceremony is waiting for.

In the playground, `pnpm playground:up --experimental` runs all of this for Org1 and Org2, 2 of 2, on your machine.

## When something fails

| What happens | Result | What to do |
|---|---|---|
| A trustee's round 1 proof doesn't verify | The contract refuses that transaction. | Run `commit` again. |
| A trustee doesn't post a round | The election stays in `keygen`. Voting can't start. | Ask the trustee. The creator can call `CancelElection` and create a new election, under a new ID, without that trustee. |
| A trustee loses its one-time key before round 3 | It can't decrypt the shares sent to it. | `CancelElection`, and create a new election. |
| A received share doesn't match the sender's commitments | `confirm` posts a report naming the sender, and the election moves to `failed`. | Find out why with the sender, and create a new election. |
| A decryption share's proof doesn't verify | The contract refuses that transaction. | The trustee runs `decrypt` again with its own share. A share made with any other secret can't pass. |
| A trustee loses its key share after the election opens | If at least k trustees still hold theirs, the count goes ahead without it. | Nothing, as long as k remain. |
| Fewer than k trustees can or will decrypt | The totals can't be decrypted. The ballots stay on the ledger, encrypted. | There is no recovery: run the election again. |

Version 1 can't tell a trustee who sent a bad share from one who reports a good share as bad, so a report doesn't show which trustee is at fault. Either way the ceremony stops, which any trustee could already cause by not posting. Nothing about the key is learned, because the election never opens.

Key shares aren't re-shared or refreshed in version 1. A trustee that leaves the consortium during an election keeps its share until it destroys it.

## Keeping a share

A key share decrypts nothing alone. Any k shares together could decrypt any single ballot as well as the totals, at any time, and the ballots stay on the ledger permanently. To limit that:

- keep the state folder as you keep a CA's private key: on a machine only the trustee's operators use, with a passphrase they don't share;
- don't copy the folder into backups that outlive the election;
- run `destroy` once the tally is published. Deletion can't be proved to anyone else, so voters still rely on fewer than k trustees colluding, before and after.

## Choosing the threshold

Any k trustees together can read a ballot, and any n - k + 1 together can stop the count by withholding their shares. A higher k protects secrecy and makes the count easier to stop.

| Trustees n | Default k (a majority) | Trustees needed to read a ballot | Trustees needed to stop the count |
|---|---|---|---|
| 2 | 2 | 2 | 1 |
| 3 | 2 | 2 | 2 |
| 4 | 3 | 3 | 2 |
| 5 | 3 | 3 | 3 |
| 7 | 4 | 4 | 4 |

The default is a majority, `floor(n / 2) + 1`, set per election. Choose k = n only when every trustee is certain to be there for the count. Weft shows the trustees and the threshold in the approval window before each vote, so voters can see who they are trusting.
