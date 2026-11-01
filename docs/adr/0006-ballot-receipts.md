# 0006: Keep ballot receipts in Weft, when the voter asks

**Status:** Accepted
**Date:** 2026-11-01

## Context

The ballot contract (ADR 0004, phase 4) puts a commitment on the ledger: SHA-256 of the election ID, the choice and a random salt. The choice and the salt are the voter's receipt. With them anyone can show which way the commitment voted; without them no one can tell. A voting web app, such as Weft Playground, shows the receipt once, and it is gone when the page closes.

Weft already holds the voter's identity, sees the private input the ballot travels in, and has an encrypted store. Keeping the receipt there is a natural place, as an opt-in for each vote.

The explorer's election page checks a receipt in the browser. Until now a voting app could link to it with the choice and salt in the address's fragment. The browser never sends a fragment to the server, but it does record the whole address in its history.

Constraints:

- Activity is stored without encryption and keeps private input names only (ADR 0005 encrypts keys, not activity).
- The vault key is imported for `wrapKey` and `unwrapKey` only.
- The worker can be stopped, and Weft can lock, while a vote waits for its block.
- An extension's popup closes as soon as another page takes focus.

## Decision

**The receipt travels with the vote.** A voting app adds `receipt` to `weft_submit`: type, version, channel, election ID, choice and salt. Weft checks it against the call before any window opens: the channel is the call's, the election ID is one of its arguments, the salt is 32 to 128 lowercase hex characters, and one private input, read as JSON, has exactly this choice and salt. Anything else, including a field Weft doesn't keep, fails with `-32602` naming what to fix. A separate `weft_keepReceipt` after the commit was rejected: two windows, no way to check the choice is the one signed, and the vault could be locked by then.

**Weft can choose the salt.** With `salt: "generate"` in the receipt and in exactly one private input's JSON (with the same choice), Weft draws 16 random bytes, as 32 hex characters, and writes them into both before the approval window opens. The voter approves, and Weft signs, the value the contract gets; the proposal check (ADR 0001) compares the signed bytes with that filled-in call. The voting app gets the salt back in the receipt.

**The voter decides, every time.** The approval window shows "Keep the receipt in Weft" under the arguments, off. Only the voter can turn it on: the request can't, and Weft remembers nothing between requests. Turned off, the vote is as before.

**What the app gets.** `result.receipt` is `{ kept, reason?, receipt }`: the finished receipt (Weft adds the transaction ID, the block and its own commitment) whether or not Weft kept it, and why not (`declined`, `storage` or `mismatch`). No method reads a kept receipt back.

**Sealed at signing.** When the voter presses Sign and submit, Weft encrypts `{ option, salt }` with AES-GCM under a receipt key derived from the vault key with HKDF-SHA-256 (info `weft receipts v1`), non-extractable, cached beside the vault key and cleared on lock. The activity record's ID is the additional data, so a sealed value can't be moved onto another receipt. Writing it after the commit needs no key, so a lock while waiting loses nothing. A password change leaves receipts as they are, because the vault key doesn't change.

**After the commit**, Weft computes the commitment itself and compares it with the one the contract returned. If they differ, it keeps nothing (`mismatch`): a receipt with it wouldn't check out. Otherwise it writes the receipt and flags the activity record in one transaction. If the browser refuses the write (`storage`), the approval window stays open with Download receipt and Copy receipt, from the copy the worker gave that window.

**Kept until removed.** Receipts have no expiry. They go when the voter removes one, removes its identity (the sheet says how many), or resets Weft. The activity list shows every transaction with a kept receipt beyond its 50 most recent.

**Checking in the explorer, without the address.** The page holding the receipt opens the election page with `window.open` (not `noopener`), its address carrying only the transaction ID and the commitment. The election page posts a "ready" message, with no data, to its opener; the opener answers with the choice and salt, posted to the explorer's exact origin. The explorer accepts an answer only from Weft Playground where the products are, from origins its operator lists (`WEFT_EXPLORER_RECEIPT_ORIGINS`), and from browser extensions' pages, and only shaped as this page's receipt. Any extension is accepted because an extension's origin can't be known in advance (Firefox gives each installation a random one) and an extension able to run on the page could script it anyway; an answer only fills the local check, which can't make a wrong receipt check out and sends nothing back. Weft does this from a small window of its own, since the popup would close before the explorer could ask. The election page no longer reads a choice or salt from its address, and drops one an old link carries.

## Consequences

- Receipts are part of Weft 0.1.0, the first release. Weft lists `"receipts"` in `window.weft.features`, so a page checks for a feature rather than comparing versions.
- The voting app learns whether the voter kept the receipt in Weft, and why not: one bit about a choice made in Weft, which it needs to word its notice.
- The relay never sees `receipt`; it saw the private input already, as the endorsing peers do.
- Copy receipt puts the salt on the clipboard, where clipboard history may keep it, and Download receipt writes a plain file. Both say what they did.
- While both are open, the explorer's page can navigate the page that opened it, as any opened page can. The opener is the network's own explorer, named in its invite, and Weft's window closes once it has answered.
