/**
 * The WebAssembly module in Node, against the Go test tool: the module
 * enrols with a scratch issuer as with Fabric CA, makes identities and
 * signs, and IBM idemix's own MSP, set up as a peer sets it up, accepts the
 * signatures. Prints the timings.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { IdemixError, startModule, type IdemixApi, type VoterCredentialSecret } from "./module.ts";
import { DIST_WASM, startIdemixNode } from "./node.ts";
import { PINNED } from "./pinned.ts";
import { issue, newIssuer, verify, verifyPseudonym, type ScratchIssuer } from "./test/tool.ts";

const skip = process.env.WEFT_IDEMIX_SKIP;
const mspId = "ChairVoters2027MSP";
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** A SerializedIdentity, the transaction's creator: mspid (1) and id_bytes (2). */
function creator(msp: string, idBytes: Uint8Array): string {
  const field = (tag: number, value: Uint8Array) => {
    const len: number[] = [];
    for (let n = value.length; ; n >>>= 7) {
      if (n < 0x80) {
        len.push(n);
        break;
      }
      len.push((n & 0x7f) | 0x80);
    }
    return Buffer.concat([Buffer.from([tag]), Buffer.from(len), Buffer.from(value)]);
  };
  return b64(Buffer.concat([field(0x0a, new TextEncoder().encode(msp)), field(0x12, idBytes)]));
}

const timings: Record<string, string> = {};
const ms = (n: number) => `${n.toFixed(0)} ms`;
async function timed<T>(name: string, f: () => Promise<T>): Promise<T> {
  const t = performance.now();
  const out = await f();
  timings[name] = ms(performance.now() - t);
  return out;
}

describe.skipIf(skip)("the idemix module in Node", () => {
  let api: IdemixApi;
  let issuer: ScratchIssuer;
  let credential: VoterCredentialSecret;

  beforeAll(async () => {
    const t = performance.now();
    const started = await startIdemixNode();
    timings.start = `${ms(performance.now() - t)} (read ${ms(started.timings.read)}, hash ${ms(started.timings.hash)}, compile ${ms(started.timings.compile)}, run ${ms(started.timings.run)})`;
    api = started.api;
    issuer = newIssuer();
  });

  it("reports its build", async () => {
    const info = await api.info();
    expect(info).toEqual({ api: 2, curve: "FP256BN_AMCL", go: PINNED.go, idemix: PINNED.idemix, mathlib: PINNED.mathlib });
  });

  it("loads an issuer key and gives issuerKeyHash as SHA-256 of its bytes", async () => {
    const out = await timed("load issuer key", () => api.loadIssuerKey(issuer.issuerPublicKey));
    expect(out.issuerKeyHash).toBe(createHash("sha256").update(unb64(issuer.issuerPublicKey)).digest("hex"));
  });

  it("enrols as with Fabric CA, and checks the credential", async () => {
    const req = await timed("credential request", () => api.credentialRequest(issuer.nonce));
    expect(unb64(req.secretKey)).toHaveLength(32);
    const issued = issue(issuer, { nonce: issuer.nonce, request: req.request, ou: "voters", role: 1, enrollmentId: "voter1" });
    credential = { secretKey: req.secretKey, credential: issued.credential, cri: issued.cri, ou: "voters", role: 1, enrollmentId: "voter1" };
    await expect(timed("check credential", () => api.checkCredential(credential))).resolves.toBe("valid");
  });

  it("refuses a credential whose attributes or key differ", async () => {
    for (const changed of [
      { ...credential, ou: "org1" },
      { ...credential, role: 2 },
      { ...credential, enrollmentId: "voter2" },
      { ...credential, secretKey: (await api.credentialRequest(issuer.nonce)).secretKey },
    ]) {
      await expect(api.checkCredential(changed)).rejects.toThrow(/doesn't check out/);
      await expect(api.newIdentity(changed, mspId)).rejects.toThrow(IdemixError);
    }
  });

  it("signs messages that IBM's idemix MSP accepts, and no other message", async () => {
    const id = await timed("new identity", () => api.newIdentity(credential, mspId));
    const message = new TextEncoder().encode("the proposal bytes Weft signs");
    const signature = await timed("sign", () => api.sign(id.handle, b64(message)));
    const input = { mspId, issuerPublicKey: issuer.issuerPublicKey, revocationPublicKey: issuer.revocationPublicKey, creator: creator(mspId, unb64(id.idBytes)) };
    expect(verify({ ...input, message: b64(message), signature })).toEqual({ ok: { mspId, ou: "voters", role: "MEMBER" } });
    const other = verify({ ...input, message: b64(new TextEncoder().encode("another message")), signature });
    expect(other.error).toMatch(/verify/);
    expect(Buffer.from(unb64(id.idBytes)).includes(Buffer.from("voter1"))).toBe(false);
    expect(id.nym).toMatch(/^[0-9a-f]{128}$/);
    await api.dispose(id.handle);
  });

  it("makes a new Nym for every identity, and signs nothing once disposed of", async () => {
    const a = await api.newIdentity(credential, mspId);
    const b = await api.newIdentity(credential, mspId);
    expect(a.nym).not.toBe(b.nym);
    await expect(api.dispose(a.handle)).resolves.toBe("disposed");
    await expect(api.sign(a.handle, b64(new Uint8Array([1])))).rejects.toThrow(`there's no identity ${a.handle}`);
    await expect(api.sign(b.handle, b64(new Uint8Array([1])))).resolves.toMatch(/^[A-Za-z0-9+/]+=*$/);
    await expect(api.wipe()).resolves.toBe("wiped");
    await expect(api.sign(b.handle, b64(new Uint8Array([1])))).rejects.toThrow(IdemixError);
    await expect(api.newIdentity(credential, mspId)).rejects.toThrow(/no issuer key is loaded/);
    await api.loadIssuerKey(issuer.issuerPublicKey);
  });

  it("makes a per-election pseudonym that the contract's verifier accepts, for its own Nym and ballot only", async () => {
    const tracking = createHash("sha256").update("a ballot").digest("hex");
    const other = createHash("sha256").update("another ballot").digest("hex");
    const a = await api.newIdentity(credential, mspId);
    const b = await api.newIdentity(credential, mspId);
    const proofA = await timed("pseudonym", () => api.pseudonymProof(a.handle, "privatevote-chair-2027", "chair-2027", tracking));
    const proofB = await api.pseudonymProof(b.handle, "privatevote-chair-2027", "chair-2027", tracking);
    const proofC = await api.pseudonymProof(a.handle, "privatevote-chair-2028", "chair-2028", tracking);
    for (const p of [proofA, proofB, proofC]) {
      expect(p.pseudonym).toMatch(/^[0-9a-f]{128}$/);
      for (const s of [p.c, p.ssk, p.sr]) expect(s).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(p)).toHaveLength(360);
    }
    // One credential has one pseudonym per election, under every Nym, and
    // pseudonym gives it before the ballot is made.
    expect(proofB.pseudonym).toBe(proofA.pseudonym);
    expect(await api.pseudonym(b.handle, "privatevote-chair-2027", "chair-2027")).toBe(proofA.pseudonym);
    expect(await api.pseudonym(a.handle, "privatevote-chair-2028", "chair-2028")).toBe(proofC.pseudonym);
    expect(proofC.pseudonym).not.toBe(proofA.pseudonym);
    expect(proofB.c).not.toBe(proofA.c);

    const check = (idBytes: string, proof: object, over: Partial<{ channel: string; electionId: string; tracking: string }> = {}) =>
      verifyPseudonym({ issuerPublicKey: issuer.issuerPublicKey, idBytes, channel: "privatevote-chair-2027", electionId: "chair-2027", tracking, pseudonymJson: JSON.stringify(proof), ...over });
    expect(check(a.idBytes, proofA)).toEqual({ ok: { pseudonym: proofA.pseudonym } });
    expect(check(b.idBytes, proofB)).toEqual({ ok: { pseudonym: proofA.pseudonym } });
    expect(check(a.idBytes, proofC, { channel: "privatevote-chair-2028", electionId: "chair-2028" }).ok).toBeDefined();
    const notValid = { error: "The pseudonym proof is not valid." };
    expect(check(b.idBytes, proofA)).toEqual(notValid); // replayed with another Nym
    expect(check(a.idBytes, proofA, { tracking: other })).toEqual(notValid);
    expect(check(a.idBytes, proofA, { electionId: "chair-2028" })).toEqual(notValid);
    expect(check(a.idBytes, proofA, { channel: "privatevote-other" })).toEqual(notValid);
    expect(check(a.idBytes, { ...proofA, sr: proofB.sr })).toEqual(notValid);
    expect(check(a.idBytes, { ...proofA, c: "F".repeat(64) })).toEqual({ error: "The pseudonym proof's c isn't a canonical scalar." });

    await expect(api.pseudonymProof(a.handle, "privatevote-chair-2027", "chair-2027", tracking.toUpperCase())).rejects.toThrow("tracking must be 64 lowercase hex characters");
    await expect(api.pseudonymProof(a.handle, "privatevote-chair-2027", "chair-2027", tracking.slice(2))).rejects.toThrow("tracking must be 64 lowercase hex characters");
    await api.dispose(a.handle);
    await expect(api.pseudonymProof(a.handle, "privatevote-chair-2027", "chair-2027", tracking)).rejects.toThrow(`there's no identity ${a.handle}`);
    await api.dispose(b.handle);
  });

  it("times a vote's signing: one identity, its pseudonym and three signatures", async () => {
    const t = performance.now();
    const id = await api.newIdentity(credential, mspId);
    await api.pseudonym(id.handle, "privatevote-chair-2027", "chair-2027");
    await api.pseudonymProof(id.handle, "privatevote-chair-2027", "chair-2027", "00".repeat(32));
    for (const part of ["proposal", "transaction", "commit status"]) await api.sign(id.handle, b64(new TextEncoder().encode(part)));
    await api.dispose(id.handle);
    timings["identity, pseudonym and 3 signatures"] = ms(performance.now() - t);
    console.log("Timings in Node:", timings);
  });

  it("refuses to start a module that isn't the pinned one", async () => {
    const bytes = new Uint8Array(await readFile(join(DIST_WASM, "weft-idemix.wasm")));
    bytes[0] = 0xff;
    await expect(startModule(bytes)).rejects.toThrow(/, not the pinned /);
  });
});
