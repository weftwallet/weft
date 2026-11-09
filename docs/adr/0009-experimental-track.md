# 0009: Build experiments on main, behind a build switch

Accepted on 1 November 2026. Decided by Ifeanyi Ugwu.

## Context and problem

ADR 0007 (a private tally) and ADR 0008 (Idemix voter credentials) add cryptography that nobody outside the project has reviewed, a 13 MB WebAssembly module, a new provider method and a new contract. Both features have to run against a Fabric network, from enrolment and casting through the count and the explorer's check, so the review covers working code. Neither can reach people who install Weft.

Both features depend on parts that the main product also uses: the protobuf decoder, `verifyProposal`, receipts, the relay and the explorer.

## Decision drivers

- The size, the permissions and the code a reviewer reads of the extension people install stay the same.
- Experimental code runs against the current main, including its tests.
- No user can be asked to turn the experiments on in their installed Weft.

## Considered options

1. A build switch on main, `WEFT_EXPERIMENTAL=1`, that produces a separate extension (chosen).
2. A long-lived branch. Changes to the parts both builds share would have to be merged into the branch again and again, and the experiments would be tested only against an old main.
3. A runtime switch in normal Weft, such as a setting. The WebAssembly module, its content security policy and the unreviewed cryptography would then ship to every user, and a site could ask users to turn the setting on.
4. A separate repository. It has the branch's problems, with more work to share packages.

## Decision

Experimental features are built on main and included only when the extension is built with `WEFT_EXPERIMENTAL=1`. The repository stays one codebase, main's tests also run the code the experiments rely on, and the difference between the builds is a list of files and one constant.

### Weft Experimental, a separate build

The build with the switch is a separate product, Weft Experimental:

- It has its own name, extension ID (in Firefox, its own add-on ID), icon and storage. It installs alongside normal Weft and shares no identities, keys, receipts or settings with it.
- Only it carries the idemix WebAssembly module, the content security policy that allows WebAssembly, and `weft_castBallot`. The normal build leaves this code out at build time, and its size, its permissions and the code a reviewer reads don't change.
- It reports the same `version` as normal Weft, 0.1.0. Pages detect what it can do from `window.weft.features`: normal Weft lists `["receipts"]`, and Weft Experimental adds `"castBallot"` (ADR 0007) and `"voterCredentials"` (ADR 0008).
- It is built from source and isn't offered in browser stores while it is experimental.

Both builds define `window.weft`, and the first to load on a page provides it, as normal Weft already does when another provider exists. To use Weft Experimental on a site, a tester uses a browser profile with only Weft Experimental installed, or removes normal Weft's access to the site in the browser's extension settings.

### The rest of the switch

- `pnpm playground:up --experimental` starts everything `playground:up` does, plus a channel for each election, with the election's idemix organisation when its voters have credentials, and `examples/private-ballot-contract`, with a key ceremony already run and seeded elections.
- Weft Playground shows a "Private election" section only when `window.weft.features` includes `"castBallot"`.
- The relay accepts idemix signers, and the explorer shows private elections, only when each is started with `WEFT_EXPERIMENTAL=1`.
- The docs site has an Experimental section. Every page in it starts by saying it is experimental, not externally reviewed, and not part of the main product.

### Leaving the experimental track

A feature leaves the track only after an external cryptographic review of what it adds and a maintainer's sign-off. It then gets a new record that amends or supersedes the main product's records it changes, its code moves into the normal build, and its docs move into the main sections. Its entry in `features` stays, so pages written for the experimental build keep working.

A feature can also be removed from the track without a deprecation period, because nothing in the main product depends on it.

### Records for experiments

An experimental record says in its status that it is experimental and applies only to the experimental build, network and contract. It doesn't amend or supersede a main-product record while the feature is experimental. Where it touches a main-product record, it says that record remains the decision for the main product, and the main-product record gets at most a "See also" line pointing to it.

## Consequences

- Main holds code that most users never run, which reviewers and tests must treat as part of the repository.
- Both builds are built and tested. CI is planned to build each.
- A tester of Weft Experimental enrols separately in it, because its identities are its own.
- Both extensions run in every page. Each announces its own provider and talks to it on its own channel (ADR 0010), so a page can choose between them, and `window.weft` stays with the first to load.
- The docs describe features that aren't in Weft. Every Experimental page carries the same notice, and the main pages make no claim that depends on them.

## More information

- [Experimental features](../../apps/docs/src/content/docs/experimental/overview.md) explains how to build and run Weft Experimental.
- See also [0010](0010-provider-announcement.md), which lets a page reach both builds when both are installed.
