---
title: Voter credentials
description: "Idemix voter credentials in Weft Experimental: the voters' CA, which credentials can vote, enrolment from an invite, the per-election pseudonym, what Weft stores, the relay and the explorer."
---

:::caution[Experimental]
This page describes Weft Experimental, a separate build that is not part of the main product, and nothing on it applies to Weft as you install it. No one outside the project has reviewed its cryptography. The contract, the idemix module, the relay's part, the playground's voters' CAs, and enrolment and anonymous ballots in Weft Experimental are built; the explorer doesn't read anonymous ballots yet. [What is built](#what-is-built) has the details.
:::

A voter credential is an Idemix credential from an election's own idemix CA. Weft Experimental holds it and uses it for one thing: casting ballots with [`weft_castBallot`](/experimental/cast-ballot/) in that election. A ballot signed with it names the voter organisation, an affiliation every voter shares and a role, and not the voter. ([ADR 0008](/reference/decisions/))

A voter credential is never Weft's active identity. Weft lists it under Identities in a group of its own, named by the election's title, and never offers it in Home's identity picker or to `weft_connect`, `weft_identity`, `weft_signIn`, `weft_submit` or `weft_evaluate`. A site can't reach it, and only `weft_castBallot` uses it, for the election it was issued for. With only voter credentials, Weft has no identity for sites: Home says so, and `weft_connect` fails with `4300`. A voter credential has no expiry, so the certificate watch skips it.

## What is built

- The contract's `CreateElection` with voter credentials and `CastAnonymousBallot`, with the pseudonym proof ([Contract API](/experimental/contract-api/#what-is-built)).
- The idemix module in `packages/idemix`, built to WebAssembly from Go source, with its hash pinned. Weft Experimental carries it and runs it in a dedicated worker of the page that needs it; Node tests and the playground's test drivers run it too.
- The relay: idemix signers, a gateway for each of their requests, no request logs for them, and voter invites ([The relay](#the-relay)).
- `@weftwallet/core`'s proposal check compares an idemix creator with the identity Weft made, byte for byte, and its `parseVoterInvite` checks a voter invite for the relay and for Weft Experimental alike.
- Normal Weft's message for a voter invite ([The voter invite](#the-voter-invite)).
- In Weft Experimental: Join from an invite for a voter invite, enrolment in the order [Enrolment](#enrolment) gives with each of its failures, the sealed record ([What Weft stores](#what-weft-stores)), the credentials' own group in Identities with each credential's detail and Remove credential, Home with only voter credentials, and anonymous ballots with `weft_castBallot`: the read checked against the invite's CA chains ([Reading the election](#reading-the-election)), the window's anonymous screens and failures, the pseudonym proof, and the sealed activity and receipt ([Casting a ballot](/experimental/cast-ballot/#what-is-built)). `window.weft.features` lists `"voterCredentials"`.
- The playground: a voters' CA and a voters-only CA proxy for each election with voter credentials, `chair-2027` seeded open with its issuer key pinned, its voter invite served by the relay, and the credential count on every `playground:up` and `playground:count`, and on demand with `playground:credentials` ([For the organisers](#for-the-organisers-the-voters-ca)).

Not built yet: the explorer's reading of idemix organisations and anonymous ballots, and the playground's section for voter credentials.

In headless Chromium on the native network the earlier steps' tests ran on, Weft Experimental enrolled through the CA proxy, read an election with voter credentials through the relay with the peer signature check, and cast anonymous ballots that the contract accepted and the tally counted; a second ballot from one credential was refused with the credential row. Before that, voters enrolled through the CA proxy with the module, read the election and cast anonymous ballots through the relay with `@weftwallet/core`'s flows, the relay wrote no log line for any of their requests, a second ballot from one credential was refused, and the count was right. A voter who took an X.509 certificate at the CA's own port got two credentials through token authorisation and voted twice; `playground:credentials` named that voter, and `playground:count` refused to close the election until given `--accept-extra-credentials`.

## For the organisers: the voters' CA

Each election gets its own issuer key, because Fabric's idemix has no revocation and its credentials don't expire. A leaked credential under a standing issuer key could vote in every later election.

1. Run a Fabric CA server for the election, with its own CA name, for example `ca-chair-2027`. Its `fabric-ca-server init` writes the idemix `IssuerPublicKey` and `IssuerRevocationPublicKey`. Each election has its own CA server, as in the playground.
2. Create a channel for the election, for example `privatevote-chair-2027`, with the trustee organisations and one idemix organisation: an MSP of type idemix, for example `ChairVoters2027MSP`, whose MSP folder holds those two keys. Fabric recommends one idemix MSP per channel, because the MSP ID tells idemix organisations apart. A channel per election also keeps elections apart: one election's voters can't read another's ballots, and closing one election changes no other channel.
3. Add an affiliation for the voters, for example `voters`, and register every voter in it, as a client with `maxenrollments 1` and no `role` attribute:

   ```sh
   fabric-ca-client affiliation add voters
   fabric-ca-client register --caname ca-chair-2027 \
     --id.name voter1 --id.secret <secret> --id.type client \
     --id.affiliation voters --id.maxenrollments 1
   ```

   The affiliation is disclosed in every transaction, so a unique one would name the voter. Register nothing but voters in it: the contract accepts a credential with that affiliation from any identity the CA registered there.
4. Let voters reach the CA only through a proxy that passes `GET /api/v1/cainfo` and `POST /api/v1/idemix/credential` with basic authorisation, and refuses every other request, including token authorisation and `/api/v1/enroll`. Keep the CA's own address for the organisers' registrations. Fabric CA's idemix endpoint also accepts a token signed with an X.509 enrolment certificate, and that route isn't counted against `maxenrollments`: in the prototype, a voter with an X.509 certificate got three credentials and voted three times. The proxy keeps every voter ID from getting an X.509 certificate or using that route. It also serves HTTPS with a certificate browsers trust, which Fabric CA's own TLS certificate isn't.
5. Create the election with `voters.kind` `idemix`, naming the MSP, the affiliation and the role `member`, and pinning the issuer public key and its SHA-256 ([`CreateElection`](/experimental/contract-api/#createelection)). `weft-trustee create --voter-credentials ChairVoters2027MSP --issuer-key <file>` reads the key file and works out the hash and the curve.
6. Publish a [voter invite](#the-voter-invite), and give each voter their enrolment ID and secret.
7. Count the credentials issued per enrolment ID, in the CA's `credentials` table, while voters enrol and again before the trustees close the election. Each voter must have at most one. Voters enrol while the election is open, so a count made before it opens finds none. An ID with more than one can vote more than once, and credentials can't be revoked: cancel the election if it is still in `keygen`, and otherwise tell the voters and run a new election under a new issuer key.

The CA operator decides who is a voter and can register IDs that no person holds. Nothing on the ledger shows that, so the voter roll is a matter for the organisers, as it is for any election.

The playground follows these steps for each voters' CA. Each election's entry in its list names a port for the CA's proxy, `ca.proxy`, 7081 for `chair-2027`, and `pnpm playground:up --experimental` runs `ca-proxy.mjs --voters-only` there, in front of the CA: plain HTTP on `localhost`, or HTTPS with a mkcert certificate under `--https`. The proxy passes `GET /api/v1/cainfo`, and `POST /api/v1/idemix/credential` with basic authorisation, and answers every other request with `403` and Fabric CA's error shape: "Refused POST /api/v1/enroll: this proxy for a voters' CA passes only GET /api/v1/cainfo, and POST /api/v1/idemix/credential with basic authorisation." It checks the path after resolving `.` and `..` and forwards that path, so no other spelling of a path reaches the CA, and it answers a browser's preflight only for the two requests it passes.

`pnpm playground:credentials <election>` reads the CA's `credentials` and `users` tables, read-only, and prints how many credentials each ID registered in the voters' affiliation holds, and any credentials of IDs outside it. It exits with status 1 when an ID in the affiliation holds more than one. `pnpm playground:up --experimental` prints the count for each election with voter credentials, and `pnpm playground:count` checks it before closing an open election and refuses to close one in which an ID holds more than one, unless given `--accept-extra-credentials`. The CA's own port stays open on the machine for the playground's registrations, so a tester can reach it directly, and the count is what finds a credential obtained that way.

## Which credentials can vote

An idemix organisation in the channel accepts every credential from its issuer key, whatever its organisational unit and role. Fabric CA issues credentials to more identities than the voters. With Fabric CA's default configuration, its bootstrap admin can enrol for idemix credentials as often as it likes, with the root affiliation, which is an empty organisational unit, and the role member. Any identity a registrar creates gets credentials with that identity's affiliation, and with the admin role if the registrar gives it the attribute `role=2`. With token authorisation, any holder of an X.509 certificate from the CA gets as many credentials as it asks for, with its own affiliation and role.

`CastAnonymousBallot` therefore accepts a ballot only when:

- the creator's MSP ID is the election's voter MSP;
- the creator is an idemix identity, not an X.509 one;
- the creator's organisational unit is the affiliation the election names, and its role is member. The peer's idemix MSP has already checked that the credential behind the transaction's Nym carries both, so a creator can't claim them.

These refuse the bootstrap admin's credentials, the credentials of every identity outside the voters' affiliation, and every admin credential, whichever route issued them. They can't tell two credentials of one voter ID apart, or a voter from an ID a registrar added to the affiliation. Steps 3, 4 and 7 above cover the first, and the CA operator is trusted with the voter roll for the second.

## The voter invite

A voter invite is a JSON document, served over HTTPS and shared as a link, like an [organisation's invite](/operators/invites/). The election's relay serves it, at `/.well-known/weft-voter-invite/<election>.json`.

```json
{
  "weftVoterInvite": 1,
  "network": "Weft Playground",
  "organization": "Chair 2027 voters",
  "mspId": "ChairVoters2027MSP",
  "affiliation": "voters",
  "caUrl": "https://ca.voters.example.org",
  "caName": "ca-chair-2027",
  "relayUrl": "https://relay.election.example.org",
  "relayOperator": "Example Election Services",
  "channel": "privatevote-chair-2027",
  "chaincode": "private-ballot",
  "electionId": "chair-2027",
  "issuerKeyHash": "<64 hex characters>",
  "curve": "FP256BN_AMCL",
  "endorsers": [
    { "mspId": "Org1MSP", "caChain": "-----BEGIN CERTIFICATE-----\n…" },
    { "mspId": "Org2MSP", "caChain": "-----BEGIN CERTIFICATE-----\n…" }
  ],
  "explorerUrl": "https://explorer.org1.example.org"
}
```

- `issuerKeyHash` is SHA-256 of the `IssuerPublicKey` bytes the CA serves, the same value the election pins.
- `affiliation` is the affiliation every voter's credential carries, which the election pins too.
- `relayUrl` is the election's relay, which may differ from the organisations' own (see [The relay](#the-relay)), and `relayOperator` is the name of whoever runs it, which the invite's review and Weft's approval window show.
- `endorsers` lists each trustee organisation's MSP ID and CA chain, in PEM, which Weft checks the election's peer signatures against (see [Reading the election](#reading-the-election)).

A voter invite has no `weft` field. Normal Weft recognises `weftVoterInvite` before any other check, and says "This is a voter invite for an election, and only Weft Experimental can hold voter credentials. Nothing was sent to the CA. Open the invite in Weft Experimental." It never enrols from it, so a voter can't spend their one enrolment on an X.509 certificate by accident, and isn't sent to ask the organisers for a new invite that would fail the same way.

The relay checks each voter invite when it starts, and Weft Experimental checks the one a voter opens, with the same rules (`parseVoterInvite` in `@weftwallet/core`): every field above, `curve` `FP256BN_AMCL`, at least one endorser with a PEM chain, a file named for its election, and an MSP in `WEFT_IDEMIX_MSP_IDS`, since an invite for another MSP would send voters to a relay that refuses their ballots; the relay alone checks the last two. Weft Experimental says "This voter invite has mistakes in it, so Weft Experimental can't use it. Ask the election's organisers for a new one." for one that fails, with the problem under Details. A site can't hand Weft a voter invite with `weft_addNetwork`: the window says to open it from Join from an invite. The playground writes `chair-2027`'s invite to `playground/.state/voter-invites/chair-2027.json`, with the CA proxy's URL, Org1's relay, `relayOperator` "Weft Playground", SHA-256 of the CA's `IssuerPublicKey`, and Org1MSP's and Org2MSP's CA certificates as the endorsers, and the relay serves it at `http://localhost:8787/.well-known/weft-voter-invite/chair-2027.json`.

Weft trusts the voter invite for the issuer key, the relay, its operator and the endorsers' CA chains, as it trusts an organisation's invite for its CA and relay. A forged invite could name another network entirely, and the voter's check against it is the [election fingerprint](/experimental/private-tally-spec/#the-election-fingerprint), which every explorer shows.

## Enrolment

When the voter opens a voter invite from Join from an invite, Weft Experimental shows what they are joining: the election, the network, the voter organisation, the channel, the voters' CA, the relay and who runs it, the issuer key, and that the credential can't be revoked. It asks for the enrolment ID and secret, and when the voter presses Get a voter credential (`lib/voter/enrol.ts`), the line above the button says which step is running, and Weft:

1. Checks that it holds no voter credential for this election. If it does, it stops: "Weft already holds a voter credential for chair-2027. It keeps one per election, and nothing was sent to the voters' CA."
2. Asks for host access to the voters' CA and the election's relay, once, as for any CA.
3. Reads the CA's `/api/v1/cainfo` and compares SHA-256 of its issuer public key with `issuerKeyHash`. If they differ, it stops: "The voters' CA has a different issuer key from the invite's. Ask the election's organisers. Weft asked the CA only for its public details, and enrolled nothing." A CA that doesn't answer within 15 seconds gets "Weft couldn't reach the voters' CA at localhost:7081, so nothing was enrolled. Check that it's running, then press Get a voter credential again."
4. Starts the idemix module in a dedicated worker of the popup, loads the issuer key, and derives the key it seals with, which needs Weft unlocked. If the module doesn't start, it stops: "Weft Experimental couldn't start its voting module, so nothing was sent to the voters' CA. Reload Weft Experimental from the browser's extensions page and try again."
5. Sends a request to `/api/v1/idemix/credential` with the enrolment ID and secret, and gets a nonce. The module draws a secret key and builds the credential request, bound to the nonce, and Weft sends it to the same endpoint, again with the enrolment ID and secret. The CA answers with the credential and the credential revocation information, and counts the one enrolment. A CA that refuses the ID and secret gets "The voters' CA refused this enrolment ID and secret. It accepts each one once, so if you enrolled before, in this browser or another, that credential is the only one. If you didn't, ask the election's organisers."
6. Checks the credential with the module against the issuer key, and its attributes: the invite's affiliation, the role member and the enrolment ID. If it doesn't check out, Weft keeps nothing and says: "The voters' CA sent a credential that doesn't check out against its own issuer key, so Weft didn't save it. The CA has counted your one enrolment, so ask the organisers to register you again."
7. Seals the credential's secrets, has the background worker save the voter credential with the invite, the issuer key and the revocation key, and terminates the worker. If the browser refuses the write, the popup keeps the sealed credential and offers Save the credential, since the CA has counted the enrolment.

Each failure says what happened in the window, with the CA's or the module's own words under Details. Nothing secret is sent before step 5, so a CA with another issuer key, or a module that won't start, leaves the voter's one enrolment unused. Step 6 can't come earlier, because the credential is what the CA's answer carries, and by then the CA has counted the enrolment.

Weft never asks the CA for an X.509 certificate for that ID, and never uses token authorisation. A second enrolment with the same secret fails at the CA ("Authentication failure"), as `maxenrollments 1` requires.

The new credential arrives in Identities, in a group of its own under the networks, named by the election. The voter invite has no title, so the row and the detail show the election's ID until Weft has read the election once, and its title after. The detail says what Weft keeps, what each ballot shows, the enrolment ID (opened in the popup, while Weft is unlocked, only to show it), the issuer key and curve, that sites never see it, and "None. Fabric can't revoke this credential and it has no expiry date." under Revocation.

## What Weft stores

| Field | Stored |
|---|---|
| MSP ID, curve, issuer public key, revocation public key | Readable |
| Affiliation and role | Readable. Every voter of the election has the same. |
| Channel, contract, election ID and title, relay, relay operator and endorsers' CA chains, from the invite | Readable |
| Secret key, credential, enrolment ID, credential revocation information and revocation handle | Sealed with AES-GCM, under a key derived from the vault key with HKDF-SHA-256 (info `weft voter credentials v1`), with the record's ID and the field's name as additional data |
| The election's title, once Weft has read it | Readable. Every voter of the election sees the same. |
| An anonymous ballot's whole activity record: its time, site, transaction ID, block, arguments, pseudonym and the credential it came from, and its receipt with the voter's note of the choice | Sealed the same way, with only the record's ID readable, and shown only while Weft is unlocked |

The enrolment ID and the activity are sealed because, readable side by side, they would tie the voter to the ballot's transaction for anyone who can read the browser's files, such as the administrator of an organisation's managed device.

The secret key is a scalar used inside WebAssembly, so it can't be a non-extractable `CryptoKey` like Weft's other keys. The page that needs it, the popup to enrol and the approval window to vote, seals or opens it itself while Weft is unlocked, reading the vault key from the browser's session storage as the background worker does, and passes it only to its own idemix worker, which it terminates when the page is done. The secret key never passes through the background worker. The module zeroes its own copies of the key once each transaction's identity is disposed of, but Go may copy it while computing and doesn't guarantee to wipe those copies. Ending the worker frees every one.

Removing a voter credential deletes it, and with `maxenrollments 1` the voter can't enrol again for that election. Weft says so before removing it.

## Signing

Weft signs with IBM's idemix library, the one Fabric's idemix MSP uses, compiled from Go to WebAssembly. About 300 lines of Go around the library build the CA credential request, check the credential, make a fresh identity, make the Nym signature and make the per-election pseudonym. Only Weft Experimental carries the module, 13.0 MB or 3.0 MB gzipped, and it loads only when a voter credential is used.

The module runs in a dedicated worker that the page needing it starts, the popup to enrol and the approval window to read the election and vote, and terminates when it is done. Weft's background worker never runs it: Chrome's extension service worker can't start a worker, can stop during the module's start, and would keep the secret key in memory between votes. The background worker still makes the relay calls and checks every message. The approval window connects a port to it, and over that port the background worker asks for five things only: a new identity, a signature by an identity's handle, the pseudonym, the pseudonym proof, and disposing of an identity (`lib/voter/remote.ts`). The window disposes of every identity it made when the port closes. Starting the module takes about 0.4 s in Chromium, measured below.

- Weft makes a new idemix identity, with a new pseudonym (Nym) and proof, for every transaction, so two transactions from one credential can't be linked through the creator field. That took 171 to 254 ms in the prototype.
- It signs the inner message bytes, the same bytes it signs with ECDSA for an X.509 identity: the proposal, the transaction and the commit status request, 5 to 13 ms each. It never signs fabric-gateway's wrapper bytes, which the peer refuses.
- Weft's proposal check compares the transaction's creator byte for byte with the identity Weft made for that request.
- Weft Experimental's extension pages have `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';` as their content security policy. Chrome's Manifest V3 default disables WebAssembly, and Firefox needs the same policy. Normal Weft's manifest doesn't have it, and its build has no module.
- The module is built from Go source in `packages/idemix`, with a pinned Go toolchain and pinned modules, and only its SHA-256 is committed. The build refuses a module with another hash, and building it twice gives the same bytes. Weft Experimental's build copies it and `wasm_exec.js` to `/idemix/`, building them first when `packages/idemix/dist/wasm` has none, and the worker refuses either if its hash isn't the pinned one.

Measured in Weft Experimental in headless Chromium 141 on the native network, on a 2.1 GHz Intel Xeon with two cores, on 8 November 2026 ([Prototype results](/experimental/prototype-results/#in-weft-experimental) has the table): starting the module in a worker took 350 to 449 ms, enrolment from the press to the saved credential 718 to 847 ms, the approval window's module was ready 451 to 538 ms after the window asked for it, the read took 511 to 631 ms, and a vote from Sign and vote to the committed block 2.8 to 3.1 s, most of it the network's wait for the block.

## Reading the election

A voter credential's organisation has no peers, so the check that a peer of the voter's own organisation signed the election ([Reading the election](/experimental/cast-ballot/#reading-the-election)) has no meaning for it. Weft reads `GetElection` through the invite's relay, signed by a one-off identity made from the credential, and accepts the answer only when:

- its proposal hash is the hash of the proposal Weft signed, it comes from the contract the site named, and its status is 200, as for any read;
- it carries at least one endorsement, and every endorsement comes from an MSP that the invite's `endorsers` lists, with a certificate that has the `peer` role, chains to that MSP's CA chain in the invite and is in date, and a signature over the proposal response and the endorser that verifies.

Otherwise the request fails with `4400`, and the window says "Weft won't trust what it read" and names the organisations the invite lists. Once it verifies, the window's Through row says which organisations' signatures Weft checked (`checkAnswer` in `lib/ballot/read.ts`). The invite is already the source Weft trusts for the election's issuer key, so pinning the endorsers' CA chains in it adds no party to trust.

## The per-election pseudonym

The transaction's Nym changes every time, so on its own it can't stop a second vote. Weft adds a pseudonym that is the same for one credential within one election, and unrelated across elections:

```text
B   = H1("weft-scope v1", [channel, electionId])     hashed to a point of G1
P   = sk·B                                           the per-election pseudonym
Nym = sk·HSk + rNym·HRand                            the transaction's pseudonym, from its creator
proof (P, c, ssk, sr): P and Nym have the same sk, bound to the ballot's tracking code
```

The [specification](/experimental/private-tally-spec/#the-per-election-pseudonym) defines the bytes, the checks and the security argument. `pseudonymJson` carries `pseudonym`, `c`, `ssk` and `sr` in lowercase hex, 160 bytes in all.

The proof shows the sk behind P is the sk inside the transaction's Nym, which the peer has already checked against the channel's issuer key. It is bound to that Nym and to the ballot, so another voter can't reuse it, and a replay was refused in the prototype. Pseudonyms in different elections can't be linked, under the decisional Diffie-Hellman assumption in G1. The enrolment ID isn't used as the input, because the CA and anyone with the voter list know it.

The voter tag that binds the ballot's proofs is made from P (see the [specification](/experimental/private-tally-spec/#the-voter-tag)), and the contract marks the tag as voted. Weft's approval window, its transaction detail and explorers show that tag as the ballot's Pseudonym, shortened to its first and last 8 hex characters as a tracking code is, so the voter can find their ballot. This proof is Weft's own cryptography, about 150 lines of Go in the contract's `pseudonym` package, which the WebAssembly module compiles too, and needs an external review.

## The relay

The relay accepts an idemix signer, `{ "mspId": "ChairVoters2027MSP", "idemixIdentity": "<base64>" }`, and passes it to fabric-gateway as credentials. It caches no gateway for it: each request gets a new one, closed after the commit status. It still holds no secret, and builds and forwards messages exactly as for an X.509 signer.

It accepts idemix signers only when started with `WEFT_EXPERIMENTAL=1`, and only from the MSP IDs in `WEFT_IDEMIX_MSP_IDS`. It refuses an idemix signer without the switch, from another MSP, with an identity that isn't base64, or beside a certificate, and an X.509 signer that names a voter MSP. None of its messages repeats the identity.

It logs nothing for a request that carries an idemix signer: no request line, no network address, no URL, no body and no error. Fastify, which the relay runs on, writes its request line when a request arrives, before it has read the body, so before anything can know who signed. On a relay that accepts idemix signers, a log controller of the relay's own therefore writes no line on arrival. Every request other than a `GET` starts unlogged, a browser's preflight included, and becomes loggable only once the relay has read its signer as an X.509 one. Fastify's lines for a completed, failed or unknown request, and the relay's own error line, are skipped for every unlogged request, and a loggable one gets a single line when it completes, with its address. A request whose body can't be read stays unlogged, since nothing shows who sent it. Request IDs are random, so the log doesn't show how many unlogged requests came between two logged ones. The relay's tests capture its log while idemix requests succeed, fail at the peer and are refused, and find it empty. A relay without idemix signers logs as before.

The relay sees the voter's network address and the time of each request. With the private tally it sees only ciphertext, but the address may still identify the voter. The election's relay therefore:

- is run by a party that doesn't count the election and isn't a trustee;
- keeps no request logs, at the relay or at any proxy in front of it;
- is named in the voter invite's `relayOperator`, which the invite's review and Weft's approval window show.

The relay can't remove what runs in front of it: a TLS-terminating proxy or load balancer keeps its own access log unless it is set not to.

The playground's elections use Org1's relay, a trustee's, which a real election rules out. The playground hides nothing from whoever runs it, and its voter invites name the relay's operator as Weft Playground.

## What the explorer shows

An explorer started with `WEFT_EXPERIMENTAL=1`, with the channel's `privateElections: private-ballot` in its policy:

- reads idemix organisations in the channel configuration and shows SHA-256 of each issuer key;
- compares each election's `issuerKeyHash` with SHA-256 of the voter organisation's key in the configuration block, and warns on the election page if they differ;
- shows, in the election's Voters row, the voter organisation, the affiliation, the role, and that the credentials can't be revoked;
- labels an anonymous submitter "Anonymous member of ChairVoters2027MSP", and publishes the anonymous creator in its JSON API and on the transaction page, even where its policy hides submitters: the MSP ID, the affiliation, the role, the one-off Nym and the proof that the Nym belongs to a credential from the issuer key. These name no one and link nothing, and the browser's full check needs the Nym to check each pseudonym proof. The election page shows the label and not the Nym's bytes;
- shows each ballot's voter tag in a Pseudonym column, as Weft's window does, and publishes P and the tag in its JSON API;
- checks each anonymous ballot's creator and pseudonym proof as it indexes the block, and in the full check verifies every ballot's pseudonym proof and that no voter tag repeats. The full check does this with the same idemix module, loaded in one worker only when a visitor asks for the full check of an election with voter credentials.

## No revocation

Fabric can't revoke a voter credential, and it has no expiry. Weft Experimental says so on the credential's detail and, in one sentence, in the voter invite's review, before the voter types the secret. Explorers say so in the election's Voters row. The approval window doesn't, because at that point it changes nothing the voter can do. [What isn't hidden](/experimental/what-is-not-hidden/#fabrics-limits) has the reasons.

## What a ballot still shows

A ballot shows the voter organisation's MSP ID, the shared affiliation, the role, a one-off Nym with its proof, the per-election pseudonym P with its proof, the encrypted ballot and the time. It doesn't show the enrolment ID or the revocation handle. [What isn't hidden](/experimental/what-is-not-hidden/) has the rest.
