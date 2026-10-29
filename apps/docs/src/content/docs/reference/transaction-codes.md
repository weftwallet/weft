---
title: Transaction codes
description: Fabric validation codes and endorsement errors, and how Weft explains them.
---

These are the messages Weft shows. The source is `packages/core/src/status.ts`; change them there.

## Validation codes

Returned after ordering, when the block is committed.

| Code | Weft says | Retry? |
|---|---|---|
| `VALID` | Committed | Not needed |
| `MVCC_READ_CONFLICT` | Someone else changed the same data first | Yes |
| `PHANTOM_READ_CONFLICT` | The data changed while this was in flight | Yes |
| `ENDORSEMENT_POLICY_FAILURE` | Not enough organisations approved it | Yes |
| `DUPLICATE_TXID` | This transaction was already submitted | No |
| `BAD_CREATOR_SIGNATURE` | The network did not accept your signature | No |
| `BAD_PROPOSAL_TXID` | The request was malformed | No |
| `EXPIRED_CHAINCODE`, `CHAINCODE_VERSION_CONFLICT` | The contract version changed | Yes |
| `INVALID_ENDORSER_TRANSACTION` | The approvals did not match | No |
| `ILLEGAL_WRITESET`, `INVALID_WRITESET` | The contract tried to write data it may not | No |
| anything else | The network rejected this transaction | No |

## Endorsement errors

Returned before ordering, as gRPC errors from peers. Weft matches the text:

| Weft code | Matches | Weft says |
|---|---|---|
| `ACCESS_DENIED` | "access denied", "creator org unknown", "failed evaluating policy" | Your identity is not allowed to do this |
| `UNAVAILABLE` | "no peers available", "unavailable", "failed to connect" | The network could not be reached |
| `CHAINCODE_NOT_FOUND` | "chaincode … not found" | That contract is not on this channel |
| `CERTIFICATE_EXPIRED` | "certificate … expired" | Your certificate has expired |
| `ENDORSE_FAILED` | anything else | The contract returned an error (with its message) |

## Weft's own

| Code | Meaning |
|---|---|
| `VERIFICATION_FAILED` | Weft refused to sign because the relay's message didn't match the approved request. |
| `INTERNAL` | An unexpected error inside Weft. |
