---
title: Publish an org invite
description: Give users one link that tells Weft where your CA and relay are, built from the connection profile you already have.
---

An invite is a small JSON file served over HTTPS. Users open a link to it, Weft shows them what they're joining, and they enrol with the enrollment ID and secret your registrar gave them. Nobody types a URL.

## Three ways to publish

Pick whichever fits how you already run things. All three produce the same file.

### From the relay (recommended)

Your relay can build the invite from your Fabric connection profile and serve it at `/.well-known/weft-invite.json`. There's nothing extra to host, and the URL stays stable.

```sh
WEFT_CONNECTION_PROFILE=/etc/weft/connection-org1.yaml   # JSON or YAML
WEFT_PUBLIC_URL=https://relay.org1.example.com           # how wallets reach the relay
WEFT_INVITE_CHANNELS=mychannel                           # if the profile lists no channels
```

On startup the relay prints the join link to share. See [Deploy the relay](/operators/relay/#configuration) for every setting.

### With the CLI

```sh
npx @weftwallet/cli invite create \
  --profile connection-org1.json \
  --relay https://relay.org1.example.com \
  --channel mychannel \
  -o invite.json
```

Host `invite.json` anywhere over HTTPS, then make the share links and a QR code:

```sh
npx @weftwallet/cli invite share https://org1.example.com/invite.json --qr invite.svg
```

No connection profile? Use `--msp Org1MSP --ca https://ca.org1.example.com:7054 --ca-name ca-org1` instead of `--profile`.

### In the browser

The [invite maker](/operators/invite-maker/) builds the file, the links and the QR code in the page, and can read a JSON connection profile.

## What Weft reads from a connection profile

| Invite field | From the profile |
|---|---|
| `organization` | `client.organization`, or the only entry in `organizations` |
| `mspId` | `organizations.<org>.mspid` |
| `caUrl`, `caName` | The organisation's first `certificateAuthorities` entry: its `url` and `caName` |
| `channels` | Keys of `channels`, if present; otherwise you name them |
| `network` | `name`, unless you set one |
| `relayUrl` | Not in profiles: always yours to supply |

Peers, orderers and TLS certificates in the profile are ignored. The wallet never talks to them directly; the [relay](/operators/relay/) does.

## Sharing it

Every invite has three equivalent links:

| Link | Use it for |
|---|---|
| **Join link**: `https://weft.ifeanyiugwu.dev/join/?weft-invite=…` | Email, chat, your intranet. Opens a page that previews the invite and hands it to Weft in one click. |
| **Weft link**: `weft://invite?u=…` | Pasting straight into Weft's *Join from an org invite*. |
| **Invite URL**: `https://…/weft-invite.json` | Admin portals that call `weft.addNetwork(url)` from [the SDK](/dapps/quickstart/#onboard-users-from-your-portal). |

**QR codes** encode the join link. On a desktop, users don't need a camera: in Weft's *Join from an org invite*, **Scan QR code on this tab** reads a code shown on screen (a slide, a PDF, a portal page), and pasting a screenshot of a code into the link field works too.

## The file

```json
{
  "weft": 1,
  "network": "Acme Supply Network",
  "organization": "Org1",
  "mspId": "Org1MSP",
  "caUrl": "https://ca.org1.example.com:7054",
  "caName": "ca-org1",
  "relayUrl": "https://relay.org1.example.com",
  "channels": ["mychannel"],
  "enrollmentId": "jdoe"
}
```

| Field | Required | Notes |
|---|---|---|
| `weft` | Yes | Schema version. Always `1` for now. |
| `network` | Yes | Display name. |
| `organization` | Yes | Display name of your organisation. |
| `mspId` | Yes | Your MSP ID. |
| `caUrl` | Yes | Base URL of your Fabric CA. |
| `caName` | No | Needed when the CA server hosts several CAs. |
| `relayUrl` | Yes | Base URL of your [relay](/operators/relay/). |
| `channels` | Yes | Channels members of this org use. |
| `enrollmentId` | No | Pre-fills the enrollment ID, for per-person invites. |

Serve it with `content-type: application/json` over HTTPS, and allow cross-origin `GET` so the join page can preview it (the relay does both). Plain HTTP is accepted only on `localhost`.

## Check it

```sh
npx @weftwallet/cli invite check https://relay.org1.example.com/.well-known/weft-invite.json
```

It validates the invite and confirms the relay and CA answer, exiting non-zero on failure, so it also works as a deployment check in CI.

## Good practice

- **Never put secrets in an invite.** Send enrollment secrets through a separate channel.
- **One invite per organisation**, or per person when you pre-fill `enrollmentId`.
- **Keep the URLs stable.** Moving the CA or relay means re-sharing links; the relay-served invite moves with the relay.
