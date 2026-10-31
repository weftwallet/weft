---
title: When a transaction fails
description: What Weft's failure messages mean and what to do next.
---

Fabric reports failures with codes written for peer operators. Weft translates them, keeps the original code for support, and records the failure in your activity.

Open the failed item in **Activity** to see:

- a plain-English headline and what to do,
- for endorsement failures, each organisation's peer and what it said,
- the original Fabric code, for example `ENDORSEMENT_POLICY_FAILURE`,
- the transaction ID, which you can copy for your administrator.

## Common cases

### Someone else changed the same data first

Fabric's code for this is `MVCC_READ_CONFLICT`. Another transaction updated a value this one read, between endorsement and commit. Nothing was written. Trying again usually works.

### Not enough organisations endorsed it

Fabric's code for this is `ENDORSEMENT_POLICY_FAILURE`. The contract's policy needs endorsements from more organisations than signed. A peer may be offline, or an organisation may have rejected the request. Try again later, or ask your administrator which organisation is missing.

### Your identity is not allowed to do this

The channel's access policy rejected this identity. Check you are using the right organisation and role.

### The network could not be reached

No peer answered in time. The network may be down or the relay misconfigured. Try again shortly.

### Weft refused to sign

What the relay sent back didn't match the request you approved, so Weft didn't sign it. The relay may be misconfigured or compromised. Tell your administrator.

The full list is in [Transaction codes](/reference/transaction-codes/).
