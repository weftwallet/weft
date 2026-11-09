---
title: Local test network
description: Run Weft end to end against Fabric's sample test network on your machine.
---

Run Weft against Fabric's [`test-network`](https://github.com/hyperledger/fabric-samples), with the `basic` asset-transfer contract and Weft's ballot contract. You need Docker running (Docker Desktop or OrbStack).

## The quick way

From the Weft repository:

```sh
pnpm install
pnpm playground:up      # first run downloads Fabric, 5 to 10 minutes
pnpm dev:playground     # in another terminal
```

Then open the [playground](weft:playground/). It finds the local network, and lets you:

- join as a demo user (`alice` / `alicepw` or `bob` / `bobpw`) and call the `basic` contract;
- vote in an election with the [ballot contract](/guides/elections/), then check your receipt in the explorer;
- compare the two organisations' [explorers](/operators/explorer/#in-the-playground), which publish different amounts of the same ledger and agree on every block, and sign in to see the members-only channel, `members`.

`pnpm playground:down` removes everything.

| What | Where |
|---|---|
| Invite | `http://localhost:8787/.well-known/weft-invite.json` |
| Relay | `http://localhost:8787` |
| Org1's CA, through the proxy | `http://localhost:7080` |
| Explorers | [localhost:8790](http://localhost:8790) (Org1), [localhost:8791](http://localhost:8791) (Org2) |
| Contracts on `mychannel` | `basic`, and `ballot` with its private collection |
| Elections | `team-lunch` (counted), `board-2026` (open) |

`playground:up` does the steps below for you, plus one more: it puts a proxy in front of Org1's CA on `http://localhost:7080`, so the browser can enrol (see the caution in step 4). Add `--https` to serve it on `https://localhost:7443` with a [mkcert](https://github.com/FiloSottile/mkcert) certificate instead, to test an HTTPS CA URL like a real organisation's. Details: [`playground/README.md`](https://github.com/weftwallet/weft/tree/main/playground).

## By hand

If you'd rather see each step, or use a fabric-samples checkout you already have:

### 1. Start the network

```sh
cd fabric-samples/test-network
./network.sh up createChannel -c mychannel -ca
./network.sh deployCC -ccn basic -ccp ../asset-transfer-basic/chaincode-typescript -ccl typescript
```

`-ca` starts a Fabric CA per organisation, so you can enrol through Weft.

### 2. Start the relay

From the Weft repository:

```sh
cp apps/relay/.env.example apps/relay/.env   # edit the TLS path to point at your fabric-samples
pnpm dev:relay
```

The example `.env` targets Org1's peer at `localhost:7051` with its TLS CA certificate and host alias `peer0.org1.example.com`. Check it's up:

```sh
curl http://localhost:8787/v1/health
```

### 3. Register a user

Use Org1's CA admin to register an identity you'll enrol from Weft:

```sh
export PATH=$PWD/../bin:$PATH
export FABRIC_CA_CLIENT_HOME=$PWD/organizations/peerOrganizations/org1.example.com/
fabric-ca-client register --caname ca-org1 \
  --id.name weftuser --id.secret weftpw --id.type client \
  --id.attrs 'role=auditor:ecert' \
  --tls.certfiles "$PWD/organizations/fabric-ca/org1/ca-cert.pem"
```

### 4. Enrol in Weft

In the extension choose **Enrol with CA** and enter:

| Field | Value |
|---|---|
| Enrolment ID and secret | `weftuser` / `weftpw` |
| MSP ID | `Org1MSP` |
| Channels | `mychannel` |
| Relay URL | `http://localhost:8787` |
| CA URL | `http://localhost:7080` (the CA proxy) |
| CA name | `ca-org1` |

:::caution[Self-signed CA certificate]
The test network's CA serves HTTPS with a self-signed certificate. The browser refuses it, and accepting it in a tab doesn't help: Weft's background worker still refuses it, so enrolment fails with "Failed to fetch". `pnpm playground:up` starts a proxy for this. By hand, run the playground's CA proxy, which verifies the CA against its root certificate and serves plain HTTP on `localhost`, and use `http://localhost:7080` as the CA URL:

```sh
node playground/ca-proxy.mjs --listen 7080 --target https://localhost:7054 \
  --upstream-ca fabric-samples/test-network/organizations/fabric-ca/org1/ca-cert.pem
```
:::

Or publish an [invite](/operators/invites/) with the same values and use **Join from an invite**.

### 5. Call the contract

Use the [playground](weft:playground/), or serve any page on `localhost` and run:

```ts
import { getWeft } from "@weftwallet/sdk";

const weft = await getWeft();
await weft.connect();
const basic = weft.contract({ channel: "mychannel", chaincode: "basic" });
await basic.submit("InitLedger");
console.log(await basic.evaluateJson("GetAllAssets"));
await basic.submit("TransferAsset", "asset6", "Christopher");
```

Each call opens a Weft approval window. After the submit, the transaction appears in Weft's **Activity** with its block number.
