/**
 * weft_castBallot from the site's request to its answer, with the wallet's
 * storage in memory and a recorded relay (test/fabric.ts).
 */
import { ErrorCode, WeftError, type CastBallotResult } from "@weftwallet/protocol";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityRecord, ReceiptRecordV2 } from "../db";
import type { ApprovalOutcome, ApprovalView } from "../messages";
import { FakeRelay, makeOrg, testElection, type Org } from "./test/fabric";

/* The wallet's storage and keys, in memory. */
const stores = new Map<string, Map<string, unknown>>();
const store = (name: string) => stores.get(name) ?? (stores.set(name, new Map()), stores.get(name)!);
let refuseWrites = false;
const wallet = {
  org: null as Org | null,
  channels: ["mychannel", "privatevote-budget-2027"],
  inviteUrl: undefined as string | undefined,
  chain: true,
  inviteChannels: ["mychannel"],
  updated: null as string[] | null,
};

vi.mock("../db", () => ({
  newId: () => crypto.randomUUID(),
  db: {
    all: async (name: string) => [...store(name).values()],
    get: async (name: string, id: string) => store(name).get(id),
    put: async (name: string, value: { id: string }) => void store(name).set(value.id, value),
    putWithReceipt: async (activity: { id: string }, receipt: { id: string }) => {
      if (refuseWrites) throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" });
      store("activity").set(activity.id, activity);
      store("receipts").set(receipt.id, receipt);
    },
  },
}));
vi.mock("../vault", () => ({
  // A stand-in seal that can be read back, so the test can see what was sealed.
  sealReceipt: async (id: string, secret: Uint8Array) => ({ boundTo: id, plain: new TextDecoder().decode(secret) }),
  status: async () => ({ state: "unlocked", autoLockMinutes: 15, passkeys: [] }),
}));
vi.mock("../sites", () => ({ notifyNetworkChanged: async () => {} }));
const fixtures = vi.hoisted(() => ({ record: null as null | (() => Record<string, unknown>), network: null as null | (() => Record<string, unknown>) }));
vi.mock("../wallet", async () => {
  const { signForFabric } = await import("@weftwallet/core");
  const record = () => ({
    id: "alice",
    networkId: "net",
    mspId: "Org1MSP",
    certificate: wallet.org!.voter.pem,
    enrollmentId: "alice",
    createdAt: 0,
    ...(wallet.chain ? { caChain: wallet.org!.chain } : {}),
  });
  const network = () => ({
    id: "net",
    name: "Weft playground",
    organization: "Org1",
    mspId: "Org1MSP",
    caUrl: "http://localhost:7080",
    relayUrl: "http://localhost:8787",
    explorerUrl: "http://localhost:8790",
    channels: wallet.channels,
    ...(wallet.inviteUrl ? { inviteUrl: wallet.inviteUrl } : {}),
  });
  fixtures.record = record;
  fixtures.network = network;
  return {
    activeIdentity: async () => ({ record: record(), network: network(), channel: "mychannel" }),
    identityView: async () => null,
    signerFor: async () => (m: Uint8Array) => signForFabric(wallet.org!.voter.keys.privateKey, m),
    refreshInvite: async () => ({ channels: wallet.inviteChannels }),
    updateNetwork: async (_id: string, patch: { channels: string[] }) => {
      wallet.updated = patch.channels;
      wallet.channels = patch.channels;
    },
  };
});

const { ballotRead, ballotRefreshInvite, castBallot, setRelayForTests } = await import("./handler");

let org1: Org;
let org2: Org;
let relay: FakeRelay;

beforeAll(async () => {
  [org1, org2] = await Promise.all([makeOrg("Org1MSP"), makeOrg("Org2MSP")]);
});

beforeEach(() => {
  stores.clear();
  refuseWrites = false;
  Object.assign(wallet, { org: org1, channels: ["mychannel", "privatevote-budget-2027"], inviteUrl: undefined, chain: true, inviteChannels: ["mychannel"], updated: null });
  relay = new FakeRelay(testElection(), [org1, org2]);
  setRelayForTests(() => relay);
});

const params = { channel: "privatevote-budget-2027", chaincode: "private-ballot", electionId: "budget-2027" };

/** Starts a request and returns its window's handle: the decision to make, and how it finished. */
async function request(raw: unknown = params) {
  // The identity and network the worker reads back when it signs the ballot.
  store("identities").set("alice", fixtures.record!());
  store("networks").set("net", fixtures.network!());
  let view!: ApprovalView;
  let decide!: (d: { approved: boolean; keepReceipt: boolean; choice?: number }) => void;
  let opened!: () => void;
  const open = new Promise<void>((r) => (opened = r));
  const finished: ApprovalOutcome[] = [];
  const saved: ActivityRecord[] = [];
  const result = castBallot("http://localhost:4323", raw, {
    open: async (v) => {
      view = v;
      const decision = new Promise<{ approved: boolean; keepReceipt: boolean; choice?: number }>((r) => (decide = r));
      opened();
      return { view: v, decision: { promise: decision } };
    },
    finish: (_a, o) => void finished.push(o),
    saveActivity: async (r) => void saved.push(r),
    announceActivity: () => {},
  }).then(
    (r) => ({ ok: true as const, value: r }),
    (e: unknown) => ({ ok: false as const, error: e as WeftError }),
  );
  await open;
  return { view, decide: (d: Parameters<typeof decide>[0]) => decide(d), result, finished, saved };
}

describe("weft_castBallot", () => {
  it("checks the params before any window opens", async () => {
    let opened = false;
    const error = await castBallot("http://localhost:4323", { ...params, choice: 1 }, {
      open: async (v) => ((opened = true), { view: v, decision: { promise: new Promise(() => {}) } }),
      finish: () => {},
      saveActivity: async () => {},
      announceActivity: () => {},
    }).catch((e: unknown) => e as WeftError);
    expect(error).toMatchObject({ code: ErrorCode.InvalidParams });
    expect(opened).toBe(false);
  });

  it("reads, then casts the chosen option and returns the transaction and a version 2 receipt", async () => {
    const req = await request();
    const read = await ballotRead(req.view.id);
    expect(read.status).toBe("ready");
    if (read.status !== "ready") return;
    expect(read.election).toMatchObject({ title: "Budget 2027", options: ["Plan A", "Plan B", "Plan C"], trustees: ["Org1MSP", "Org2MSP"], threshold: 2, peerChecked: true });
    expect(read.election.fingerprint).toBe(relay.record.fingerprint);
    expect(read.election.voter).toEqual({ name: "alice", mspId: "Org1MSP" });

    req.decide({ approved: true, keepReceipt: true, choice: 1 });
    const out = await req.result;
    expect(out.ok).toBe(true);
    const result = (out as { value: CastBallotResult }).value;
    expect(result).toEqual({
      transactionId: relay.ballots[0]!.txId,
      blockNumber: "41",
      status: "VALID",
      receipt: {
        kept: true,
        receipt: { type: "weft-ballot-receipt", version: 2, channel: params.channel, electionId: params.electionId, txId: relay.ballots[0]!.txId, blockNumber: 41, tracking: relay.ballots[0]!.tracking },
      },
    });

    // The receipt is kept with its activity record, and only the sealed note holds the choice.
    const kept = [...store("receipts").values()] as ReceiptRecordV2[];
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ version: 2, tracking: relay.ballots[0]!.tracking, sealed: { plain: '{"option":"Plan B"}' } });
    const activity = [...store("activity").values()] as ActivityRecord[];
    expect(activity[0]).toMatchObject({ status: "committed", receipt: true, call: { fn: "CastBallot", args: [params.electionId, relay.ballots[0]!.ballot] } });
    const { sealed: _note, ...receiptRecord } = kept[0]!;
    for (const text of [JSON.stringify(result), JSON.stringify(activity), JSON.stringify(receiptRecord), JSON.stringify(req.finished)]) {
      expect(text).not.toContain("Plan B");
    }
    expect(req.finished[0]).toMatchObject({ status: "approved", blockNumber: "41", tracking: relay.ballots[0]!.tracking, receipt: { kept: true } });
  });

  it("keeps nothing when the voter leaves the receipt off", async () => {
    const req = await request();
    await ballotRead(req.view.id);
    req.decide({ approved: true, keepReceipt: false, choice: 0 });
    const out = await req.result;
    expect((out as { value: CastBallotResult }).value.receipt).toMatchObject({ kept: false, reason: "declined" });
    expect(store("receipts").size).toBe(0);
    expect(req.saved[0]).toMatchObject({ status: "committed" });
  });

  it("keeps nothing when the contract's tracking code isn't Weft's, and the receipt carries Weft's", async () => {
    relay.lies = { tracking: "00".repeat(32) };
    const req = await request();
    await ballotRead(req.view.id);
    req.decide({ approved: true, keepReceipt: true, choice: 2 });
    const out = (await req.result) as { value: CastBallotResult };
    expect(out.value.receipt).toMatchObject({ kept: false, reason: "mismatch", receipt: { tracking: relay.ballots[0]!.tracking } });
    expect(store("receipts").size).toBe(0);
  });

  it("returns the receipt when the browser refuses to store it", async () => {
    refuseWrites = true;
    const req = await request();
    await ballotRead(req.view.id);
    req.decide({ approved: true, keepReceipt: true, choice: 0 });
    const out = (await req.result) as { value: CastBallotResult };
    expect(out.value.receipt).toMatchObject({ kept: false, reason: "storage" });
    expect(req.finished[0]).toMatchObject({ receipt: { kept: false, reason: "storage", error: "QuotaExceededError: The quota has been exceeded." } });
  });

  it("answers the site at once with 4400 for an election that isn't open, and keeps the window until it closes", async () => {
    relay.record = { ...relay.record, state: "decrypting" };
    const req = await request();
    const read = await ballotRead(req.view.id);
    expect(read).toMatchObject({ status: "failed", failure: { kind: "final", title: "Budget 2027 has closed" } });
    const out = await req.result;
    expect(out.ok).toBe(false);
    expect((out as { error: WeftError }).error).toMatchObject({ code: 4400, data: { state: "decrypting" } });
    // The window still shows the same failure, and closing it ends the approval.
    expect(await ballotRead(req.view.id)).toEqual(read);
    expect(req.finished).toHaveLength(0);
    req.decide({ approved: false, keepReceipt: false });
    await vi.waitFor(() => expect(req.finished).toEqual([{ status: "rejected" }]));
  });

  it("answers 4400 for an election that doesn't exist, or whose record doesn't match its key", async () => {
    const missing = await request({ ...params, electionId: "budget-2030" });
    expect(await ballotRead(missing.view.id)).toMatchObject({ failure: { title: "There's no election budget-2030" } });
    expect(((await missing.result) as { error: WeftError }).error.code).toBe(4400);

    relay.record = { ...relay.record, fingerprint: "11".repeat(10) };
    const changed = await request();
    expect(await ballotRead(changed.view.id)).toMatchObject({ failure: { title: "Weft won't cast a ballot in this election" } });
    expect(((await changed.result) as { error: WeftError }).error.code).toBe(4400);
  });

  it("answers 4300 with the voter organisations when the identity can't vote", async () => {
    relay.record = { ...relay.record, voters: { kind: "x509", msps: ["Org2MSP"] } };
    const req = await request();
    expect(await ballotRead(req.view.id)).toMatchObject({ failure: { title: "None of your identities can vote here" } });
    expect(((await req.result) as { error: WeftError }).error).toMatchObject({ code: 4300, data: { voterMsps: ["Org2MSP"] } });
  });

  it("keeps the request waiting while the relay doesn't answer, and fails it with 5002 on Reject", async () => {
    relay.down.add("/v1/proposals");
    const req = await request();
    expect(await ballotRead(req.view.id)).toMatchObject({ failure: { kind: "unreachable", title: "Weft couldn't reach the relay" } });
    req.decide({ approved: false, keepReceipt: false });
    expect(((await req.result) as { error: WeftError }).error.code).toBe(ErrorCode.NetworkUnavailable);
  });

  it("reads again with Try again once the relay answers", async () => {
    relay.down.add("/v1/proposals/endorse");
    const req = await request();
    expect((await ballotRead(req.view.id)).status).toBe("failed");
    relay.down.clear();
    expect((await ballotRead(req.view.id)).status).toBe("ready");
    req.decide({ approved: true, keepReceipt: false, choice: 1 });
    expect((await req.result).ok).toBe(true);
  });

  it("offers Refresh from invite for a channel an older invite doesn't list", async () => {
    wallet.channels = ["mychannel"];
    wallet.inviteUrl = "http://localhost:8787/v1/invite";
    const req = await request();
    expect(await ballotRead(req.view.id)).toMatchObject({ failure: { kind: "noChannel", inviteUrl: "http://localhost:8787/v1/invite" } });
    // The invite doesn't list it yet: the request ends with 4300.
    expect(await ballotRefreshInvite(req.view.id)).toMatchObject({ failure: { kind: "final", title: "None of your identities can vote here" } });
    expect(((await req.result) as { error: WeftError }).error.code).toBe(4300);

    wallet.inviteChannels = ["mychannel", "privatevote-budget-2027"];
    const again = await request();
    expect((await ballotRead(again.view.id)).status).toBe("failed");
    expect((await ballotRefreshInvite(again.view.id)).status).toBe("ready");
    expect(wallet.updated).toEqual(["mychannel", "privatevote-budget-2027"]);
  });

  it("reads without the peer check when Weft kept no CA chain", async () => {
    wallet.chain = false;
    const req = await request();
    expect(await ballotRead(req.view.id)).toMatchObject({ election: { peerChecked: false } });
  });

  it("warns about an earlier ballot in Weft's activity", async () => {
    const first = await request();
    await ballotRead(first.view.id);
    first.decide({ approved: true, keepReceipt: false, choice: 0 });
    await first.result;
    // saveActivity is the host's: put the record where the next read looks.
    for (const r of first.saved) store("activity").set(r.id, r);
    const second = await request();
    expect(await ballotRead(second.view.id)).toMatchObject({ election: { alreadyVoted: { blockNumber: "41" } } });
    second.decide({ approved: true, keepReceipt: false, choice: 1 });
    const out = (await second.result) as { error: WeftError };
    expect(out.error).toMatchObject({ code: ErrorCode.TransactionFailed, message: "This identity has already voted in this election." });
    expect(second.finished[0]).toMatchObject({ status: "failed", title: "You've already voted in Budget 2027", next: "Nothing was written to the ledger. Your first ballot stands." });
    expect(second.saved[0]).toMatchObject({ status: "failed", title: "You've already voted in Budget 2027" });
  });

  it("fails with 5001 when the election closes between the read and the vote", async () => {
    const req = await request();
    await ballotRead(req.view.id);
    relay.record = { ...relay.record, state: "decrypting" };
    req.decide({ approved: true, keepReceipt: false, choice: 1 });
    expect(((await req.result) as { error: WeftError }).error).toMatchObject({ code: 5001, message: "Voting has closed." });
    expect(req.finished[0]).toMatchObject({ title: "Voting closed before your ballot arrived" });
  });

  it("says the ballot may have committed when the relay stops answering after it was sent", async () => {
    const req = await request();
    await ballotRead(req.view.id);
    relay.down.add("/v1/commits/status");
    req.decide({ approved: true, keepReceipt: false, choice: 1 });
    expect(((await req.result) as { error: WeftError }).error.code).toBe(ErrorCode.NetworkUnavailable);
    expect(req.finished[0]).toMatchObject({ status: "failed", uncertain: true, title: "Weft couldn't tell if your ballot was committed" });
    expect((req.finished[0] as { next: string }).next).toMatch(/^Check tracking code [0-9a-f]{8}…[0-9a-f]{8} in the explorer/);
  });

  it("fails with 4001 when the voter rejects the vote", async () => {
    const req = await request();
    await ballotRead(req.view.id);
    req.decide({ approved: false, keepReceipt: false });
    expect(((await req.result) as { error: WeftError }).error.code).toBe(ErrorCode.UserRejected);
    expect(relay.ballots).toHaveLength(0);
  });
});
