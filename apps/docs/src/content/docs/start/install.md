---
title: Install and add an identity
description: Install the extension, then join your organisation's network with an invite, your CA, or an existing certificate.
---

## Install

Weft is not in the Chrome Web Store yet. Build it and load it unpacked:

```sh
git clone https://github.com/ifeanyi-ugwu/weft
cd weft
pnpm install
pnpm build
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick `apps/extension/.output/chrome-mv3`.

## Add an identity

Open Weft from the toolbar. There are four ways in; pick the one your administrator set up.

### Join from an org invite (recommended)

If your administrator sent a link that opens a "Join a network" page, click **Open in Weft** there and skip to step 3.

1. Choose **Join from an org invite** and paste the link (it starts with `weft://invite` or `https://`). If you were given a QR code instead, show it on screen and choose **Scan QR code on this tab**, or paste a screenshot of it into the link field.
2. Weft asks your browser for permission to reach the invite's host. Allow it.
3. Check the network, organisation, MSP ID and channels shown. If anything looks wrong, stop and ask your administrator.
4. Enter your **enrollment ID** and **enrollment secret**, then **Enroll**. Weft asks for access to the CA and relay hosts, creates a key pair, and asks the CA for a certificate.

The secret is used once and never stored.

### Enroll with CA

The same as an invite, but you type the details yourself: MSP ID, channels, relay URL, CA URL and, if your CA server hosts more than one CA, the CA name.

### Import PEM

For an identity you already have as files, for example from `fabric-samples`:

- **Certificate**: the PEM file under `msp/signcerts/`.
- **Private key**: the file under `msp/keystore/`. It must be PKCS#8 (`-----BEGIN PRIVATE KEY-----`). If yours says `BEGIN EC PRIVATE KEY`, convert it first:

  ```sh
  openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem
  ```

Weft checks the key belongs to the certificate, then imports it as a non-exportable key. Delete the key file afterwards; Weft cannot give it back to you.

### Generate CSR

For CAs where an administrator issues certificates by hand. Weft creates the key and a certificate signing request (CSR). Copy the CSR to your administrator; when they send a certificate back, open **Identities**, find it under **Waiting for a certificate**, and paste it in.

## Connect a site

The first time a web app needs your identity, Weft opens a window asking whether to connect. The site then sees your public identity: name, MSP ID, role, attributes and certificate. Connecting does **not** let it sign anything; each query and transaction asks again.

A connection is for one identity. If you switch to another identity, sites you haven't connected it to are disconnected and must ask again, so a site only ever sees the identities you chose for it. **Sites** on the home screen shows which identities each site can use, and disconnects it.

## Network settings

Open **Manage identities** (the people icon at the top of the home screen) and pick a network under **Networks**.

- **Refresh from invite** checks your organisation's invite again and shows what changed, such as a new channel or a moved relay, before applying it.
- **Advanced** lets you change the relay URL, CA URL and CA name, like a custom RPC URL in MetaMask. Weft tests the new addresses before saving. Only use addresses your organisation gave you.

There's no setting for peers on purpose. Your organisation's relay chooses which peers to use, and finds other organisations' peers through Fabric's discovery service.
