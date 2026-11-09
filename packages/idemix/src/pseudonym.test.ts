/**
 * The pseudonym vectors, which the contract's Go tests write and check
 * (contracts/private-ballot/pseudonym/testdata/v1), through the
 * WebAssembly build of the same Go package: a test build with
 * pseudonymVector reproduces every positive vector byte for byte from its
 * fixed inputs, and the contract's verifier, called from Node, accepts the
 * positive vectors and refuses each negative one with its message.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex, startModule } from "./module.ts";
import { DIST_WASM } from "./node.ts";
import { verifyPseudonym } from "./test/tool.ts";

const skip = process.env.WEFT_IDEMIX_SKIP;
const vectorsFile = fileURLToPath(new URL("../../../contracts/private-ballot/pseudonym/testdata/v1/pseudonym.json", import.meta.url));

interface Issuer {
  name: string;
  issuerPublicKey: string;
}
interface Positive {
  name: string;
  issuer: string;
  channel: string;
  electionId: string;
  tracking: string;
  sk: string;
  rNym: string;
  a: string;
  b: string;
  nym: string;
  B: string;
  P: string;
  T1: string;
  T2: string;
  challengeInput: string;
  c: string;
  ssk: string;
  sr: string;
  pseudonymJson: string;
}
interface Negative {
  name: string;
  issuer: string;
  channel: string;
  electionId: string;
  tracking: string;
  nym: string;
  pseudonymJson: string;
  error: string;
}
interface Vectors {
  issuers: Issuer[];
  positive: Positive[];
  negative: Negative[];
}

const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");

/** A SerializedIdemixIdentity with only nym_x (1) and nym_y (2), the part the verifier reads. */
function idBytes(nym: string): string {
  const n = Buffer.from(nym, "hex");
  return Buffer.concat([Buffer.from([0x0a, 32]), n.subarray(0, 32), Buffer.from([0x12, 32]), n.subarray(32)]).toString("base64");
}

type VectorFn = (json: string) => string;

describe.skipIf(skip)("the pseudonym vectors through the WebAssembly module", () => {
  let vectors: Vectors;
  let pseudonymVector: VectorFn;
  const keyOf = (name: string) => vectors.issuers.find((i) => i.name === name)!.issuerPublicKey;

  beforeAll(async () => {
    vectors = JSON.parse(await readFile(vectorsFile, "utf8")) as Vectors;
    await import(pathToFileURL(join(DIST_WASM, "wasm_exec.js")).href);
    const path = process.env.WEFT_IDEMIX_VECTORS_WASM;
    if (!path) throw new Error("The test build of the module wasn't built.");
    const bytes = new Uint8Array(await readFile(path));
    await startModule(bytes, await sha256Hex(bytes));
    pseudonymVector = (globalThis as unknown as { weftIdemix: { pseudonymVector: VectorFn } }).weftIdemix.pseudonymVector;
  });

  it("reproduces every positive vector from its fixed inputs", () => {
    expect(vectors.positive.length).toBeGreaterThanOrEqual(4);
    for (const v of vectors.positive) {
      const out = JSON.parse(
        pseudonymVector(JSON.stringify({ issuerPublicKey: keyOf(v.issuer), channel: v.channel, electionId: v.electionId, tracking: v.tracking, sk: v.sk, rNym: v.rNym, a: v.a, b: v.b })),
      ) as { ok: Record<string, unknown> };
      expect(out.ok, v.name).toEqual({
        nym: v.nym,
        B: v.B,
        P: v.P,
        T1: v.T1,
        T2: v.T2,
        challengeInput: v.challengeInput,
        c: v.c,
        ssk: v.ssk,
        sr: v.sr,
        proof: JSON.parse(v.pseudonymJson),
      });
      expect(JSON.stringify(out.ok.proof)).toBe(v.pseudonymJson);
    }
  });

  it("has the contract's verifier accept each positive vector", () => {
    for (const v of vectors.positive) {
      const got = verifyPseudonym({ issuerPublicKey: b64(keyOf(v.issuer)), idBytes: idBytes(v.nym), channel: v.channel, electionId: v.electionId, tracking: v.tracking, pseudonymJson: v.pseudonymJson });
      expect(got, v.name).toEqual({ ok: { pseudonym: v.P } });
    }
  });

  it("has the contract's verifier refuse each negative vector past parsing with its message", () => {
    // Parsing's own messages come from the contract's strict JSON parser,
    // which the Go tests check; here, decoding and verifying.
    const past = vectors.negative.filter((v) => v.error.startsWith("The pseudonym proof's ") || v.error === "The pseudonym proof is not valid.");
    expect(past.length).toBeGreaterThanOrEqual(20);
    for (const v of past) {
      const got = verifyPseudonym({ issuerPublicKey: b64(keyOf(v.issuer)), idBytes: idBytes(v.nym), channel: v.channel, electionId: v.electionId, tracking: v.tracking, pseudonymJson: v.pseudonymJson });
      expect(got, v.name).toEqual({ error: v.error });
    }
  });
});
