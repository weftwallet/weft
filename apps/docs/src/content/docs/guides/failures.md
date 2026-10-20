---
title: When a transaction fails
description: What Weft's failure messages mean and what to do next.
---

Fabric reports failures with codes written for peer operators. Weft translates them, keeps the original code for support, and records the failure in your activity.

Open the failed item in **Activity** to see:

- a plain-English headline and what to do,
- for endorsement failures, each organisation's peer and what it said,
- the original Fabric code, e.g. `ENDORSEMENT_POLICY_FAILURE`,
- the transaction ID, which you can copy for your administrator.

## Common cases

**Someone else changed the same data first** (`MVCC_READ_CONFLICT`). Two transactions changed the same record at the same time and the other was committed first. Nothing was written. A retry usually succeeds.

**Not enough organisations approved it** (`ENDORSEMENT_POLICY_FAILURE`). The contract needs approval from more organisations than responded. Usually a peer is down. Try again later, or ask the administrator which organisation is missing.

**Your identity is not allowed to do this.** The channel's access policy rejected your identity. Check you're using the right identity and role.

**The network could not be reached.** No peer answered through the relay. The network may be down, or the relay misconfigured.

**Weft refused to sign.** The relay returned something different from what you approved. This should never happen with a correctly configured relay; tell your administrator, because it may indicate a compromised relay.

The full list is in [Transaction codes](/reference/transaction-codes/).
