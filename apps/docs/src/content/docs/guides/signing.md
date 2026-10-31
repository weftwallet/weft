---
title: Reading a signature request
description: What each part of Weft's approval window means, and what to check before you sign.
---

When a web app asks Weft to sign, Weft opens an approval window. This page explains each part of it.

## Reads and writes

The coloured banner at the top shows whether the request reads or writes.

- A teal `EVALUATE` banner is a read. It asks one peer to run the function and return the result. Nothing is written to the ledger and nothing is shared with other organisations' ledgers. The button says **Sign and read**.
- An amber `SUBMIT` banner is a write. The request goes to the organisations the contract's endorsement policy requires; if they endorse it, it is ordered into a block and committed. Once committed it cannot be undone. The button says **Sign and submit**.

## The details

| Field | What to check |
|---|---|
| Web app | The address of the web app asking. Make sure it's the one you expect. |
| Signing as | Which of your identities will sign. Switch identities from the home screen before approving if needed. |
| Channel | Which shared ledger this uses. |
| Contract | The chaincode, and the contract inside it when the chaincode has several. |
| Function | What the contract will do, for example `TransferAsset`. |
| Arguments | The inputs, in order, decoded into text. |
| Private | Private (transient) inputs. They pass through your organisation's relay to the peers that run the contract, and never reach the ledger. Their values start hidden from anyone glancing at your screen; **Show** reveals them, since you're signing them too. |

Choose **View raw request** to see the same information as JSON, for attaching to a problem report. It includes private values only while they're shown.

## What Weft checks for you

The relay builds the actual Fabric messages. Before signing each one, Weft decodes it and confirms the channel, contract, function, every argument, every private input and your certificate match what you approved. If anything differs, Weft refuses to sign and records why. See the [security model](/reference/security/).

## After you approve

For a submit, Weft signs three times in a row: the proposal, the endorsed transaction, and the request for its commit status. You only approve once. The window shows **Committed** when the block is written, or an explanation if it fails: see [When a transaction fails](/guides/failures/).

Weft's activity list keeps the names of private inputs but not their values.

Closing the window counts as **Reject**.
