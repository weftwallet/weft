/**
 * What Weft keeps for voter credentials (docs/adr/0008): the sealing, the
 * store's rules, the sealed activity, and the port between the background
 * worker and the window's module.
 */
import type { IdemixApi } from "@weftwallet/idemix";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityRecord } from "../db";
import type { PortLike } from "./remote";
import type { VoterCredentialRecord } from "./types";

const stores = new Map<string, Map<string, unknown>>();
const store = (name: string) => stores.get(name) ?? (stores.set(name, new Map()), stores.get(name)!);
const state = vi.hoisted(() => ({ locked: false, raw: new Uint8Array(32).fill(7) }));

vi.mock("../db", () => ({
  db: {
    all: async (name: string) => [...store(name).values()],
    get: async (name: string, id: string) => store(name).get(id),
    put: async (name: string, value: { id: string }) => void store(name).set(value.id, structuredClone(value)),
    delete: async (name: string, id: string) => void store(name).delete(id),
  },
}));
vi.mock("../vault", () => ({
  derivedKey: async (info: string) => {
    if (state.locked) throw Object.assign(new Error("Weft is locked. Unlock it to sign."), { name: "VaultLockedError" });
    const material = await crypto.subtle.importKey("raw", state.raw, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new ArrayBuffer(0), info: new TextEncoder().encode(info) }, material, { name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
  },
}));

const { openCredential, openEnrollmentId, sealCredential, voterKey, VOTER_KEY_INFO } = await import("./seal");
const { addVoterCredential, credentialFor, removeVoterCredential, voterCredentialViews } = await import("./store");
const { anonymousActivity, anonymousEntries, anonymousReceiptView, removeAnonymousReceipt, saveAnonymous } = await import("./activity");
const { ModuleCallError, SignerGoneError, portSigner, serveSigner } = await import("./remote");

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const SECRET = { secretKey: "U0VDUkVUS0VZ", credential: "Q1JFREVOVElBTA==", cri: "Q1JJ", ou: "voters", role: 1, enrollmentId: "voter1" };

async function record(id = "cred-1", electionId = "chair-2027"): Promise<VoterCredentialRecord> {
  return {
    id,
    invite: {
      weftVoterInvite: 1,
      network: "Weft playground",
      organization: "Chair 2027 voters",
      mspId: "ChairVoters2027MSP",
      affiliation: "voters",
      caUrl: "http://localhost:7081",
      relayUrl: "http://localhost:8787",
      relayOperator: "Weft Playground",
      channel: `privatevote-${electionId}`,
      chaincode: "private-ballot",
      electionId,
      issuerKeyHash: "a".repeat(64),
      curve: "FP256BN_AMCL",
      endorsers: [{ mspId: "Org1MSP", caChain: PEM }],
      explorerUrl: "http://localhost:8790",
    },
    inviteUrl: "http://localhost:8787/x.json",
    issuerPublicKey: "SVBL",
    revocationPublicKey: null,
    affiliation: "voters",
    role: "member",
    title: null,
    sealed: await sealCredential(await voterKey(), id, SECRET),
    createdAt: 1,
  };
}

/** Two ends of a runtime port, JSON between them as in the browser. */
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

beforeEach(() => {
  stores.clear();
  state.locked = false;
  state.raw = new Uint8Array(32).fill(7);
});

describe("sealing", () => {
  it("derives its own key from the vault key", () => {
    expect(VOTER_KEY_INFO).toBe("weft voter credentials v1");
  });

  it("keeps the secret key, the credential, the CRI and the enrolment ID only sealed", async () => {
    const r = await record();
    const text = JSON.stringify(r);
    for (const s of [SECRET.secretKey, SECRET.credential, SECRET.cri, SECRET.enrollmentId, atob(SECRET.secretKey)]) expect(text).not.toContain(s);
    expect(await openCredential(await voterKey(), r)).toEqual(SECRET);
    expect(await openEnrollmentId(await voterKey(), r)).toBe("voter1");
  });

  it("binds each sealed value to its record and field", async () => {
    const r = await record();
    const key = await voterKey();
    await expect(openEnrollmentId(key, { id: "cred-2", sealed: r.sealed })).rejects.toThrow();
    await expect(openEnrollmentId(key, { id: r.id, sealed: { ...r.sealed, enrollmentId: r.sealed.secret } })).rejects.toThrow();
  });

  it("can't be opened while Weft is locked, or under another vault key", async () => {
    const r = await record();
    state.locked = true;
    await expect(voterKey()).rejects.toThrow(/locked/);
    state.locked = false;
    state.raw = new Uint8Array(32).fill(9);
    await expect(openCredential(await voterKey(), r)).rejects.toThrow();
  });
});

describe("the store", () => {
  it("keeps one credential per election, and finds it by channel, contract and ID", async () => {
    await addVoterCredential(await record());
    await expect(addVoterCredential(await record("cred-2"))).rejects.toThrow("Weft already holds a voter credential for chair-2027. It keeps one per election.");
    await addVoterCredential(await record("cred-3", "chair-2028"));
    expect((await credentialFor({ channel: "privatevote-chair-2028", chaincode: "private-ballot", electionId: "chair-2028" }))?.id).toBe("cred-3");
    expect(await credentialFor({ channel: "privatevote-chair-2027", chaincode: "other", electionId: "chair-2027" })).toBeNull();
    await removeVoterCredential("cred-1");
    expect((await voterCredentialViews()).map((v) => v.id)).toEqual(["cred-3"]);
  });

  it("refuses a record that isn't shaped as a credential", async () => {
    const r = await record();
    await expect(addVoterCredential({ ...r, sealed: undefined } as unknown as VoterCredentialRecord)).rejects.toThrow(/incomplete/);
    await expect(addVoterCredential({ ...r, invite: { ...r.invite, issuerKeyHash: "x" } })).rejects.toThrow(/incomplete/);
  });
});

describe("anonymous activity", () => {
  const activity = (patch: Partial<ActivityRecord> = {}): ActivityRecord => ({
    id: "act-1",
    at: 5,
    origin: "http://localhost:4323",
    identityId: "cred-1",
    kind: "submit",
    call: { channel: "privatevote-chair-2027", chaincode: "private-ballot", fn: "CastAnonymousBallot", args: ["chair-2027", "{}", "{}"] },
    status: "committed",
    transactionId: "d99f56fd".padEnd(64, "0"),
    blockNumber: "30",
    anonymous: { credentialId: "cred-1", mspId: "ChairVoters2027MSP", affiliation: "voters", role: "member", pseudonym: "b2aa18d1".padEnd(64, "1") },
    ...patch,
  });

  it("is sealed whole, shown only while Weft is unlocked, and marks the credential as having voted", async () => {
    await addVoterCredential(await record());
    const receipt = { channel: "privatevote-chair-2027", electionId: "chair-2027", txId: activity().transactionId!, blockNumber: 30, tracking: "7cf1a495".padEnd(64, "2"), option: "Ben Carter", keptAt: 9 };
    await saveAnonymous(await voterKey(), { activity: activity(), receipt });
    const disk = JSON.stringify([...store("anonymousActivity").values()]);
    for (const s of [receipt.txId, receipt.tracking, "Ben Carter", "b2aa18d1", "cred-1", "chair-2027"]) expect(disk).not.toContain(s);
    expect(await anonymousActivity()).toMatchObject([{ id: "act-1", receipt: true, anonymous: { credentialId: "cred-1" } }]);
    expect((await voterCredentialViews())[0]!.voted).toEqual({ blockNumber: "30" });
    expect(await anonymousReceiptView("act-1")).toMatchObject({ choice: "Ben Carter", receipt: { version: 2, tracking: receipt.tracking }, explorerUrl: "http://localhost:8790" });

    state.locked = true;
    expect(await anonymousActivity()).toEqual([]);
    expect((await voterCredentialViews())[0]!.voted).toBeNull();
    state.locked = false;

    expect(await removeAnonymousReceipt("act-1")).toBe(true);
    expect(await anonymousReceiptView("act-1")).toBeNull();
    expect((await anonymousEntries())[0]!.activity.transactionId).toBe(receipt.txId);
  });
});

describe("the port to the window's module", () => {
  function idemix() {
    const disposed: number[] = [];
    let n = 0;
    const api: Pick<IdemixApi, "newIdentity" | "sign" | "pseudonym" | "pseudonymProof" | "dispose"> = {
      newIdentity: async (cred, msp) => ({ handle: ++n, idBytes: btoa(`${msp} ${cred.enrollmentId}`), nym: "ab".repeat(64) }),
      sign: async (_h, m) => btoa(`signed ${atob(m)}`),
      pseudonym: async () => "cd".repeat(64),
      pseudonymProof: async (_h, _c, _e, t) => ({ pseudonym: "cd".repeat(64), c: t, ssk: "00", sr: "00" }),
      dispose: async (h) => {
        disposed.push(h);
        return "disposed";
      },
    };
    return { api, disposed };
  }

  it("carries the five calls, bytes as base64, and nothing else", async () => {
    const [win, bg] = portPair();
    const m = idemix();
    serveSigner(win, m.api, SECRET, "ChairVoters2027MSP");
    const signer = portSigner(bg);
    const id = await signer.newIdentity();
    expect(atob(id.idBytes)).toBe("ChairVoters2027MSP voter1");
    expect(new TextDecoder().decode(await signer.sign(id.handle, new TextEncoder().encode("proposal")))).toBe("signed proposal");
    expect(await signer.pseudonym(id.handle, "c", "e")).toBe("cd".repeat(64));
    expect((await signer.pseudonymProof(id.handle, "c", "e", "t".repeat(64))).c).toBe("t".repeat(64));
    await signer.dispose(id.handle);
    expect(m.disposed).toEqual([1]);
    // A disposed identity, or one the window never made, can't sign.
    await expect(signer.sign(id.handle, new Uint8Array([1]))).rejects.toBeInstanceOf(ModuleCallError);
    await expect(signer.sign(99, new Uint8Array([1]))).rejects.toThrow("That identity isn't one this window made, or it was disposed of.");
    // The credential's other functions aren't offered.
    const raw = await new Promise((resolve) => {
      win.onMessage.addListener(() => {});
      bg.onMessage.addListener((r) => resolve(r));
      bg.postMessage({ id: 999, method: "checkCredential", args: [] });
    });
    expect(raw).toEqual({ id: 999, error: "The voting module doesn't offer checkCredential to the background worker." });
  });

  it("disposes of the window's identities when the port closes, and fails what was waiting", async () => {
    const [win, bg] = portPair();
    const m = idemix();
    serveSigner(win, m.api, SECRET, "ChairVoters2027MSP");
    const signer = portSigner(bg);
    const id = await signer.newIdentity();
    bg.disconnect();
    await new Promise((r) => setTimeout(r, 0));
    expect(m.disposed).toEqual([id.handle]);
    win.disconnect();
    expect(signer.gone).toBe(true);
    await expect(signer.newIdentity()).rejects.toBeInstanceOf(SignerGoneError);
  });
});
