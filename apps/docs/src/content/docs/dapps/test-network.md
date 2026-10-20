---
title: Local test network
description: Run Weft end to end against Fabric's sample test network on your machine.
---

Run Weft against Fabric's [`test-network`](https://github.com/hyperledger/fabric-samples) and the `basic` asset-transfer contract. You need Docker running (Docker Desktop or OrbStack).

## The quick way

From the Weft repository:

```sh
pnpm install
pnpm playground:up      # first run downloads Fabric, ~5–10 minutes
pnpm dev:docs           # in another terminal
```

Then open [the playground](http://localhost:4321/playground/). It finds the local network, lets you join as a demo user (`alice` / `alicepw` or `bob` / `bobpw`) and call the contract. `pnpm playground:down` removes everything.

`playground:up` does the steps below for you, plus one more: it puts an HTTPS proxy with a locally trusted certificate in front of Org1's CA, so the browser can enrol. Install [mkcert](https://github.com/FiloSottile/mkcert) first (`brew install mkcert` on macOS) to get that. Details: [`playground/README.md`](https://github.com/ifeanyi-ugwu/weft/tree/main/playground).

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
pnpm build
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

In the extension choose **Enroll with CA** and enter:

| Field | Value |
|---|---|
| Enrollment ID / secret | `weftuser` / `weftpw` |
| MSP ID | `Org1MSP` |
| Channels | `mychannel` |
| Relay URL | `http://localhost:8787` |
| CA URL | `https://localhost:7054` |
| CA name | `ca-org1` |

:::caution[Self-signed CA certificate]
The test network's CA uses a TLS certificate the browser doesn't trust, so enrolment fails. Either open `https://localhost:7054/cainfo` once and accept the warning, or run the playground's CA proxy and use `https://localhost:7443` as the CA URL:

```sh
mkcert -cert-file localhost.pem -key-file localhost-key.pem localhost
node playground/ca-proxy.mjs --listen 7443 --target https://localhost:7054 \
  --cert localhost.pem --key localhost-key.pem \
  --upstream-ca fabric-samples/test-network/organizations/fabric-ca/org1/ca-cert.pem
```
:::

Or publish an [invite](/operators/invites/) with the same values and use **Join from an org invite**.

### 5. Call the contract

Use [the playground](/playground/), or serve any page on `localhost` and run:

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
