/**
 * weft_castBallot for an election with voter credentials (docs/adr/0008):
 * from the site's request to its answer, with the wallet's storage in memory,
 * a recorded relay (test/fabric.ts), and the approval window's idemix worker
 * played by a fake module behind the real port protocol (lib/voter/remote.ts).
 * The module's own cryptography is tested in packages/idemix.
 */
import type { IdemixApi, VoterCredentialSecret } from "@weftwallet/idemix";
import { ErrorCode, WeftError, type CastBallotResult, type VoterInvite } from "@weftwallet/protocol";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalOutcome, ApprovalView } from "../messages";
import type { PortLike } from "../voter/remote";
import type { VoterCredentialRecord } from "../voter/types";
import { FakeRelay, makeOrg, recordOf, testElection, type Org } from "./test/fabric";

const stores = new Map<string, Map<string, unknown>>();
const store = (name: string) => stores.get(name) ?? (stores.set(name, new Map()), stores.get(name)!);
const RAW_VAULT_KEY = crypto.getRandomValues(new Uint8Array(32));
const fixtures = vi.hoisted(() => ({ x509: false }));

vi.mock("../db", () => ({
  newId: () => crypto.randomUUID(),
  db: {
    all: async (name: string) => [...store(name).values()],
    get: async (name: string, id: string) => store(name).get(id),
    put: async (name: string, value: { id: string }) => void store(name).set(value.id, structuredClone(value)),
    delete: async (name: string, id: string) => void store(name).delete(id),
    putWithReceipt: async () => {
      throw new Error("An anonymous ballot's receipt is never written to the receipts store.");
    },
  },
}));
vi.mock("../vault", () => ({
  sealReceipt: async () => {
    throw new Error("An anonymous ballot's note is sealed with its activity.");
  },
  status: async () => ({ state: "unlocked", autoLockMinutes: 15, passkeys: [] }),
  derivedKey: async (info: string) => {
    const material = await crypto.subtle.importKey("raw", RAW_VAULT_KEY, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new ArrayBuffer(0), info: new TextEncoder().encode(info) }, material, { name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
  },
}));
vi.mock("../sites", () => ({ notifyNetworkChanged: async () => {} }));
vi.mock("../wallet", () => ({
  activeIdentity: async () => null,
  identityView: async () => null,
  signerFor: async () => {
    throw new Error("A voter credential's ballot is never signed with an X.509 key.");
  },
  refreshInvite: async () => ({ channels: [] }),
  updateNetwork: async () => {},
}));

const { attachVoterPort, ballotModuleFailed, ballotRead, castBallot, setRelayForTests } = await import("./handler");
const { serveSigner } = await import("../voter/remote");
const { anonymousEntries } = await import("../voter/activity");

const CHANNEL = "privatevote-chair-2027";
const params = { channel: CHANNEL, chaincode: "private-ballot", electionId: "chair-2027" };
const ISSUER_KEY_HASH = "f1642101".padEnd(56, "0") + "b0b87480";

let org1: Org;
let org2: Org;
let stranger: Org;
let relay: FakeRelay;

function election() {
  return { ...testElection(CHANNEL), electionId: "chair-2027" };
}

function idemixRecord(patch: Record<string, unknown> = {}) {
  return recordOf(election(), {
    title: "Chair 2027",
    options: election().options,
    voters: { kind: "idemix", msp: "ChairVoters2027MSP", affiliation: "voters", role: "member", issuerKeyHash: ISSUER_KEY_HASH, curve: "FP256BN_AMCL", issuerPublicKey: "AAAA" },
    ...patch,
  });
}

function invite(patch: Partial<VoterInvite> = {}): VoterInvite {
  return {
    weftVoterInvite: 1,
    network: "Weft playground",
    organization: "Chair 2027 voters",
    mspId: "ChairVoters2027MSP",
    affiliation: "voters",
    caUrl: "http://localhost:7081",
    caName: "ca-chair-2027",
    relayUrl: "http://localhost:8787",
    relayOperator: "Weft Playground",
    channel: CHANNEL,
    chaincode: "private-ballot",
    electionId: "chair-2027",
    issuerKeyHash: ISSUER_KEY_HASH,
    curve: "FP256BN_AMCL",
    endorsers: [
      { mspId: "Org1MSP", caChain: org1.chain },
      { mspId: "Org2MSP", caChain: org2.chain },
    ],
    explorerUrl: "http://localhost:8790",
    ...patch,
  };
}

function credential(patch: Partial<VoterCredentialRecord> = {}): VoterCredentialRecord {
  return {
    id: "cred-1",
    invite: invite(),
    inviteUrl: "http://localhost:8787/.well-known/weft-voter-invite/chair-2027.json",
    issuerPublicKey: "AAAA",
    revocationPublicKey: null,
    affiliation: "voters",
    role: "member",
    title: null,
    sealed: { secret: { iv: "", data: "" }, enrollmentId: { iv: "", data: "" } },
    createdAt: 0,
    ...patch,
  };
}

/* The window's module, played by a fake with the same calls. */
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const module = {
  made: [] as { handle: number; nym: string }[],
  disposed: [] as number[],
  signed: 0,
  fail: null as string | null,
};
async function sha(text: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}
function fakeIdemix(): Pick<IdemixApi, "newIdentity" | "sign" | "pseudonym" | "pseudonymProof" | "dispose"> {
  let next = 0;
  const pseudonym = async (secret: string, channel: string, electionId: string) => (await sha(`${secret}|${channel}|${electionId}`)) + (await sha(`P|${electionId}`));
  return {
    newIdentity: async (cred: VoterCredentialSecret, mspId: string) => {
      if (module.fail) throw new Error(module.fail);
      const handle = ++next;
      const nym = hex(crypto.getRandomValues(new Uint8Array(64)));
      module.made.push({ handle, nym });
      return { handle, idBytes: btoa(`idemix ${mspId} ${cred.ou} ${nym}`), nym };
    },
    sign: async () => {
      module.signed += 1;
      return btoa("signature");
    },
    pseudonym: async (_h, channel, electionId) => pseudonym("sk-1", channel, electionId),
    pseudonymProof: async (_h, channel, electionId, tracking) => ({ pseudonym: await pseudonym("sk-1", channel, electionId), c: tracking, ssk: "01".repeat(32), sr: "02".repeat(32) }),
    dispose: async (h) => {
      module.disposed.push(h);
      return "disposed";
    },
  };
}

/** Two ends of a runtime port. */
function portPair(): [PortLike, PortLike] {
  const make = () => ({ message: [] as ((m: unknown) => void)[], disconnect: [] as (() => void)[] });
  const a = make();
  const b = make();
  const end = (self: ReturnType<typeof make>, other: ReturnType<typeof make>): PortLike => ({
    postMessage: (m) => queueMicrotask(() => other.message.forEach((fn) => fn(JSON.parse(JSON.stringify(m))))),
    onMessage: { addListener: (fn) => void self.message.push(fn) },
    onDisconnect: { addListener: (fn) => void self.disconnect.push(fn) },
    disconnect: () => other.disconnect.forEach((fn) => fn()),
  });
  return [end(a, b), end(b, a)];
}

beforeAll(async () => {
  [org1, org2, stranger] = await Promise.all([makeOrg("Org1MSP"), makeOrg("Org2MSP"), makeOrg("Org1MSP")]);
});

beforeEach(() => {
  stores.clear();
  Object.assign(module, { made: [], disposed: [], signed: 0, fail: null });
  relay = new FakeRelay(election(), [org1, org2], stranger);
  relay.record = idemixRecord();
  setRelayForTests(() => relay);
});

/** Starts a request as a site does; the window connects its module unless told not to. */
async function request({ connect = true }: { connect?: boolean } = {}) {
  let view!: ApprovalView;
  let decide!: (d: { approved: boolean; keepReceipt: boolean; choice?: number }) => void;
  let opened!: () => void;
  const open = new Promise<void>((r) => (opened = r));
  const finished: ApprovalOutcome[] = [];
  const result = castBallot("http://localhost:4323", params, {
    open: async (v) => {
      view = v;
      const decision = new Promise<{ approved: boolean; keepReceipt: boolean; choice?: number }>((r) => (decide = r));
      opened();
      return { view: v, decision: { promise: decision } };
    },
    finish: (_a, o) => void finished.push(o),
    saveActivity: async () => {
      throw new Error("An anonymous ballot's activity is never saved readable.");
    },
    announceActivity: () => {},
  }).then(
    (r) => r,
    (e: unknown) => e as WeftError,
  );
  await open;
  if (connect && view.ballotCredential) {
    const [windowEnd, workerEnd] = portPair();
    serveSigner(windowEnd, fakeIdemix(), { secretKey: "sk", credential: "cred", cri: "", ou: "voters", role: 1, enrollmentId: "voter1" }, "ChairVoters2027MSP");
    expect(attachVoterPort(view.id, workerEnd)).toBe(true);
  }
  return { view: () => view, decide: (d: { approved: boolean; keepReceipt: boolean; choice?: number }) => decide(d), finished, result };
}

describe("an election with voter credentials", () => {
  it("is read by a one-off identity, checked against the invite's CA chains, and names no one", async () => {
    store("voterCredentials").set("cred-1", credential());
    const r = await request();
    expect(r.view().ballotCredential).toBe("cred-1");
    expect(r.view().identity).toBeNull();
    const read = await ballotRead(r.view().id);
    expect(read.status).toBe("ready");
    if (read.status !== "ready") return;
    expect(read.election.voter.name).toBe("");
    expect(read.election.anonymous).toMatchObject({ mspId: "ChairVoters2027MSP", affiliation: "voters", role: "member", relayOperator: "Weft Playground", checked: ["Org1MSP", "Org2MSP"] });
    expect(read.election.anonymous?.pseudonym).toMatch(/^[0-9a-f]{64}$/);
    // The relay saw only an idemix signer, and the read's identity was disposed of.
    expect(relay.signers).toEqual([{ mspId: "ChairVoters2027MSP", idemixIdentity: expect.any(String) }]);
    expect(module.disposed).toEqual([module.made[0]!.handle]);
    // The title is kept, for the credential's row.
    expect((store("voterCredentials").get("cred-1") as VoterCredentialRecord).title).toBe("Chair 2027");
    r.decide({ approved: false, keepReceipt: false });
    expect(await r.result).toMatchObject({ code: ErrorCode.UserRejected });
  });

  it("casts CastAnonymousBallot with the pseudonym proof, and seals the activity and receipt", async () => {
    store("voterCredentials").set("cred-1", credential());
    const r = await request();
    const read = await ballotRead(r.view().id);
    if (read.status !== "ready") throw new Error("not ready");
    r.decide({ approved: true, keepReceipt: true, choice: 1 });
    const result = (await r.result) as CastBallotResult;
    expect(result).toMatchObject({ status: "VALID", receipt: { kept: true } });
    expect(relay.calls).toEqual(["propose GetElection", "endorse", "propose CastAnonymousBallot", "endorse", "submit", "commitStatus"]);
    // A new identity for the vote, another Nym, the same pseudonym, both disposed of.
    expect(module.made).toHaveLength(2);
    expect(module.made[0]!.nym).not.toBe(module.made[1]!.nym);
    expect(module.disposed.sort()).toEqual([1, 2]);
    expect(module.signed).toBe(4); // the read's proposal; the vote's proposal, transaction and commit status
    expect(relay.ballots[0]!.tag).toBe(read.election.anonymous!.pseudonym);
    expect(r.finished[0]).toMatchObject({ status: "approved", receipt: { kept: true }, explorerUrl: "http://localhost:8790" });

    // Nothing readable on disk names the transaction: only the row's ID is.
    const rows = [...store("anonymousActivity").values()] as { id: string; sealed: unknown }[];
    expect(rows).toHaveLength(1);
    const disk = JSON.stringify([...stores.entries()].map(([name, s]) => [name, [...s.values()]]));
    for (const secret of [result.transactionId, result.receipt.receipt.tracking, read.election.anonymous!.pseudonym, "Plan B"]) expect(disk).not.toContain(secret);
    // Opened while unlocked, it is the whole record.
    const [entry] = await anonymousEntries();
    expect(entry!.activity).toMatchObject({ status: "committed", transactionId: result.transactionId, call: { fn: "CastAnonymousBallot" }, anonymous: { credentialId: "cred-1" } });
    expect(entry!.activity.call.args).toHaveLength(3);
    expect(JSON.parse(entry!.activity.call.args![2]!)).toEqual({ pseudonym: expect.any(String), c: result.receipt.receipt.tracking, ssk: "01".repeat(32), sr: "02".repeat(32) });
    expect(entry!.receipt).toMatchObject({ tracking: result.receipt.receipt.tracking, option: "Plan B" });
  });

  it("says when Weft's own activity has a ballot from the credential, and passes on the contract's refusal", async () => {
    store("voterCredentials").set("cred-1", credential());
    const first = await request();
    await ballotRead(first.view().id);
    first.decide({ approved: true, keepReceipt: false, choice: 0 });
    await first.result;

    const second = await request();
    const read = await ballotRead(second.view().id);
    if (read.status !== "ready") throw new Error("not ready");
    expect(read.election.alreadyVoted).toEqual({ blockNumber: "41" });
    second.decide({ approved: true, keepReceipt: false, choice: 2 });
    expect(await second.result).toMatchObject({ code: 5001, message: "This credential has already voted in this election." });
    expect(second.finished[0]).toMatchObject({
      status: "failed",
      title: "You've already voted in Budget 2027".replace("Budget 2027", "Chair 2027"),
      detail: "The contract refused a second ballot from your voter credential: it has the same pseudonym in chair-2027 as your first ballot.",
    });
    const entries = await anonymousEntries();
    expect(entries.map((e) => e.activity.status).sort()).toEqual(["committed", "failed"]);
  });

  it("reports a refused pseudonym proof as a fault in Weft", async () => {
    store("voterCredentials").set("cred-1", credential());
    relay.lies = { badProof: true };
    const r = await request();
    await ballotRead(r.view().id);
    r.decide({ approved: true, keepReceipt: false, choice: 0 });
    expect(await r.result).toMatchObject({ code: 5001, message: "The pseudonym proof is not valid." });
    expect(r.finished[0]).toMatchObject({ title: "The contract refused your ballot's pseudonym proof" });
  });

  it("refuses a proposal whose creator isn't the identity Weft made, before signing", async () => {
    store("voterCredentials").set("cred-1", credential());
    const r = await request();
    await ballotRead(r.view().id);
    const signedBefore = module.signed;
    relay.lies = { creator: () => btoa("someone else") };
    r.decide({ approved: true, keepReceipt: false, choice: 0 });
    expect(await r.result).toMatchObject({ code: ErrorCode.Internal });
    expect(r.finished[0]).toMatchObject({ title: "Weft refused to sign your ballot" });
    expect(module.signed).toBe(signedBefore);
    expect(relay.ballots).toHaveLength(0);
  });

  it("refuses a credential whose issuer key isn't the one the election pinned", async () => {
    store("voterCredentials").set("cred-1", credential({ invite: invite({ issuerKeyHash: "0c55e7a9".padEnd(56, "0") + "31f4d206" }) }));
    const r = await request();
    const read = await ballotRead(r.view().id);
    expect(read).toMatchObject({ status: "failed", failure: { kind: "final", title: "Your voter credential is for another issuer key" } });
    expect(await r.result).toMatchObject({ code: 4300, data: { voterMsps: ["ChairVoters2027MSP"] } });
  });

  it("refuses what it read unless every endorsement checks out against the invite", async () => {
    store("voterCredentials").set("cred-1", credential());
    relay.lies = { signer: "stranger" };
    const r = await request();
    const read = await ballotRead(r.view().id);
    expect(read).toMatchObject({ status: "failed", failure: { title: "Weft won't trust what it read" } });
    if (read.status === "failed") {
      expect(read.failure.detail).toMatch(/a peer of Org1MSP or Org2MSP, the organisations your voter invite names/);
      expect(read.failure.technical).toMatch(/The endorsement from Org1MSP doesn't check out: its certificate doesn't chain to the CA certificate in the voter invite/);
    }
    expect(await r.result).toMatchObject({ code: 4400 });
  });

  it("refuses an answer endorsed by an organisation the invite doesn't name", async () => {
    store("voterCredentials").set("cred-1", credential({ invite: invite({ endorsers: [{ mspId: "Org1MSP", caChain: "" }] }) }));
    // Only Org1MSP is pinned: Org2MSP's endorsement can't be checked.
    (store("voterCredentials").get("cred-1") as VoterCredentialRecord).invite.endorsers[0]!.caChain = org1.chain;
    const r = await request();
    const read = await ballotRead(r.view().id);
    expect(read.status === "failed" && read.failure.technical).toMatch(/The endorsement from Org2MSP isn't from an organisation the voter invite names/);
  });

  it("fails with -32603 when the window's module doesn't start", async () => {
    store("voterCredentials").set("cred-1", credential());
    const r = await request({ connect: false });
    const read = await ballotModuleFailed(r.view().id, "CompileError: WebAssembly.instantiate(): refused");
    expect(read).toMatchObject({ status: "failed", failure: { title: "Weft couldn't start its voting module", technical: "-32603 Internal. CompileError: WebAssembly.instantiate(): refused" } });
    expect(await r.result).toMatchObject({ code: ErrorCode.Internal });
  });

  it("fails with -32603 when the module fails while reading", async () => {
    store("voterCredentials").set("cred-1", credential());
    module.fail = "RuntimeError: memory access out of bounds";
    const r = await request();
    const read = await ballotRead(r.view().id);
    expect(read).toMatchObject({ status: "failed", failure: { title: "Weft couldn't start its voting module", technical: "-32603 Internal. RuntimeError: memory access out of bounds" } });
    expect(await r.result).toMatchObject({ code: ErrorCode.Internal });
  });

  it("without a credential for the election, and no identity, says so with 4300", async () => {
    store("voterCredentials").set("other", credential({ id: "other", invite: invite({ electionId: "chair-2028", channel: "privatevote-chair-2028" }) }));
    const r = await request();
    expect(r.view().ballotCredential).toBeUndefined();
    const read = await ballotRead(r.view().id);
    expect(read).toMatchObject({ status: "failed", failure: { title: "Weft holds no voter credential for this election" } });
    expect(await r.result).toMatchObject({ code: 4300 });
  });
});
