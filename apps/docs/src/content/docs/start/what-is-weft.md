---
title: What is Weft?
description: How Weft differs from an Ethereum wallet, and the three pieces that make it work.
---

On most Hyperledger Fabric applications today, a server signs for everyone. A portal holds the users' identities, people log in to it with a password, and it submits each transaction under an identity the person never touches. Weft moves the identity into the person's own browser: the web app asks for a signature, the person reads the transaction and approves it, and the ledger records who decided.

Weft is a browser extension that lets you use web apps built on [Hyperledger Fabric](https://hyperledger-fabric.readthedocs.io/) the way MetaMask lets you use Ethereum apps: the web app asks, you see exactly what it wants, and you approve or reject.

## How it differs from a crypto wallet

Fabric is a **permissioned** network with no coins, gas or public addresses:

| Ethereum wallet | Weft |
|---|---|
| A private key you generate yourself | A certificate issued by your organisation's CA |
| An address anyone can send to | An identity: your name, your organisation's MSP ID, your role and attributes |
| Networks: Mainnet, Sepolia… | A network and its **channels**: separate ledgers shared by a set of organisations |
| A balance | Certificate health: when it expires and whether it still works |
| "Send 0.1 ETH" | "Call `TransferAsset("asset6", "Christopher")` on the `basic` contract" |

Weft's home screen shows your identity on the network and its certificate health.

## The three pieces

```
  Your browser                     Your organisation
 ┌──────────────────────┐         ┌───────────────────────────┐
 │ Web app              │         │                           │
 │   │ window.weft      │         │  Relay ──gRPC──▶ Peer     │
 │   ▼                  │  HTTPS  │      ▲                    │
 │ Weft extension ──────┼────────▶│      │                    │
 │  (keys, approvals)   │         │  Fabric CA (enrolment)    │
 └──────────────────────┘         └───────────────────────────┘
```

1. The extension holds your identities and signs. It shows every request before signing.
2. The relay runs inside your organisation, next to its peers. Browsers can't open gRPC connections to Fabric peers, so the relay builds the unsigned messages, the extension signs them, and the relay forwards the signed bytes. The relay never sees your private key. The reasoning is in [Architecture decisions](/reference/decisions/).
3. The invite is a link your administrator shares. It tells Weft where your CA and relay are, so you never type a URL.

## What you'll need

- Chrome, Edge, Brave or another Chromium browser.
- From your administrator: an invite link, plus an enrolment ID and secret. If they don't use invites yet, the CA URL, relay URL, MSP ID and channel names do the same job.

Next: [install Weft and add your first identity](/start/install/).
