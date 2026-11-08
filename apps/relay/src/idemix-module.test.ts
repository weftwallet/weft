/**
 * Experimental (docs/adr/0008): the offline-signing round trip of the idemix
 * study, through the relay, with the WebAssembly module. A voter credential
 * from a scratch issuer, a one-off identity from the module, the proposal the
 * relay builds for it, core's check, the module's signature over the bytes
 * Weft signs, IBM idemix's own MSP accepting it, and fabric-gateway accepting
 * the signed proposal.
 *
 * It needs the module and the Go test tool that @weftwallet/idemix's tests
 * build (pnpm runs them first, since this package depends on it). Without
 * them it skips and says why.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import { connect } from "@hyperledger/fabric-gateway";
import { decodeProposedTransaction, fromBase64, Message, toBase64, verifyProposal } from "@weftwallet/core";
import type { IdemixApi, VoterCredentialSecret } from "@weftwallet/idemix";
import { startIdemixNode } from "@weftwallet/idemix/node";
import { RELAY_PATHS, type ContractCall } from "@weftwallet/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RelayConfig } from "./config.ts";
import { GatewayPool } from "./gateways.ts";
import { buildServer } from "./server.ts";

const idemixDist = fileURLToPath(new URL("../../../packages/idemix/dist/", import.meta.url));
const testtool = join(idemixDist, "test", "testtool");
const skip = !existsSync(join(idemixDist, "wasm", "weft-idemix.wasm"))
  ? "the idemix module isn't built: run pnpm --filter @weftwallet/idemix test first"
  : !existsSync(testtool)
    ? "the idemix Go test tool isn't built: run pnpm --filter @weftwallet/idemix test first"
    : null;

const tool = <T>(args: string[], input?: unknown): T =>
  JSON.parse(execFileSync(testtool, args, { input: input === undefined ? "" : JSON.stringify(input), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })) as T;

const VOTERS = "ChairVoters2027MSP";
const call: ContractCall = { channel: "privatevote-chair-2027", chaincode: "private-ballot", fn: "GetElection", args: ["chair-2027"] };
const config: RelayConfig = {
  port: 0,
  host: "127.0.0.1",
  peerEndpoint: "localhost:1",
  peerHostAlias: undefined,
  peerTlsCaCert: undefined,
  allowedOrigins: "*",
  allowedMspIds: undefined,
  maxGateways: 4,
  invite: null,
  publicUrl: undefined,
  joinPage: undefined,
  experimental: true,
  idemixMspIds: [VOTERS],
  voterInvites: new Map(),
};

describe.skipIf(skip)("offline signing with a voter credential, through the relay", () => {
  let api: IdemixApi;
  let issuer: { issuerPublicKey: string; revocationPublicKey: string; nonce: string; dir: string };
  let credential: VoterCredentialSecret;
  const pool = new GatewayPool(config);
  const client = new grpc.Client("localhost:1", grpc.credentials.createInsecure());

  beforeAll(async () => {
    api = (await startIdemixNode(join(idemixDist, "wasm"))).api;
    const dir = mkdtempSync(join(tmpdir(), "weft-relay-issuer-"));
    issuer = { dir, ...tool<{ issuerPublicKey: string; revocationPublicKey: string; nonce: string }>(["issuer", dir]) };
    await api.loadIssuerKey(issuer.issuerPublicKey);
    const req = await api.credentialRequest(issuer.nonce);
    const issued = tool<{ credential: string; cri: string }>(["issue", dir], { nonce: issuer.nonce, request: req.request, ou: "voters", role: 1, enrollmentId: "voter1" });
    credential = { secretKey: req.secretKey, credential: issued.credential, cri: issued.cri, ou: "voters", role: 1, enrollmentId: "voter1" };
    await api.checkCredential(credential);
  });

  afterAll(async () => {
    await api?.wipe();
    pool.close();
    client.close();
  });

  it("signs the proposal the relay builds, and IBM's MSP and fabric-gateway accept it", async () => {
    const id = await api.newIdentity(credential, VOTERS);
    const signer = { mspId: VOTERS, idemixIdentity: id.idBytes };
    const app = buildServer(config, pool, { logStream: { write: () => {} } });
    const res = await app.inject({ method: "POST", url: RELAY_PATHS.proposals, payload: { signer, call } });
    expect(res.statusCode).toBe(200);
    const proposal = fromBase64(res.json().proposal);
    const decoded = decodeProposedTransaction(proposal);
    expect(() => verifyProposal(call, signer, decoded)).not.toThrow();

    // Weft signs the inner proposal bytes, as for an X.509 identity.
    const signature = await api.sign(id.handle, toBase64(decoded.signable));
    // Proposal: header = 1; Header: signature_header = 2; SignatureHeader: creator = 1.
    const creator = new Message(decoded.signable).message(1).message(2).bytes(1);
    const verified = tool<{ mspId: string; ou: string; role: string }>(["verify"], {
      mspId: VOTERS,
      issuerPublicKey: issuer.issuerPublicKey,
      revocationPublicKey: issuer.revocationPublicKey,
      creator: toBase64(creator),
      message: toBase64(decoded.signable),
      signature,
    });
    expect(verified).toEqual({ mspId: VOTERS, ou: "voters", role: "MEMBER" });

    // fabric-gateway, connected with the same identity, takes the signed proposal back.
    const gateway = connect({ client, identity: { mspId: VOTERS, credentials: fromBase64(id.idBytes) } });
    const signed = gateway.newSignedProposal(proposal, fromBase64(signature));
    expect(signed.getTransactionId()).toBe(res.json().transactionId);
    gateway.close();

    // Another one-off identity from the same credential is another creator, which core refuses.
    const other = await api.newIdentity(credential, VOTERS);
    expect(() => verifyProposal(call, { mspId: VOTERS, idemixIdentity: other.idBytes }, decoded)).toThrow(/signing identity does not match/);
    await api.dispose(id.handle);
    await api.dispose(other.handle);
  });
});
