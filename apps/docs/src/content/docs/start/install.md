---
title: Install and add an identity
description: Install the extension, then join your organisation's network with an invite, your CA, or an existing certificate.
---

Weft is not in the Chrome Web Store or any other browser store yet. Until it is, the extension is installed from a build. There are two ways to get one, depending on who you are.

## If your organisation gave you an invite

Your network administrator sets Weft up for your organisation and sends you an invite link. They also provide the build of the extension to load, or they install it for you through your browser's managed policies. If you have an invite but no extension, ask your administrator for the build; do not install one from anywhere else.

Once the extension is loaded, open the invite link, or paste it into Weft, and follow [Join from an org invite](#join-from-an-org-invite-recommended) below. You will need the enrolment ID and secret your administrator gave you.

When Weft is listed in the browser stores, this page will link to the listing and the steps above will shorten to one.

## If you are a developer

Build the extension from the source and load it unpacked:

```sh
git clone https://github.com/ifeanyi-ugwu/weft
cd weft
pnpm install
pnpm build
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick `apps/extension/.output/chrome-mv3`. Weft runs in Chrome, Edge, Brave and other Chromium browsers.

For a network to try it against, see [Local test network](/dapps/test-network/) or the [playground](weft:playground/).

## Add an identity

Open Weft from the toolbar. There are four ways in; pick the one your administrator set up.

The first time, Weft asks you to set a password. It encrypts your private keys with it and asks for it again whenever Weft has locked itself. You can add a passkey later under **Security** to unlock with a fingerprint or security key instead.

### Join from an org invite (recommended)

If your administrator sent a link that opens a "Join a network" page, click **Open in Weft** there and skip to step 3.

1. Choose **Join from an org invite** and paste the link (it starts with `weft://invite` or `https://`). If you were given a QR code instead, show it on screen and choose **Scan QR code on this tab**, or paste a screenshot of it into the link field.
2. Weft asks your browser for permission to reach the invite's host. Allow it.
3. Check the network, organisation, MSP ID and channels shown. If anything looks wrong, stop and ask your administrator.
4. Enter your **enrolment ID** and **enrolment secret**, then choose **Enrol**. Weft asks for access to the CA and relay hosts, creates a key pair, and asks the CA for a certificate.

The secret is used once and never stored.

### Enrol with CA

The same as an invite, but you type the details yourself: MSP ID, channels, relay URL, CA URL and, if your CA server hosts more than one CA, the CA name.

### Import PEM

For an identity you already have as files, for example from `fabric-samples`:

- The certificate: the PEM file under `msp/signcerts/`.
- The private key: the file under `msp/keystore/`. It must be PKCS#8 (`-----BEGIN PRIVATE KEY-----`). If yours says `BEGIN EC PRIVATE KEY`, convert it first:

  ```sh
  openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem
  ```

Weft checks the key belongs to the certificate, then stores it encrypted with your password. Delete the key file afterwards; Weft cannot give it back to you.

### Generate CSR

For CAs where an administrator issues certificates by hand. Weft creates the key and a certificate signing request (CSR). Copy the CSR to your administrator; when they send a certificate back, open **Identities**, find it under **Waiting for a certificate**, and paste it in.

## Connect a site

The first time a web app needs your identity, Weft opens a window asking whether to connect. The site then sees your public identity: name, MSP ID, role, attributes and certificate. Connecting does **not** let it sign anything; each query and transaction asks again.

A connection is for one identity. If you switch to another identity, sites you haven't connected it to are disconnected and must ask again, so a site only ever sees the identities you chose for it. **Sites** on the home screen shows which identities each site can use, and disconnects it.

## Network settings

Open **Manage identities** (the people icon at the top of the home screen) and pick a network under **Networks**.

- Choose **Refresh from invite** to check your organisation's invite again and see what changed, such as a new channel or a moved relay, before applying it.
- Choose **Advanced** to change the relay URL, CA URL and CA name, like a custom RPC URL in MetaMask. Weft tests the new addresses before saving. Only use addresses your organisation gave you. For a network added without an invite, Advanced also edits its channel list.

There's no setting for peers on purpose. Your organisation's relay chooses which peers to use, and finds other organisations' peers through Fabric's discovery service.
