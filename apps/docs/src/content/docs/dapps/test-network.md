---
title: Local test network
description: Run Weft end to end against Fabric's sample test network on your machine.
---

This walkthrough uses [`fabric-samples`](https://github.com/hyperledger/fabric-samples) and the `asset-transfer-basic` chaincode (`basic`). You need Docker and the Fabric binaries; follow Fabric's [prerequisites](https://hyperledger-fabric.readthedocs.io/en/latest/getting_started.html) first.

## 1. Start the network

```sh
cd fabric-samples/test-network
./network.sh up createChannel -c mychannel -ca
./network.sh deployCC -ccn basic -ccp ../asset-transfer-basic/chaincode-typescript -ccl typescript
```

`-ca` starts a Fabric CA per organisation, so you can enrol through Weft.

## 2. Start the relay

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

## 3. Register a user

Use Org1's CA admin to register an identity you'll enrol from Weft:

```sh
export PATH=$PWD/../bin:$PATH
export FABRIC_CA_CLIENT_HOME=$PWD/organizations/peerOrganizations/org1.example.com/
fabric-ca-client register --caname ca-org1 \
  --id.name weftuser --id.secret weftpw --id.type client \
  --id.attrs 'role=auditor:ecert' \
  --tls.certfiles "$PWD/organizations/fabric-ca/org1/ca-cert.pem"
```

## 4. Enrol in Weft

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
The test network's CA uses a self-signed TLS certificate, which the browser rejects. Visit `https://localhost:7054/cainfo` once and accept the warning, or import the PEM from `test-network/organizations/peerOrganizations/org1.example.com/msp/cacerts/` instead (see [Import PEM](/start/install/#import-pem)).
:::

Or publish an [invite](/operators/invites/) with the same values and use **Join from an org invite**.

## 5. Call the contract

Serve any page on `localhost` and run:

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
