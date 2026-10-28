import "reflect-metadata";
import { buildSignInMessage, signForFabric, toBase64, utf8 } from "@weftwallet/core";
import { ca, user } from "./test/certs.ts";
import { describe, expect, it } from "vitest";
import { Auth, chainsTo } from "./auth.ts";
import { ExplorerDb } from "./db.ts";
import { decodeBlock } from "./decode.ts";
import { parsePolicy, publishBlock, publishedChannels } from "./policy.ts";
import { buildServer } from "./server.ts";
import { chain } from "./test/blocks.ts";

const ORIGIN = "http://explorer.test";
const NETWORK = "https://docs.test";

async function signIn(who: { keys: CryptoKeyPair; pem: string }, mspId: string, nonce: string, origin = ORIGIN) {
  const issuedAt = new Date();
  const message = buildSignInMessage({ origin, mspId, nonce, issuedAt, expiresAt: new Date(issuedAt.getTime() + 300_000) });
  const signature = toBase64(await signForFabric(who.keys.privateKey, utf8(message)));
  return { message, signature, certificate: who.pem, mspId };
}

const policy = parsePolicy({
  organisation: "Org1",
  channels: {
    open: { level: "public", contracts: { ballot: "members" } },
    private: { level: "members" },
  },
});

async function setup() {
  const org1 = await ca("ca.org1");
  const org2 = await ca("ca.org2");
  const outsider = await ca("ca.elsewhere");
  const members = [
    { mspId: "Org1MSP", rootCerts: [org1.pem] },
    { mspId: "Org2MSP", rootCerts: [org2.pem] },
  ];
  const db = new ExplorerDb(":memory:");
  const index = (name: string, blocks: Parameters<typeof chain>[1]) => {
    for (const b of chain(name, blocks)) {
      const decoded = decodeBlock(b);
      const config = decoded.transactions.find((t) => t.members);
      if (config?.members) db.setMembers(name, config.members);
      db.addBlock(publishBlock(policy, decoded));
    }
  };
  index("open", [
    { txs: [{ txId: "cfg000", chaincode: "", args: [], config: true, members }] },
    {
      txs: [
        { txId: "aaa111", chaincode: "basic", args: ["CreateAsset", "a1"], writes: [{ key: "a1", value: "x" }] },
        { txId: "bbb222", chaincode: "ballot", args: ["CastVote", "yes"], writes: [{ key: "v1", value: "yes" }], creator: "Org2MSP" },
      ],
    },
  ]);
  index("private", [
    { txs: [{ txId: "cfg111", chaincode: "", args: [], config: true, members: [members[0]!] }] },
    { txs: [{ txId: "ccc333", chaincode: "basic", args: ["Secret", "s"], writes: [{ key: "s", value: "s" }] }] },
  ]);
  const auth = new Auth("test secret");
  const app = buildServer({
    name: "Org1",
    channels: publishedChannels(policy),
    policy,
    db,
    status: () => [],
    auth,
    publicUrl: ORIGIN,
    networkPage: `${NETWORK}/operators/network/`,
  });
  return { db, app, auth, org1, org2, outsider };
}

async function login(app: Awaited<ReturnType<typeof setup>>["app"], who: { keys: CryptoKeyPair; pem: string }, mspId: string) {
  const { nonce } = (await app.inject("/auth/nonce")).json();
  const res = await app.inject({ method: "POST", url: "/auth/verify", payload: await signIn(who, mspId, nonce) });
  return res;
}

const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0]!;

describe("members level", () => {
  it("reads member organisations from config blocks", async () => {
    const { db } = await setup();
    expect(db.members("open").map((m) => m.mspId)).toEqual(["Org1MSP", "Org2MSP"]);
    expect(db.members("private").map((m) => m.mspId)).toEqual(["Org1MSP"]);
  });

  it("hides members-only channels and details from anonymous viewers", async () => {
    const { app } = await setup();
    expect((await app.inject("/channels/private")).statusCode).toBe(404);
    expect((await app.inject("/api/v1/channels/private/transactions/ccc333")).statusCode).toBe(404);
    const vote = (await app.inject("/api/v1/channels/open/transactions/bbb222")).json();
    expect(vote).toMatchObject({ redacted: true, membersOnly: true, chaincode: null, args: [], creator: null });
    expect((await app.inject("/channels/open/contracts/ballot")).statusCode).toBe(404);
    expect((await app.inject("/api/v1/channels/open/transactions?org=Org2MSP")).json()).toEqual([]);
    expect((await app.inject("/search?q=ballot")).body).toContain("Nothing published matches");
    const page = await app.inject("/channels/open/transactions/bbb222");
    expect(page.body).toContain("Only members of open can see this transaction");
    expect(page.body).toContain("Sign in with Weft");
  });

  it("signs in a member and shows them what members see", async () => {
    const { app, org1 } = await setup();
    const alice = await user(org1, "alice");
    const res = await login(app, alice, "Org1MSP");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mspId: "Org1MSP", name: "alice" });
    expect(String(res.headers["set-cookie"])).toMatch(/HttpOnly; SameSite=Lax/);
    const cookie = cookieOf(res);

    expect((await app.inject({ url: "/channels/private", headers: { cookie } })).statusCode).toBe(200);
    const vote = (await app.inject({ url: "/api/v1/channels/open/transactions/bbb222", headers: { cookie } })).json();
    expect(vote).toMatchObject({ redacted: false, chaincode: "ballot", fn: "CastVote" });
    const status = (await app.inject({ url: "/api/v1/status", headers: { cookie } })).json();
    expect(status.viewer).toEqual({ mspId: "Org1MSP", name: "alice" });
    expect(status.channels.map((c: { channel: string }) => c.channel)).toEqual(["open", "private"]);
    const home = await app.inject({ url: "/", headers: { cookie } });
    expect(home.body).toContain("Sign out");
  });

  it("gives each organisation only its own channels", async () => {
    const { app, org2 } = await setup();
    const bob = await user(org2, "bob");
    const cookie = cookieOf(await login(app, bob, "Org2MSP"));
    expect((await app.inject({ url: "/channels/private", headers: { cookie } })).statusCode).toBe(404);
    const vote = (await app.inject({ url: "/api/v1/channels/open/transactions/bbb222", headers: { cookie } })).json();
    expect(vote.redacted).toBe(false);
  });

  it("refuses certificates from another CA, claimed MSPs, reused nonces and other origins", async () => {
    const { app, org1, outsider } = await setup();
    const eve = await user(outsider, "eve");
    expect((await login(app, eve, "Org1MSP")).json().error).toMatch(/wasn't issued by Org1MSP's CA/);
    expect((await login(app, eve, "Org9MSP")).json().error).toMatch(/isn't a member/);

    const alice = await user(org1, "alice");
    const { nonce } = (await app.inject("/auth/nonce")).json();
    const body = await signIn(alice, "Org1MSP", nonce);
    expect((await app.inject({ method: "POST", url: "/auth/verify", payload: body })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/verify", payload: body })).json().error).toMatch(/already used/);

    const { nonce: n2 } = (await app.inject("/auth/nonce")).json();
    const elsewhere = await signIn(alice, "Org1MSP", n2, "https://phishing.example");
    expect((await app.inject({ method: "POST", url: "/auth/verify", payload: elsewhere })).json().error).toMatch(/another site/);

    const { nonce: n3 } = (await app.inject("/auth/nonce")).json();
    const tampered = await signIn(alice, "Org1MSP", n3);
    tampered.message = tampered.message.replace("Org1MSP", "Org2MSP");
    expect((await app.inject({ method: "POST", url: "/auth/verify", payload: tampered })).json().error).toMatch(/doesn't match/);
  });

  it("rejects forged or expired session cookies", async () => {
    const { app, auth } = await setup();
    const forged = new Auth("another secret").cookie({ mspId: "Org1MSP", name: "mallory", expires: Date.now() + 60_000 });
    expect((await app.inject({ url: "/channels/private", headers: { cookie: `weft_session=${forged}` } })).statusCode).toBe(404);
    const expired = auth.cookie({ mspId: "Org1MSP", name: "alice", expires: Date.now() - 1 });
    expect((await app.inject({ url: "/channels/private", headers: { cookie: `weft_session=${expired}` } })).statusCode).toBe(404);
  });

  it("checks certificate chains and dates", async () => {
    const org1 = await ca("ca.org1");
    const expired = await user(org1, "old", -1000);
    const fresh = await user(org1, "new");
    expect(chainsTo(fresh.pem, { mspId: "Org1MSP", rootCerts: [org1.pem], intermediateCerts: [] })).toBe(true);
    expect(chainsTo(expired.pem, { mspId: "Org1MSP", rootCerts: [org1.pem], intermediateCerts: [] })).toBe(false);
  });
});

describe("signing out", () => {
  it("clears the session from a plain form post", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "POST", url: "/auth/sign-out", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "" });
    expect(res.statusCode).toBe(303);
    expect(String(res.headers["set-cookie"])).toMatch(/Max-Age=0/);
  });
});

describe("the network page", () => {
  const network = (who: { keys: CryptoKeyPair; pem: string }, mspId: string, nonce = "networkpage-nonce-0001", origin = NETWORK) =>
    signIn(who, mspId, nonce, origin);

  it("signs in once with its own nonce, and reads members-only channels with a bearer token", async () => {
    const { app, org1 } = await setup();
    const alice = await user(org1, "alice");
    const preflight = await app.inject({ method: "OPTIONS", url: "/auth/network" });
    expect(preflight.headers["access-control-allow-origin"]).toBe(NETWORK);

    const res = await app.inject({ method: "POST", url: "/auth/network", payload: await network(alice, "Org1MSP") });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(NETWORK);
    const { token, mspId, name } = res.json();
    expect({ mspId, name }).toEqual({ mspId: "Org1MSP", name: "alice" });

    expect((await app.inject("/api/v1/channels/private/transactions/ccc333")).statusCode).toBe(404);
    const withToken = await app.inject({ url: "/api/v1/channels/private/transactions/ccc333", headers: { authorization: `Bearer ${token}` } });
    expect(withToken.statusCode).toBe(200);
    expect(withToken.headers["cache-control"]).toBe("no-store");
    const api = await app.inject({ method: "OPTIONS", url: "/api/v1/status" });
    expect(api.headers["access-control-allow-headers"]).toBe("authorization");
  });

  it("refuses a reused nonce, another origin, a long-lived message and a forged token", async () => {
    const { app, org1 } = await setup();
    const alice = await user(org1, "alice");
    const post = async (payload: object) => (await app.inject({ method: "POST", url: "/auth/network", payload })).statusCode;
    const once = await network(alice, "Org1MSP", "networkpage-nonce-0002");
    expect(await post(once)).toBe(200);
    expect(await post(once)).toBe(401);
    expect(await post(await network(alice, "Org1MSP", "networkpage-nonce-0003", "https://evil.test"))).toBe(401);
    const issuedAt = new Date();
    const long = buildSignInMessage({ origin: NETWORK, mspId: "Org1MSP", nonce: "networkpage-nonce-0004", issuedAt, expiresAt: new Date(issuedAt.getTime() + 3600_000) });
    expect(await post({ message: long, signature: toBase64(await signForFabric(alice.keys.privateKey, utf8(long))), certificate: alice.pem })).toBe(401);
    const forged = await app.inject({ url: "/api/v1/channels/private/transactions/ccc333", headers: { authorization: "Bearer abc.def" } });
    expect(forged.statusCode).toBe(404);
  });

  it("isn't offered by an explorer without a network page", async () => {
    const db = new ExplorerDb(":memory:");
    const app = buildServer({ name: "Org1", channels: [], policy, db, status: () => [] });
    expect((await app.inject({ method: "POST", url: "/auth/network", payload: {} })).statusCode).toBe(404);
  });
});

