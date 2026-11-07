/**
 * The test vectors in vectors/v1, which the contract's Go tests read too.
 * Each case is checked through the public API, independently of the
 * generator, and the generator must reproduce every file byte for byte.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha512 } from "@noble/hashes/sha2.js";
import { expand_message_xmd } from "@noble/curves/abstract/hash-to-curve.js";
import { VECTORS_DIR, generateVectors } from "../scripts/vectors.ts";
import {
  Hs,
  ballotJson,
  challengeBytes,
  contextParts,
  electionContext,
  electionFingerprint,
  fingerprintInput,
  formatFingerprint,
  frame,
  fromHex,
  openShare,
  proveBallot,
  toHex,
  utf8,
  voterTagIdemix,
  voterTagX509,
  type Ballot,
  type Ciphertext,
  type Election,
  type Part,
} from "./testing.ts";
import {
  TallyError,
  addTotals,
  checkBallot,
  checkConfirmation,
  checkDecryptionShare,
  checkRound1,
  checkRound2,
  electionKeys,
  recoverTally,
  type Ledger,
} from "./verify.ts";
import { Fn, G, decodePoint, decodeScalar, mulPub, scalarFromLE } from "./group.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const read = (name: string): any => JSON.parse(readFileSync(join(VECTORS_DIR, name), "utf8"));
const hex = (h: string) => fromHex(h)!;
const part = (p: any): Part => ("string" in p ? p.string : "int" in p ? p.int : hex(p.bytes));

const context = read("context.json");
const elections: Record<string, Election> = Object.fromEntries(
  context.elections.map((e: any) => [e.name, { channel: e.channel, chaincode: e.chaincode, electionId: e.electionId, options: e.options, threshold: e.threshold, trustees: e.trustees, publicKey: e.publicKey, verifyingShares: e.verifyingShares }]),
);

function refusal(f: () => unknown): string {
  try {
    f();
  } catch (x) {
    if (x instanceof TallyError) return x.message;
    throw x;
  }
  return "accepted";
}

describe("regenerating the vectors", () => {
  it("changes no file", async () => {
    const files = await generateVectors();
    expect(Object.keys(files).sort()).toEqual(["ballots.json", "ceremony.json", "context.json", "framing.json", "negative.json", "shares.json", "tally.json", "tracking.json"]);
    for (const [name, text] of Object.entries(files)) expect(text, name).toBe(readFileSync(join(VECTORS_DIR, name), "utf8"));
  });
});

describe("framing.json", () => {
  const v = read("framing.json");
  it("frames parts", () => {
    for (const c of v.frame) expect(toHex(frame(c.parts.map(part)))).toBe(c.framed);
  });
  it("expands messages with SHA-512", () => {
    for (const c of v.expandMessageXmd) expect(toHex(expand_message_xmd(hex(c.msg), utf8(c.dst), c.length, sha512))).toBe(c.output);
  });
  it("hashes to scalars", () => {
    for (const c of v.hs) {
      const parts = c.parts.map(part);
      expect(toHex(frame([c.label, ...parts]))).toBe(c.input);
      expect(toHex(challengeBytes(c.label, parts))).toBe(c.xmd);
      expect(toHex(Fn.toBytes(Hs(c.label, parts)))).toBe(c.scalar);
    }
  });
});

describe("context.json", () => {
  it("gives each election's context and fingerprint", () => {
    for (const c of context.elections) {
      const e = elections[c.name]!;
      expect(toHex(frame(contextParts(e)))).toBe(c.contextInput);
      expect(toHex(electionContext(e))).toBe(c.ctx);
      expect(toHex(fingerprintInput(e))).toBe(c.fingerprintInput);
      expect(electionFingerprint(e)).toBe(c.fingerprint);
      expect(formatFingerprint(c.fingerprint)).toBe(c.display);
    }
  });
  it("gives voter tags bound to the channel and election", () => {
    for (const t of context.voterTags) {
      const tag = t.kind === "x509" ? voterTagX509(t.channel, t.electionId, t.mspId, hex(t.idBytes)) : voterTagIdemix(t.channel, t.electionId, t.mspId, hex(t.pseudonym));
      expect(toHex(tag)).toBe(t.tag);
    }
    const ada = context.voterTags.filter((t: any) => t.name === "ada");
    expect(ada).toHaveLength(2);
    expect(ada[0].tag).not.toBe(ada[1].tag);
  });
  it("sorts the trustees' MSP IDs for the fingerprint", () => {
    const e = elections["council-2027"]!;
    const swapped = { ...e, trustees: [...e.trustees].reverse() };
    expect(electionFingerprint(swapped)).toBe(electionFingerprint(e));
    expect(electionFingerprint({ ...e, trustees: e.trustees.map((m, i) => (i === 0 ? "Org9MSP" : m)) })).not.toBe(electionFingerprint(e));
    expect(electionFingerprint({ ...e, closesAt: "2030-01-01T00:00:00.000Z", title: "Another" } as Election)).toBe(electionFingerprint(e));
  });
});

describe("ceremony.json", () => {
  const v = read("ceremony.json");
  it("checks every round, derives the key and opens every share", async () => {
    for (const c of v.ceremonies) {
      const e = elections[c.election]!;
      const r1 = c.trustees.map((t: any) => {
        const r = checkRound1(e, t.index, t.round1.json);
        expect(toHex(r.R.toBytes())).toBe(t.round1.proofR);
        return r;
      });
      expect(electionKeys(e, r1)).toEqual({ publicKey: c.publicKey, verifyingShares: c.verifyingShares });
      expect(toHex(electionContext(e))).toBe(c.ctx);
      expect(electionFingerprint(e)).toBe(c.fingerprint);
      for (const t of c.trustees) {
        expect(toHex(Fn.toBytes(scalarFromLE(sha512(hex(t.round1.challengeInput)))))).toBe(t.round1.challenge);
        expect(t.round1.coefficients.map((a: string) => toHex(G.multiply(decodeScalar(hex(a))!).toBytes()))).toEqual(t.round1.post.commitments);
        expect(toHex(G.multiply(decodeScalar(hex(t.round1.proofNonce))!).toBytes())).toBe(t.round1.proofR);
        checkRound2(e, t.index, t.round2.json);
        for (const b of t.round2.boxes) {
          const y = await openShare(hex(b.key), hex(b.info), hex(b.nonce), hex(b.box));
          expect(y).not.toBeNull();
          expect(toHex(Fn.toBytes(y!))).toBe(b.y);
        }
        checkConfirmation(e, t.index, t.round3.json);
        expect(toHex(G.multiply(decodeScalar(hex(t.round3.share))!).toBytes())).toBe(t.round3.verifyingShare);
      }
    }
  });
});

describe("ballots.json and tracking.json", () => {
  const v = read("ballots.json");
  it("accepts every ballot with the recorded commitments and tracking code", () => {
    const seen = new Set<string>();
    const voted = new Set<string>();
    const ledger: Ledger = { hasCiphertext: (a) => seen.has(a), hasVoted: (t) => voted.has(t) };
    for (const b of v.ballots) {
      const e = elections[b.election]!;
      const checked = checkBallot(e, hex(b.voter.tag), b.json, ledger, b.voter.kind);
      expect(checked.trace).toEqual(b.trace);
      expect(checked.tracking).toBe(b.tracking);
      checked.ciphertexts.forEach((a) => seen.add(a));
      voted.add(b.voter.tag);
    }
  });
  it("reproduces every ballot from its recorded randomness", () => {
    for (const b of v.ballots) {
      const e = elections[b.election]!;
      const s = (h: string) => decodeScalar(hex(h))!;
      const rnd = { r: b.randomness.r.map(s), bits: b.randomness.bits.map((x: any) => ({ cs: s(x.cs), zs: s(x.zs), w: s(x.w) })), w: s(b.randomness.w) };
      const m = e.options.map((_, j) => (j === b.choice ? 1 : 0));
      const out = proveBallot(e, hex(b.voter.tag), m, rnd);
      expect(ballotJson(out.ballot)).toBe(b.json);
      expect(out.tracking).toBe(b.tracking);
    }
  });
  it("frames the tracking code's input", () => {
    for (const t of read("tracking.json").tracking) {
      const e = elections[t.election]!;
      expect(t.input.startsWith(toHex(frame(["weft-ballot-hash v1", electionContext(e)])))).toBe(true);
      expect(checkBallot(e, hex(t.voterTag), t.json).tracking).toBe(t.tracking);
    }
  });
});

describe("shares.json and tally.json", () => {
  const v = read("shares.json");
  const totals: Record<string, { totals: Ciphertext[]; ballots: number }> = Object.fromEntries(v.totals.map((t: any) => [t.election, t]));
  it("adds up the ballots", () => {
    const ballots = read("ballots.json").ballots as { election: string; ballot: Ballot }[];
    for (const [name, t] of Object.entries(totals)) {
      expect(addTotals(elections[name]!.options.length, ballots.filter((b) => b.election === name).map((b) => b.ballot.ciphertexts))).toEqual({ totals: t.totals, ballots: t.ballots });
    }
  });
  it("accepts every decryption share", () => {
    for (const s of v.shares) {
      const e = elections[s.election]!;
      checkDecryptionShare(e, totals[s.election]!.totals, s.index, s.json);
      // D = s_i·A_j
      s.share.shares.forEach((d: any, j: number) => {
        const A = decodePoint(hex(totals[s.election]!.totals[j]!.a))!;
        expect(toHex(mulPub(A, decodeScalar(hex(s.keyShare))!).toBytes())).toBe(d.d);
      });
    }
  });
  it("recovers the same counts from every quorum", () => {
    const shares = v.shares as { election: string; index: number; share: any }[];
    for (const t of read("tally.json").tally) {
      const posted = t.posted.map((i: number) => ({ index: i, share: shares.find((s) => s.election === t.election && s.index === i)!.share }));
      const r = recoverTally(elections[t.election]!, t.totals, t.ballots, posted);
      expect(r).toEqual({ quorum: t.quorum, lambdas: t.lambdas, M: t.M, counts: t.counts, total: t.total });
    }
  });
});

describe("negative.json", () => {
  const v = read("negative.json");
  for (const c of v.negative) {
    it(`refuses ${c.kind}: ${c.name}`, () => {
      const e = elections[c.election]!;
      let message: string;
      switch (c.kind) {
        case "ballot": {
          const ledger: Ledger = { hasCiphertext: (a) => c.ledger.ciphertexts.includes(a), hasVoted: (t) => c.ledger.voted.includes(t) };
          message = refusal(() => checkBallot(e, hex(c.voterTag), c.json, ledger, c.voter));
          break;
        }
        case "round1":
          message = refusal(() => checkRound1(e, c.index, c.json));
          break;
        case "round2":
          message = refusal(() => checkRound2(e, c.index, c.json));
          break;
        case "confirm":
          message = refusal(() => checkConfirmation(e, c.index, c.json));
          break;
        case "dshare":
          message = refusal(() => checkDecryptionShare(e, c.totals, c.index, c.json));
          break;
        case "tally":
          message = refusal(() => recoverTally(e, c.totals, c.ballots, c.posted));
          break;
        default:
          throw new Error(`unknown kind ${c.kind}`);
      }
      expect(message).toBe(c.error);
    });
  }
  it("covers the prototype's eight refusals", () => {
    const names = v.negative.map((c: any) => c.name);
    for (const n of ["a ballot sent by another voter", "a repeated ballot", "a slot holding 2", "two options chosen", "a ballot under another key", "a changed bit proof value", "a share made with another key", "a tally from one organisation alone"]) {
      expect(names).toContain(n);
    }
  });
});
