# Security policy

Weft holds signing keys for permissioned networks, so we take reports seriously.

## Reporting

Please **do not** open a public issue. Instead, either:

- use **[Report a vulnerability](https://github.com/ifeanyi-ugwu/weft/security/advisories/new)** on GitHub (preferred), or
- email **security@ifeanyiugwu.dev**

with:

- what you found and its impact,
- steps to reproduce,
- the affected version or commit.

You'll get an acknowledgement within 3 working days. We'll agree a disclosure date with you and credit you unless you'd rather not be named.

## Scope

In scope: the extension (`apps/extension`), the relay (`apps/relay`), and the packages under `packages/`. Of particular interest:

- ways to read or export private keys,
- ways to get a signature over anything other than what the approval window showed,
- ways for a page to impersonate another origin or reach a connected site's data.

Known gaps are listed under "Not covered yet" in the [security model](apps/docs/src/content/docs/reference/security.md); reports that go beyond them are still welcome.
