/**
 * weft_submit and weft_evaluate from the site's request to its answer and the
 * window's outcome, with the wallet's storage in memory and the relay calls
 * stubbed. The case here: the browser refusing a write after the transaction
 * committed, which is said in the window and isn't a failure.
 */
import { ballotCommitment } from "@weftwallet/core";
import { WeftError } from "@weftwallet/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalOutcome } from "./messages";

const quota = () => Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" });

const state = vi.hoisted(() => ({
  stores: new Map<string, Map<string, unknown>>(),
  /** Activity writes fail as a full browser's do. */
  refuseActivity: false,
  /** Receipt writes (the receipt with its activity record) fail too. */
  refuseReceipts: false,
  /** The approval windows opened, by the request ID in their address. */
  windows: [] as string[],
  submit: null as null | (() => Promise<unknown>),
  announced: 0,
}));
const store = (name: string) => state.stores.get(name) ?? (state.stores.set(name, new Map()), state.stores.get(name)!);

vi.mock("wxt/browser", () => ({
  browser: {
    windows: {
      create: async ({ url }: { url: string }) => {
        state.windows.push(decodeURIComponent(url.split("id=")[1] ?? ""));
        return { id: state.windows.length };
      },
      update: async () => {},
      onRemoved: { addListener: () => {} },
    },
    runtime: {
      getURL: (path: string) => path,
      sendMessage: async (message: { event?: string }) => {
        if (message.event === "activity") state.announced++;
      },
    },
  },
}));
vi.mock("./db", () => ({
  newId: () => crypto.randomUUID(),
  db: {
    get: async (name: string, id: string) => store(name).get(id),
    put: async (name: string, value: { id: string }) => {
      if (name === "activity" && state.refuseActivity) throw quota();
      store(name).set(value.id, value);
    },
    putWithReceipt: async (activity: { id: string }, receipt: { id: string }) => {
      if (state.refuseReceipts) throw quota();
      store("activity").set(activity.id, activity);
      store("receipts").set(receipt.id, receipt);
    },
  },
}));
vi.mock("./vault", () => ({
  sealReceipt: async (id: string) => ({ boundTo: id }),
  status: async () => ({ state: "unlocked", autoLockMinutes: 15, passkeys: [] }),
}));
vi.mock("./sites", () => ({
  isConnected: async () => true,
  connectSite: async () => {},
  connectedIdentityIds: async () => ["alice"],
  disconnectSites: async () => {},
}));
vi.mock("./wallet", () => ({
  activeIdentity: async () => ({
    record: { id: "alice", networkId: "net", mspId: "Org1MSP", certificate: "-----BEGIN CERTIFICATE-----", enrollmentId: "alice", createdAt: 0 },
    network: { id: "net", name: "Weft playground", mspId: "Org1MSP", relayUrl: "http://localhost:8787", explorerUrl: "http://localhost:8790", channels: ["mychannel"] },
    channel: "mychannel",
  }),
  activeSummary: async () => null,
  identityView: async () => null,
  signerFor: async () => async () => new Uint8Array(64),
}));
vi.mock("./ballot/handler", () => ({ castBallot: async () => null }));
vi.mock("@weftwallet/core", async (original) => ({
  ...(await original<typeof import("@weftwallet/core")>()),
  summarizeIdentity: async () => ({ notAfter: new Date(Date.now() + 365 * 86_400_000).toISOString() }),
  certificateHealth: () => ({ state: "valid" }),
  submitCall: () => state.submit!(),
  evaluateCall: async () => ({ text: "asset7", status: 200 }),
}));

const { decideApproval, handleProviderRequest } = await import("./provider");

const ORIGIN = "http://localhost:4321";
const TX = "9f3a1c07b25e" + "0".repeat(44) + "e41b22d8";
const SALT = "7c1e94a0b3d25f86e0a4c9172bd35e6f";
const transfer = { channel: "mychannel", chaincode: "basic", fn: "TransferAsset", args: ["asset7", "Org2MSP"] };
const vote = {
  channel: "mychannel",
  chaincode: "ballot",
  fn: "CastVote",
  args: ["board-2026"],
  transient: { ballot: JSON.stringify({ option: "Ada", salt: SALT }) },
  receipt: { type: "weft-ballot-receipt", version: 1, channel: "mychannel", electionId: "board-2026", option: "Ada", salt: SALT },
};

beforeEach(async () => {
  state.stores.clear();
  state.windows.length = 0;
  state.refuseActivity = false;
  state.refuseReceipts = false;
  state.announced = 0;
  const commitment = await ballotCommitment("board-2026", "Ada", SALT);
  state.submit = async () => ({ transactionId: TX, blockNumber: "42", status: "VALID", text: JSON.stringify({ commitment }) });
});

/** Sends a request, approves it in its window, and returns the site's answer and the window's outcome. */
async function approve(method: "weft_submit" | "weft_evaluate", params: unknown, keepReceipt = false) {
  const answer = handleProviderRequest(ORIGIN, method, params).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: error as WeftError }),
  );
  await vi.waitFor(() => expect(state.windows).toHaveLength(1));
  const outcome: ApprovalOutcome = await decideApproval(state.windows[0]!, true, keepReceipt);
  return { answer: await answer, outcome };
}

describe("a committed weft_submit when the browser refuses the activity write", () => {
  it("still answers the site with the committed transaction", async () => {
    state.refuseActivity = true;
    const { answer } = await approve("weft_submit", transfer);
    expect(answer).toEqual({ ok: true, value: expect.objectContaining({ transactionId: TX, blockNumber: "42", status: "VALID" }) });
  });

  it("tells the window what wasn't saved, with the transaction ID, and no activity to point to", async () => {
    state.refuseActivity = true;
    const { outcome } = await approve("weft_submit", transfer);
    expect(outcome).toEqual({
      status: "approved",
      activityId: null,
      blockNumber: "42",
      transactionId: TX,
      explorerUrl: "http://localhost:8790",
      unsaved: { error: "QuotaExceededError: The quota has been exceeded." },
    });
    expect(store("activity").size).toBe(0);
    expect(state.announced).toBe(0);
  });

  it("gives the window the receipt the site got, when one was involved and the user didn't keep it", async () => {
    state.refuseActivity = true;
    const { answer, outcome } = await approve("weft_submit", vote, false);
    expect(answer).toMatchObject({ ok: true, value: { transactionId: TX, receipt: { kept: false, reason: "declined" } } });
    expect(outcome).toMatchObject({
      status: "approved",
      activityId: null,
      receipt: { kept: false, reason: "declined" },
      unsaved: { receipt: { txId: TX, blockNumber: 42, electionId: "board-2026", option: "Ada", salt: SALT }, error: "QuotaExceededError: The quota has been exceeded." },
    });
  });

  it("says both the receipt and the activity record weren't stored when the browser refuses every write", async () => {
    state.refuseActivity = true;
    state.refuseReceipts = true;
    const { answer, outcome } = await approve("weft_submit", vote, true);
    expect(answer).toMatchObject({ ok: true, value: { receipt: { kept: false, reason: "storage" } } });
    expect(outcome).toMatchObject({
      activityId: null,
      receipt: { kept: false, reason: "storage", receipt: { txId: TX } },
      unsaved: { receipt: { txId: TX }, error: "QuotaExceededError: The quota has been exceeded." },
    });
  });

  it("keeps the mismatch and adds what wasn't saved", async () => {
    state.refuseActivity = true;
    state.submit = async () => ({ transactionId: TX, blockNumber: "42", status: "VALID", text: JSON.stringify({ commitment: "0".repeat(64) }) });
    const { outcome } = await approve("weft_submit", vote, true);
    expect(outcome).toMatchObject({ activityId: null, receipt: { kept: false, reason: "mismatch" }, unsaved: { error: expect.stringContaining("QuotaExceededError") } });
  });

  it("adds nothing when the browser stores the transaction", async () => {
    const { outcome } = await approve("weft_submit", transfer);
    expect(outcome).toMatchObject({ status: "approved", transactionId: TX });
    expect(outcome).not.toHaveProperty("unsaved");
    expect((outcome as { activityId: string }).activityId).toBeTruthy();
    expect(store("activity").get((outcome as { activityId: string }).activityId)).toMatchObject({ status: "committed", transactionId: TX });
    expect(state.announced).toBe(1);
  });

  it("adds nothing when the receipt is kept with its activity record", async () => {
    const { outcome } = await approve("weft_submit", vote, true);
    expect(outcome).toMatchObject({ receipt: { kept: true } });
    expect(outcome).not.toHaveProperty("unsaved");
    expect(store("receipts").size).toBe(1);
  });
});

describe("other writes the browser refuses", () => {
  it("still answers a read, with no activity to point to", async () => {
    state.refuseActivity = true;
    const { answer, outcome } = await approve("weft_evaluate", transfer);
    expect(answer).toEqual({ ok: true, value: { text: "asset7", status: 200 } });
    expect(outcome).toEqual({ status: "approved", activityId: null });
  });

  it("reports a failed submit as the failure it is, and doesn't say its details are in the activity", async () => {
    state.refuseActivity = true;
    state.submit = async () => {
      throw new Error("relay exploded");
    };
    const { answer, outcome } = await approve("weft_submit", transfer);
    expect(answer.ok).toBe(false);
    expect((answer as { error: WeftError }).error.message).toBe("relay exploded");
    expect(outcome).toMatchObject({ status: "failed", activityId: null, title: "Weft had an unexpected error" });
  });
});
