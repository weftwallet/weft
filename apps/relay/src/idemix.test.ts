/**
 * Experimental (docs/adr/0008): idemix signers in the relay, its request
 * logging, the gateway it uses for them, and the voter invites it serves.
 * Without a network: the proposals endpoint builds bytes offline, and the
 * others fail at the unreachable peer, which still runs their logging and
 * their gateway's release.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeProposedTransaction, fromBase64, parseVoterInvite, verifyProposal, VerificationError } from "@weftwallet/core";
import { RELAY_PATHS, VOTER_INVITE_PATH, type ContractCall, type RelaySigner, type VoterInvite } from "@weftwallet/protocol";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type RelayConfig } from "./config.ts";
import { GatewayPool, type Lease } from "./gateways.ts";
import { buildServer } from "./server.ts";
import { loadVoterInvites } from "./voter-invites.ts";

const VOTERS = "ChairVoters2027MSP";
const PEM = "-----BEGIN CERTIFICATE-----\nMIIBdummy\n-----END CERTIFICATE-----\n";
/** Stands in for a serialized idemix identity: the relay treats it as opaque bytes. */
const idemixBytes = new Uint8Array(Array.from({ length: 300 }, (_, i) => (i * 37 + 11) % 256));
const idemixIdentity = Buffer.from(idemixBytes).toString("base64");
const call: ContractCall = { channel: "privatevote-chair-2027", chaincode: "private-ballot", fn: "GetElection", args: ["chair-2027"] };

const base: RelayConfig = {
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

/** Counts the gateways handed out and released, around the real pool. */
class CountingPool extends GatewayPool {
  acquired: { idemix: boolean; gateway: object }[] = [];
  released = 0;
  override acquire(signer: RelaySigner): Lease {
    const lease = super.acquire(signer);
    this.acquired.push({ idemix: "idemixIdentity" in signer, gateway: lease.gateway });
    return { gateway: lease.gateway, release: () => (this.released++, lease.release()) };
  }
}
const pool = new CountingPool(base);
afterAll(() => pool.close());
beforeEach(() => {
  pool.acquired = [];
  pool.released = 0;
});

/** A relay whose log lines are kept, one parsed object per line. */
function relay(config: Partial<RelayConfig> = {}) {
  const lines: Record<string, unknown>[] = [];
  const app = buildServer({ ...base, ...config }, pool, { logStream: { write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) } });
  return { app, lines };
}

const post = (app: ReturnType<typeof relay>["app"], url: string, payload: unknown) =>
  app.inject({ method: "POST", url, payload: payload as object, remoteAddress: "203.0.113.7" });
const idemix = { mspId: VOTERS, idemixIdentity };
const x509 = { mspId: "Org1MSP", certificate: PEM };

describe("idemix signers", () => {
  it("are refused without WEFT_EXPERIMENTAL=1", async () => {
    const { app } = relay({ experimental: false, idemixMspIds: [] });
    const res = await post(app, RELAY_PATHS.proposals, { signer: idemix, call });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe(
      "This relay doesn't accept idemix signers. A relay accepts them only when it's started with WEFT_EXPERIMENTAL=1, for Weft Experimental.",
    );
  });

  it("are refused from an MSP that isn't in WEFT_IDEMIX_MSP_IDS", async () => {
    const { app } = relay();
    const res = await post(app, RELAY_PATHS.proposals, { signer: { ...idemix, mspId: "ChairVoters2028MSP" }, call });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe("This relay doesn't accept idemix signers from ChairVoters2028MSP.");
  });

  it("are refused as malformed base64, or beside a certificate, without repeating the identity", async () => {
    const { app } = relay();
    for (const [signer, message] of [
      [{ mspId: VOTERS, idemixIdentity: "not base64!" }, 'The "signer.idemixIdentity" field must be base64.'],
      [{ mspId: VOTERS, idemixIdentity: "" }, 'The "signer.idemixIdentity" field must be base64.'],
      [{ mspId: VOTERS, idemixIdentity: "abc" }, 'The "signer.idemixIdentity" field must be base64.'],
      [{ ...idemix, certificate: PEM }, 'The signer has both "certificate" and "idemixIdentity". Give one.'],
    ] as const) {
      const res = await post(app, RELAY_PATHS.proposals, { signer, call });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe(message);
      expect(res.body).not.toContain(idemixIdentity.slice(0, 40));
    }
  });

  it("refuses an X.509 signer that names a voter MSP", async () => {
    const { app } = relay();
    const res = await post(app, RELAY_PATHS.proposals, { signer: { mspId: VOTERS, certificate: PEM }, call });
    expect(res.json().error.message).toBe(
      "This relay accepts only idemix signers from ChairVoters2027MSP, the voter organisation of an election with voter credentials.",
    );
  });

  it("builds a proposal whose creator is the idemix identity, byte for byte", async () => {
    const { app } = relay();
    const res = await post(app, RELAY_PATHS.proposals, { signer: idemix, call });
    expect(res.statusCode).toBe(200);
    const decoded = decodeProposedTransaction(fromBase64(res.json().proposal));
    expect(decoded.creatorMspId).toBe(VOTERS);
    expect(Buffer.from(decoded.creatorIdBytes)).toEqual(Buffer.from(idemixBytes));
    expect(() => verifyProposal(call, idemix, decoded)).not.toThrow();
  });

  it("gets a new gateway for every request, released when the request is done, and none cached", async () => {
    const { app } = relay();
    await post(app, RELAY_PATHS.proposals, { signer: idemix, call });
    await post(app, RELAY_PATHS.proposals, { signer: idemix, call });
    // These fail at the unreachable peer, and still release their gateway.
    const evaluated = await post(app, RELAY_PATHS.evaluate, { signer: idemix, proposal: "AAAA", signature: "AAAA" });
    expect(evaluated.statusCode).toBeGreaterThanOrEqual(500);
    await post(app, RELAY_PATHS.commitStatus, { signer: idemix, commit: "AAAA", signature: "AAAA" });
    expect(pool.acquired).toHaveLength(4);
    expect(new Set(pool.acquired.map((a) => a.gateway)).size).toBe(4);
    expect(pool.released).toBe(4);
    expect(pool.cached).toBe(0);
    // An X.509 signer's gateway is cached, as before.
    await post(app, RELAY_PATHS.proposals, { signer: x509, call: { ...call, channel: "mychannel" } });
    await post(app, RELAY_PATHS.proposals, { signer: x509, call: { ...call, channel: "mychannel" } });
    expect(pool.acquired[4]!.gateway).toBe(pool.acquired[5]!.gateway);
    expect(pool.cached).toBe(1);
  });
});

describe("request logs on a relay that accepts idemix signers", () => {
  it("has no line for a request from an idemix signer, whatever its outcome", async () => {
    const { app, lines } = relay();
    await post(app, RELAY_PATHS.proposals, { signer: idemix, call });
    await post(app, RELAY_PATHS.evaluate, { signer: idemix, proposal: "AAAA", signature: "AAAA" });
    await post(app, RELAY_PATHS.endorse, { signer: idemix, proposal: "AAAA", signature: "AAAA" });
    await post(app, RELAY_PATHS.submit, { signer: idemix, transaction: "AAAA", signature: "AAAA" });
    await post(app, RELAY_PATHS.commitStatus, { signer: idemix, commit: "AAAA", signature: "AAAA" });
    await post(app, RELAY_PATHS.proposals, { signer: { mspId: VOTERS, idemixIdentity: "not base64!" }, call });
    // A body that isn't JSON, and a path that doesn't exist: the relay can't tell who signed.
    await app.inject({ method: "POST", url: RELAY_PATHS.proposals, payload: "{", headers: { "content-type": "application/json" }, remoteAddress: "203.0.113.7" });
    await post(app, "/v1/nowhere", { signer: idemix });
    await app.inject({ method: "OPTIONS", url: RELAY_PATHS.proposals, headers: { origin: "https://vote.example", "access-control-request-method": "POST" }, remoteAddress: "203.0.113.7" });
    expect(lines).toEqual([]);
  });

  it("logs a GET, and a request from an X.509 signer, in one line each with its address", async () => {
    const { app, lines } = relay();
    await app.inject({ method: "GET", url: RELAY_PATHS.health, remoteAddress: "203.0.113.8" });
    await post(app, RELAY_PATHS.proposals, { signer: x509, call: { ...call, channel: "mychannel" } });
    await post(app, RELAY_PATHS.evaluate, { signer: x509, proposal: "AAAA", signature: "AAAA" });
    const completed = lines.filter((l) => l.msg === "request completed");
    expect(completed).toHaveLength(3);
    expect(completed.map((l) => (l.req as { url: string; remoteAddress: string }).remoteAddress)).toEqual(["203.0.113.8", "203.0.113.7", "203.0.113.7"]);
    expect(lines.some((l) => l.msg === "request failed")).toBe(true);
    expect(lines.some((l) => l.msg === "incoming request")).toBe(false);
    // Random request IDs: a counter would show how many unlogged requests came in between.
    expect(completed.every((l) => /^[0-9a-f]{16}$/.test(String(l.reqId)))).toBe(true);
  });

  it("is unchanged on a relay that doesn't accept idemix signers", async () => {
    const { app, lines } = relay({ experimental: false, idemixMspIds: [] });
    await post(app, RELAY_PATHS.proposals, { signer: x509, call: { ...call, channel: "mychannel" } });
    expect(lines.map((l) => l.msg)).toEqual(["incoming request", "request completed"]);
  });
});

describe("core's proposal check for idemix creators", () => {
  it("refuses a creator that differs from the identity Weft made by one byte", async () => {
    const { app } = relay();
    const res = await post(app, RELAY_PATHS.proposals, { signer: idemix, call });
    const decoded = decodeProposedTransaction(fromBase64(res.json().proposal));
    for (const at of [0, 150, idemixBytes.length - 1]) {
      const other = new Uint8Array(idemixBytes);
      other[at] = other[at]! ^ 1;
      const signer = { mspId: VOTERS, idemixIdentity: Buffer.from(other).toString("base64") };
      expect(() => verifyProposal(call, signer, decoded)).toThrow(VerificationError);
      expect(() => verifyProposal(call, signer, decoded)).toThrow(/signing identity does not match/);
    }
    const shorter = { mspId: VOTERS, idemixIdentity: Buffer.from(idemixBytes.subarray(1)).toString("base64") };
    expect(() => verifyProposal(call, shorter, decoded)).toThrow(/signing identity/);
    // An X.509 signer's check is unchanged: a certificate is not the idemix creator.
    expect(() => verifyProposal(call, { mspId: VOTERS, certificate: PEM }, decoded)).toThrow(/signing certificate/);
  });
});

/* ---------------------------------------------------------------- */

const invite: VoterInvite = {
  weftVoterInvite: 1,
  network: "Weft playground",
  organization: "Chair 2027 voters",
  mspId: VOTERS,
  affiliation: "voters",
  caUrl: "http://localhost:7081",
  caName: "ca-chair-2027",
  relayUrl: "http://localhost:8787",
  relayOperator: "Weft Playground",
  channel: "privatevote-chair-2027",
  chaincode: "private-ballot",
  electionId: "chair-2027",
  issuerKeyHash: "f".repeat(64),
  curve: "FP256BN_AMCL",
  endorsers: [
    { mspId: "Org1MSP", caChain: PEM },
    { mspId: "Org2MSP", caChain: PEM },
  ],
  explorerUrl: "http://localhost:8790",
};

function folder(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "weft-voter-invites-"));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  return dir;
}

describe("voter invites", () => {
  const env = { WEFT_PEER_ENDPOINT: "localhost:7051" };

  it("are read from WEFT_VOTER_INVITES with the switch on, and served by election", async () => {
    const config = loadConfig({ ...env, WEFT_EXPERIMENTAL: "1", WEFT_IDEMIX_MSP_IDS: VOTERS, WEFT_VOTER_INVITES: folder({ "chair-2027.json": invite, "notes.txt": "ignored" }) });
    expect([...config.voterInvites.keys()]).toEqual(["chair-2027"]);
    const { app } = relay({ voterInvites: config.voterInvites });
    const ok = await app.inject({ method: "GET", url: VOTER_INVITE_PATH("chair-2027"), headers: { origin: "chrome-extension://abc" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBeTruthy();
    expect(ok.json()).toEqual(invite);
    const missing = await app.inject({ method: "GET", url: VOTER_INVITE_PATH("chair-2028") });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe("This relay publishes no voter invite for chair-2028.");
  });

  it("are read when first asked for when added after startup, with the same checks", async () => {
    const dir = folder({ "chair-2027.json": invite });
    const config = loadConfig({ ...env, WEFT_EXPERIMENTAL: "1", WEFT_IDEMIX_MSP_IDS: VOTERS, WEFT_VOTER_INVITES: dir });
    const { app, lines } = relay(config);
    writeFileSync(join(dir, "chair-2028.json"), JSON.stringify({ ...invite, electionId: "chair-2028" }));
    writeFileSync(join(dir, "chair-2029.json"), JSON.stringify({ ...invite, electionId: "chair-2027" }));
    const late = await app.inject({ method: "GET", url: VOTER_INVITE_PATH("chair-2028") });
    expect(late.statusCode).toBe(200);
    expect(late.json().electionId).toBe("chair-2028");
    expect(config.voterInvites.has("chair-2028")).toBe(true);
    const misnamed = await app.inject({ method: "GET", url: VOTER_INVITE_PATH("chair-2029") });
    expect(misnamed.statusCode).toBe(404);
    expect(lines.some((l) => String(l.msg).includes("so its file must be named chair-2027.json"))).toBe(true);
    expect((await app.inject({ method: "GET", url: VOTER_INVITE_PATH("..%2Fsecret") })).statusCode).toBe(404);
  });

  it("are refused without WEFT_EXPERIMENTAL=1", () => {
    expect(() => loadConfig({ ...env, WEFT_VOTER_INVITES: folder({}) })).toThrow(
      "WEFT_VOTER_INVITES is set, but the relay serves voter invites only when it's started with WEFT_EXPERIMENTAL=1.",
    );
  });

  it("must be named for their election and name a voter MSP the relay accepts", () => {
    const options = { experimental: true, idemixMspIds: [VOTERS] };
    expect(() => loadVoterInvites(folder({ "chair-2028.json": invite }), options)).toThrow(/is the voter invite for chair-2027, so its file must be named chair-2027.json/);
    expect(() => loadVoterInvites(folder({ "chair-2027.json": invite }), { ...options, idemixMspIds: ["Other"] })).toThrow(
      /names ChairVoters2027MSP, which isn't in WEFT_IDEMIX_MSP_IDS, so this relay would refuse its voters' ballots/,
    );
    expect(() => loadVoterInvites(folder({ "chair-2027.json": "{" }), options)).toThrow(/isn't JSON/);
  });

  it("are checked field by field", () => {
    const bad = (change: Record<string, unknown>) => () => parseVoterInvite({ ...invite, ...change }, "x.json");
    expect(bad({ weftVoterInvite: 2 })).toThrow('x.json isn\'t a voter invite Weft Experimental can use: "weftVoterInvite" must be 1.');
    expect(bad({ weft: 1 })).toThrow(/has a "weft" field/);
    expect(bad({ relayOperator: "" })).toThrow(/"relayOperator" is missing or empty/);
    expect(bad({ affiliation: undefined })).toThrow(/"affiliation" is missing or empty/);
    expect(bad({ caUrl: "ftp://ca" })).toThrow(/"caUrl" must be an http or https URL/);
    expect(bad({ issuerKeyHash: "F".repeat(64) })).toThrow(/"issuerKeyHash" must be 64 lowercase hex characters/);
    expect(bad({ curve: "BN254" })).toThrow(/"curve" must be FP256BN_AMCL/);
    expect(bad({ endorsers: [] })).toThrow(/"endorsers" must list at least one organisation/);
    expect(bad({ endorsers: [{ mspId: "Org1MSP", caChain: "nope" }] })).toThrow(/endorsers\[0\]'s "caChain" must be PEM/);
    expect(parseVoterInvite({ ...invite, extra: "dropped" }, "x.json")).toEqual(invite);
  });
});
