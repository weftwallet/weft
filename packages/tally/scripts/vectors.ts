/**
 * Writes packages/tally/vectors/v1/*.json from fixed seeds. Running it again
 * changes no file; src/vectors.test.ts checks that, and the contract's Go
 * tests read the same files.
 *
 *   pnpm --filter @weftwallet/tally vectors
 *
 * Every random value comes from seededRandom(seed) in src/testing.ts, with
 * one seed per step, so adding a vector doesn't change the others.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ristretto255 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { expand_message_xmd } from "@noble/curves/abstract/hash-to-curve.js";
import {
  DST,
  LABELS,
  ballotJson,
  challengeBytes,
  choiceMessages,
  contextParts,
  decryptionShareWith,
  drawBallotRandomness,
  electionContext,
  electionFingerprint,
  fingerprintInput,
  formatFingerprint,
  frame,
  fromHex,
  Hs,
  proveBallot,
  round1With,
  round2With,
  round3With,
  seededRandom,
  shareInfo,
  shareKey,
  toHex,
  trusteeId,
  utf8,
  voterTagIdemix,
  voterTagX509,
  type Ballot,
  type Ciphertext,
  type DecryptionSharePost,
  type Election,
  type ElectionSetup,
  type KeyShare,
  type Part,
  type RandomSource,
  type Round1Post,
  type Round2Post,
} from "../src/testing.ts";
import {
  addTotals,
  checkBallot,
  checkConfirmation as checkConfirmationExported,
  checkDecryptionShare,
  checkRound1,
  checkRound2 as checkRound2Exported,
  recoverTally,
  round1Challenge,
  TallyError,
  type Ledger,
} from "../src/verify.ts";

const P = ristretto255.Point;
const Fn = P.Fn;
const G = P.BASE;
const shex = (s: bigint) => toHex(Fn.toBytes(Fn.create(s)));
const le = (b: Uint8Array) => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);
const hexBytes = (h: string) => fromHex(h)!;

/** Wraps a source and keeps every draw, for the vectors' record of randomness. */
function recorder(rand: RandomSource) {
  const draws: string[] = [];
  return {
    draws,
    bytes(n: number) {
      const b = rand.bytes(n);
      draws.push(toHex(b));
      return b;
    },
  };
}

/* ---------- the elections ---------- */

const SETUPS: Record<string, ElectionSetup> = {
  "budget-2027": {
    channel: "privatevote-budget-2027",
    chaincode: "private-ballot",
    electionId: "budget-2027",
    options: ["Plan A", "Plan B", "Plan C"],
    threshold: 2,
    trustees: ["Org1MSP", "Org2MSP", "Org3MSP"],
  },
  "council-2027": {
    channel: "privatevote-council-2027",
    chaincode: "private-ballot",
    electionId: "council-2027",
    options: Array.from({ length: 10 }, (_, i) => `Candidate ${i + 1}`),
    threshold: 3,
    // Not in sorted order, so the fingerprint's sorting is visible.
    trustees: ["Org2MSP", "Org1MSP", "Org4MSP", "Org3MSP"],
  },
  "referendum-2027": {
    channel: "privatevote-referendum-2027",
    chaincode: "private-ballot",
    electionId: "referendum-2027",
    options: ["Yes", "No"],
    threshold: 2,
    trustees: ["Org1MSP", "Org2MSP"],
  },
};

/** Synthetic PEM: the tag hashes the bytes Fabric carries, so a real certificate isn't needed. */
const pem = (name: string) => `-----BEGIN CERTIFICATE-----\n${Buffer.from(`test certificate for ${name}, not a real one`).toString("base64")}\n-----END CERTIFICATE-----\n`;

interface Voter {
  name: string;
  kind: "x509" | "idemix";
  mspId: string;
  /** idBytes for X.509, the 64-byte pseudonym P for idemix */
  bytes: Uint8Array;
}

function x509(name: string, mspId: string): Voter {
  return { name, kind: "x509", mspId, bytes: utf8(pem(name)) };
}

function tagOf(setup: ElectionSetup, v: Voter): Uint8Array {
  return v.kind === "x509" ? voterTagX509(setup.channel, setup.electionId, v.mspId, v.bytes) : voterTagIdemix(setup.channel, setup.electionId, v.mspId, v.bytes);
}

const VOTERS = {
  ada: x509("ada", "Org1MSP"),
  grace: x509("grace", "Org2MSP"),
  alan: x509("alan", "Org1MSP"),
  edsger: x509("edsger", "Org2MSP"),
  barbara: x509("barbara", "Org1MSP"),
  // A voter credential's per-election pseudonym is 64 bytes; this one is made up.
  anon: { name: "anon", kind: "idemix", mspId: "ChairVoters2027MSP", bytes: sha512(utf8("test pseudonym, not a real one")) } as Voter,
};

/** Who votes for what (0-based) in each election. */
const CAST: Record<string, [Voter, number][]> = {
  "budget-2027": [
    [VOTERS.ada, 0],
    [VOTERS.grace, 1],
    [VOTERS.alan, 1],
    [VOTERS.edsger, 1],
    [VOTERS.barbara, 2],
  ],
  "council-2027": [
    [VOTERS.ada, 9],
    [VOTERS.grace, 0],
    [VOTERS.alan, 4],
    [VOTERS.edsger, 9],
  ],
  "referendum-2027": [
    [VOTERS.ada, 0],
    [VOTERS.anon, 1],
    [VOTERS.grace, 0],
  ],
};

/* ---------- the ceremony ---------- */

interface Ceremony {
  setup: ElectionSetup;
  election: Election;
  round1: Round1Post[];
  round2: Round2Post[];
  keyShares: KeyShare[];
  record: unknown;
}

async function runCeremony(name: string, setup: ElectionSetup): Promise<Ceremony> {
  const n = setup.trustees.length;
  const r1 = setup.trustees.map((_, i) => {
    const seed = `v1 ${name} round1 ${i}`;
    const rec = recorder(seededRandom(seed));
    const out = round1With(setup, i, rec);
    return { ...out, seed, draws: rec.draws };
  });
  const round1 = r1.map((r) => r.post);
  const r2: { post: Round2Post; seed: string; draws: string[] }[] = [];
  for (let i = 0; i < n; i++) {
    const seed = `v1 ${name} round2 ${i}`;
    const rec = recorder(seededRandom(seed));
    r2.push({ post: await round2With(setup, r1[i]!.secret, round1, rec), seed, draws: rec.draws });
  }
  const round2 = r2.map((r) => r.post);
  const r3: (Awaited<ReturnType<typeof round3With>> & { seed: string; draws: string[] })[] = [];
  for (let i = 0; i < n; i++) {
    const seed = `v1 ${name} round3 ${i}`;
    const rec = recorder(seededRandom(seed));
    r3.push({ ...(await round3With(setup, r1[i]!.secret, round1, round2, rec)), seed, draws: rec.draws });
  }
  const keys = r3[0]!.keys;
  const election: Election = { ...setup, ...keys };
  const ctx = electionContext(election);
  const record = {
    election: name,
    trustees: r1.map((r, i) => {
      const k = setup.threshold;
      const proof = hexBytes(r.post.proof);
      const R = P.fromBytes(proof.subarray(0, 32));
      const C0 = P.fromBytes(hexBytes(r.post.commitments[0]!));
      return {
        index: i,
        id: toHex(trusteeId(i)),
        msp: setup.trustees[i],
        round1: {
          seed: r.seed,
          draws: r.draws,
          // noble maps each 48-byte draw to a scalar in 1 to l - 1: (LE(draw) mod (l - 1)) + 1.
          coefficients: r.secret.coefficients,
          proofNonce: shex((le(hexBytes(r.draws[k]!)) % (Fn.ORDER - 1n)) + 1n),
          ceremonySecret: r.secret.ceremonyKey,
          post: r.post,
          json: JSON.stringify(r.post),
          proofR: toHex(R.toBytes()),
          proofZ: toHex(proof.subarray(32)),
          challengeInput: toHex(new Uint8Array([...utf8("FROST-RISTRETTO255-SHA512-v1dkg"), ...trusteeId(i), ...C0.toBytes(), ...R.toBytes()])),
          challenge: shex(round1Challenge(i, C0, R)),
        },
        round2: {
          seed: r2[i]!.seed,
          draws: r2[i]!.draws,
          post: r2[i]!.post,
          json: JSON.stringify(r2[i]!.post),
          boxes: r2[i]!.post.shares.map((s) => {
            const j = setup.trustees.findIndex((_, t) => toHex(trusteeId(t)) === s.to);
            const e = le(hexBytes(r.secret.ceremonyKey));
            const Ej = P.fromBytes(hexBytes(round1[j]!.ceremonyKey));
            // y_ij = f_i(id_j)
            let y = 0n;
            let pow = 1n;
            for (const a of r.secret.coefficients) {
              y = Fn.add(y, Fn.mul(le(hexBytes(a)), pow));
              pow = Fn.mul(pow, BigInt(j + 1));
            }
            return {
              to: j,
              K: toHex(Ej.multiply(e).toBytes()),
              info: toHex(shareInfo(setup, i, j)),
              key: toHex(shareKey(setup, i, j, e, Ej)),
              nonce: s.nonce,
              y: shex(y),
              box: s.box,
            };
          }),
        },
        round3: {
          seed: r3[i]!.seed,
          draws: r3[i]!.draws,
          share: r3[i]!.keyShare.share,
          verifyingShare: keys.verifyingShares[i],
          confirmationNonce: shex(le(hexBytes(r3[i]!.draws[0]!))),
          confirmation: r3[i]!.confirmation,
          json: JSON.stringify(r3[i]!.confirmation),
        },
      };
    }),
    publicKey: keys.publicKey,
    verifyingShares: keys.verifyingShares,
    ctx: toHex(ctx),
    fingerprint: electionFingerprint(election),
  };
  return { setup, election, round1, round2, keyShares: r3.map((r) => r.keyShare), record };
}

/* ---------- writing ---------- */

const partJson = (p: Part) => (typeof p === "string" ? { string: p } : typeof p === "number" ? { int: p } : { bytes: toHex(p) });

function setupJson(name: string, s: ElectionSetup) {
  return { name, channel: s.channel, chaincode: s.chaincode, electionId: s.electionId, options: s.options, threshold: s.threshold, trustees: s.trustees };
}

function voterJson(setup: ElectionSetup, v: Voter) {
  return { name: v.name, kind: v.kind, mspId: v.mspId, [v.kind === "x509" ? "idBytes" : "pseudonym"]: toHex(v.bytes), tag: toHex(tagOf(setup, v)) };
}

function modify<T>(x: T, f: (y: T) => void): T {
  const y = structuredClone(x);
  f(y);
  return y;
}

export async function generateVectors(): Promise<Record<string, string>> {
  const ceremonies: Record<string, Ceremony> = {};
  for (const [name, setup] of Object.entries(SETUPS)) ceremonies[name] = await runCeremony(name, setup);

  /* framing.json */
  const framingCases: Part[][] = [[], [""], ["weft"], [0], [1, 4294967295], [new Uint8Array(0), new Uint8Array([0, 255])], ["Plan A", 3, utf8("é")]];
  const challengeCases: [string, Part[]][] = [
    [LABELS.bit, []],
    [LABELS.sum, [new Uint8Array(32), 0]],
    [LABELS.confirm, ["budget-2027", 7, new Uint8Array(32).fill(255)]],
  ];
  const framing = {
    description: "frame(), expand_message_xmd with SHA-512 and Hs(). DST for Hs is " + DST + ".",
    frame: framingCases.map((parts) => ({ parts: parts.map(partJson), framed: toHex(frame(parts)) })),
    expandMessageXmd: [
      ["", "QUUX-V01-CS02-with-expander-SHA512-256", 32],
      ["abc", "QUUX-V01-CS02-with-expander-SHA512-256", 32],
      ["abcdef0123456789", "QUUX-V01-CS02-with-expander-SHA512-256", 128],
      ["", DST, 64],
      ["", "x".repeat(255), 64],
    ].map(([msg, dst, len]) => ({ msg: toHex(utf8(msg as string)), dst, length: len, output: toHex(expand_message_xmd(utf8(msg as string), utf8(dst as string), len as number, sha512)) })),
    hs: challengeCases.map(([label, parts]) => ({
      label,
      parts: parts.map(partJson),
      input: toHex(frame([label, ...parts])),
      xmd: toHex(challengeBytes(label, parts)),
      scalar: shex(Hs(label, parts)),
    })),
  };

  /* context.json */
  const context = {
    elections: Object.entries(ceremonies).map(([name, c]) => ({
      ...setupJson(name, c.setup),
      publicKey: c.election.publicKey,
      verifyingShares: c.election.verifyingShares,
      contextInput: toHex(frame(contextParts(c.election))),
      ctx: toHex(electionContext(c.election)),
      fingerprintInput: toHex(fingerprintInput(c.election)),
      fingerprint: electionFingerprint(c.election),
      display: formatFingerprint(electionFingerprint(c.election)),
    })),
    voterTags: [
      ...[VOTERS.ada, VOTERS.grace, VOTERS.anon].flatMap((v) =>
        ["budget-2027", "referendum-2027"].map((name) => {
          const s = SETUPS[name]!;
          const parts: Part[] = [v.kind === "x509" ? LABELS.voterX509 : LABELS.voterIdemix, s.channel, s.electionId, v.mspId, v.bytes];
          return { channel: s.channel, electionId: s.electionId, ...voterJson(s, v), input: toHex(frame(parts)) };
        }),
      ),
    ],
  };

  /* ballots.json and tracking.json */
  const ballots: unknown[] = [];
  const tracking: unknown[] = [];
  const cast: Record<string, { voter: Voter; ballot: Ballot; json: string }[]> = {};
  for (const [name, list] of Object.entries(CAST)) {
    const c = ceremonies[name]!;
    const L = c.setup.options.length;
    cast[name] = [];
    const seen = new Set<string>();
    const voted = new Set<string>();
    const ledger: Ledger = { hasCiphertext: (a) => seen.has(a), hasVoted: (t) => voted.has(t) };
    list.forEach(([voter, choice], n) => {
      const seed = `v1 ${name} ballot ${n}`;
      const rnd = drawBallotRandomness(L, seededRandom(seed));
      const tag = tagOf(c.setup, voter);
      const { ballot, tracking: code } = proveBallot(c.election, tag, choiceMessages(L, choice), rnd);
      const json = ballotJson(ballot);
      const checked = checkBallot(c.election, tag, json, ledger, voter.kind);
      if (checked.tracking !== code) throw new Error("tracking codes differ");
      checked.ciphertexts.forEach((a) => seen.add(a));
      voted.add(toHex(tag));
      cast[name]!.push({ voter, ballot, json });
      ballots.push({
        election: name,
        voter: voterJson(c.setup, voter),
        choice,
        seed,
        randomness: { r: rnd.r.map(shex), bits: rnd.bits.map((b) => ({ cs: shex(b.cs), zs: shex(b.zs), w: shex(b.w) })), w: shex(rnd.w) },
        ballot,
        json,
        trace: checked.trace,
        tracking: code,
      });
      const parts: Uint8Array[] = [electionContext(c.election), tag];
      ballot.ciphertexts.forEach((ct, j) => {
        const p = ballot.bitProofs[j]!;
        for (const h of [ct.a, ct.b, p.c0, p.c1, p.z0, p.z1]) parts.push(hexBytes(h));
      });
      parts.push(hexBytes(ballot.sumProof.c), hexBytes(ballot.sumProof.z));
      tracking.push({ election: name, voterTag: toHex(tag), json, input: toHex(frame([LABELS.tracking, ...parts])), tracking: code });
    });
  }

  /* shares.json and tally.json */
  const shares: unknown[] = [];
  const tally: unknown[] = [];
  const posted: Record<string, { index: number; share: DecryptionSharePost }[]> = {};
  const totalsOf: Record<string, { totals: Ciphertext[]; ballots: number }> = {};
  for (const [name, c] of Object.entries(ceremonies)) {
    const t = addTotals(c.setup.options.length, cast[name]!.map((b) => b.ballot.ciphertexts));
    totalsOf[name] = t;
    posted[name] = c.keyShares.map((ks) => {
      const seed = `v1 ${name} dshare ${ks.index}`;
      const rec = recorder(seededRandom(seed));
      const share = decryptionShareWith(c.election, ks, t.totals, rec);
      checkDecryptionShare(c.election, t.totals, ks.index, JSON.stringify(share));
      shares.push({ election: name, index: ks.index, msp: c.setup.trustees[ks.index], keyShare: ks.share, seed, nonces: rec.draws.map((d) => shex(le(hexBytes(d)))), share, json: JSON.stringify(share) });
      return { index: ks.index, share };
    });
    const n = c.setup.trustees.length;
    const subsets: number[][] = [];
    for (let mask = 1; mask < 1 << n; mask++) {
      const s = Array.from({ length: n }, (_, i) => i).filter((i) => mask & (1 << i));
      if (s.length >= c.setup.threshold) subsets.push(s);
    }
    for (const s of subsets) {
      // Posted in reverse order, so the choice of the lowest identifiers shows.
      const p = s.map((i) => posted[name]![i]!).reverse();
      const r = recoverTally(c.election, t.totals, t.ballots, p);
      tally.push({ election: name, ballots: t.ballots, totals: t.totals, posted: p.map((x) => x.index), ...r });
    }
  }
  const sharesFile = { totals: Object.entries(totalsOf).map(([name, t]) => ({ election: name, ...t })), shares };

  /* negative.json */
  const negative: Record<string, unknown>[] = [];
  const expectError = (f: () => unknown): string => {
    try {
      f();
    } catch (x) {
      if (x instanceof TallyError) return x.message;
      throw x;
    }
    throw new Error("expected a refusal");
  };
  const A = ceremonies["budget-2027"]!;
  const aL = 3;
  const adaTag = tagOf(A.setup, VOTERS.ada);
  const graceTag = tagOf(A.setup, VOTERS.grace);
  const ada = cast["budget-2027"]![0]!;
  const fresh = (seed: string, m: number[], tag = adaTag, e = A.election) => ballotJson(proveBallot(e, tag, m, drawBallotRandomness(aL, seededRandom(seed))).ballot);
  const valid = JSON.parse(fresh("v1 negative base", [0, 1, 0])) as Ballot;

  const ballotCase = (name: string, json: string, opts: { tag?: Uint8Array; ciphertexts?: string[]; voted?: string[]; voter?: "x509" | "idemix"; election?: string } = {}) => {
    const c = ceremonies[opts.election ?? "budget-2027"]!;
    const tag = opts.tag ?? adaTag;
    const ledger: Ledger = { hasCiphertext: (a) => (opts.ciphertexts ?? []).includes(a), hasVoted: (t) => (opts.voted ?? []).includes(t) };
    const error = expectError(() => checkBallot(c.election, tag, json, ledger, opts.voter ?? "x509"));
    negative.push({ name, kind: "ballot", election: opts.election ?? "budget-2027", voterTag: toHex(tag), voter: opts.voter ?? "x509", ledger: { ciphertexts: opts.ciphertexts ?? [], voted: opts.voted ?? [] }, json, error });
  };
  const withBallot = (f: (b: Ballot & Record<string, unknown>) => void) => JSON.stringify(modify(valid as Ballot & Record<string, unknown>, f));

  // The prototype's ballot refusals.
  ballotCase("a ballot sent by another voter", ada.json, { tag: graceTag });
  ballotCase("a repeated ballot", ada.json, { ciphertexts: ada.ballot.ciphertexts.map((c) => c.a) });
  ballotCase("a slot holding 2", fresh("v1 negative two", [0, 2, 0]));
  ballotCase("two options chosen", fresh("v1 negative double", [1, 1, 0]));
  const otherKey: Election = { ...A.election, publicKey: toHex(G.multiply(12345678901234567890n).toBytes()) };
  ballotCase("a ballot under another key", fresh("v1 negative other key", [0, 0, 1], adaTag, otherKey));
  ballotCase("a changed bit proof value", withBallot((b) => (b.bitProofs[1]!.z0 = shex(le(hexBytes(b.bitProofs[1]!.z0)) + 1n))));
  ballotCase("a changed sum proof value", withBallot((b) => (b.sumProof.z = shex(le(hexBytes(b.sumProof.z)) + 1n))));
  ballotCase("a second ballot from the same identity", JSON.stringify(valid), { voted: [toHex(adaTag)] });
  const ref = ceremonies["referendum-2027"]!;
  const anonTag = tagOf(ref.setup, VOTERS.anon);
  ballotCase("a second ballot from the same credential", ballotJson(proveBallot(ref.election, anonTag, [1, 0], drawBallotRandomness(2, seededRandom("v1 negative anon"))).ballot), {
    election: "referendum-2027",
    tag: anonTag,
    voter: "idemix",
    voted: [toHex(anonTag)],
  });
  ballotCase("a ballot for another election", ballotJson(proveBallot(ref.election, tagOf(ref.setup, VOTERS.ada), [1, 0], drawBallotRandomness(2, seededRandom("v1 negative ref"))).ballot));
  // Parsing.
  ballotCase("not JSON", "{\"v\":1,");
  ballotCase("not an object", "[]");
  ballotCase("null", "null");
  ballotCase("an unknown top-level field", withBallot((b) => (b.extra = true)));
  ballotCase("two unknown fields, the first in byte order is named", withBallot((b) => Object.assign(b, { zeta: 1, Alpha: 2, alpha: 3 })));
  ballotCase("an unknown nested field", withBallot((b) => ((b.ciphertexts[0] as unknown as Record<string, unknown>).c = "00")));
  ballotCase("a missing sumProof", withBallot((b) => delete (b as Partial<Ballot>).sumProof));
  ballotCase("a missing nested field", withBallot((b) => delete (b.bitProofs[2] as Partial<Ballot["bitProofs"][0]>).z1));
  ballotCase("v as a string", withBallot((b) => ((b as Record<string, unknown>).v = "1")));
  ballotCase("ciphertexts as an object", withBallot((b) => ((b as Record<string, unknown>).ciphertexts = {})));
  ballotCase("a ciphertext as a string", withBallot((b) => ((b.ciphertexts as unknown[])[0] = "00")));
  ballotCase("a null point", withBallot((b) => ((b.ciphertexts[1] as unknown as Record<string, unknown>).b = null)));
  ballotCase("version 2", withBallot((b) => ((b as Record<string, unknown>).v = 2)));
  ballotCase("another election ID", withBallot((b) => (b.electionId = "budget-2028")));
  ballotCase("two ciphertexts for three options", withBallot((b) => b.ciphertexts.pop()));
  ballotCase("one ciphertext for three options", withBallot((b) => b.ciphertexts.splice(1)));
  ballotCase("four bit proofs for three options", withBallot((b) => b.bitProofs.push(b.bitProofs[0]!)));
  // Decoding. Non-canonical encodings from RFC 9496, section A.2, and others.
  for (const [what, hex] of [
    ["a non-canonical field element", "00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
    ["a field element of p or more", "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"],
    ["a negative field element", "0100000000000000000000000000000000000000000000000000000000000000"],
    ["a non-square", "26948d35ca62e643e26a83177332e6b6afeb9d08e4268b650f1f5bbd8d81d371"],
  ] as const) {
    ballotCase(`a point that is ${what}`, withBallot((b) => (b.ciphertexts[0]!.a = hex)));
  }
  ballotCase("a point in uppercase hex", withBallot((b) => (b.ciphertexts[2]!.b = b.ciphertexts[2]!.b.toUpperCase())));
  ballotCase("a point of odd length", withBallot((b) => (b.ciphertexts[1]!.a = b.ciphertexts[1]!.a.slice(1))));
  ballotCase("a point of 31 bytes", withBallot((b) => (b.ciphertexts[1]!.a = b.ciphertexts[1]!.a.slice(2))));
  ballotCase("a point of 33 bytes", withBallot((b) => (b.ciphertexts[1]!.b = b.ciphertexts[1]!.b + "00")));
  ballotCase("an identity point in slot 0", withBallot((b) => (b.ciphertexts[0]!.a = "00".repeat(32))));
  ballotCase("an identity point in slot 2", withBallot((b) => (b.ciphertexts[2]!.a = "00".repeat(32))));
  ballotCase("a scalar equal to l", withBallot((b) => (b.bitProofs[0]!.c0 = "edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010")));
  ballotCase("a scalar of 2^256 - 1", withBallot((b) => (b.sumProof.z = "ff".repeat(32))));
  ballotCase("a scalar in uppercase hex", withBallot((b) => (b.bitProofs[2]!.z1 = b.bitProofs[2]!.z1.toUpperCase())));
  ballotCase("a scalar with a non-hex character", withBallot((b) => (b.sumProof.c = "g" + b.sumProof.c.slice(1))));

  // Round 1.
  const r1Case = (name: string, index: number, post: unknown, election = "budget-2027") => {
    const json = typeof post === "string" ? post : JSON.stringify(post);
    negative.push({ name, kind: "round1", election, index, json, error: expectError(() => checkRound1(ceremonies[election]!.setup, index, json)) });
  };
  const p0 = A.round1[0]!;
  r1Case("a changed proof of knowledge", 1, modify(A.round1[1]!, (p) => (p.proof = p.proof.slice(0, 64) + shex(le(hexBytes(p.proof.slice(64))) + 1n))));
  r1Case("Org1MSP's round 1 posted by Org2MSP", 1, p0);
  r1Case("a proof with the identity as R", 0, modify(p0, (p) => (p.proof = "00".repeat(32) + p.proof.slice(64))));
  r1Case("a proof of 63 bytes", 0, modify(p0, (p) => (p.proof = p.proof.slice(2))));
  r1Case("a proof with z of l or more", 0, modify(p0, (p) => (p.proof = p.proof.slice(0, 64) + "ff".repeat(32))));
  r1Case("three commitments for a threshold of 2", 0, modify(p0, (p) => p.commitments.push(p.commitments[0]!)));
  r1Case("one commitment for a threshold of 2", 2, modify(A.round1[2]!, (p) => p.commitments.pop()));
  r1Case("an identity commitment", 0, modify(p0, (p) => (p.commitments[1] = "00".repeat(32))));
  r1Case("an identity ceremony key", 0, modify(p0, (p) => (p.ceremonyKey = "00".repeat(32))));
  r1Case("a non-canonical commitment", 0, modify(p0, (p) => (p.commitments[0] = "f3ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f")));
  r1Case("a missing ceremony key", 0, modify(p0 as Partial<Round1Post>, (p) => delete p.ceremonyKey));
  r1Case("an unknown field", 0, modify(p0 as Round1Post & { round?: number }, (p) => (p.round = 1)));
  r1Case("not JSON", 0, "commitments");

  // Round 2.
  const r2Case = (name: string, index: number, post: unknown) => {
    const json = JSON.stringify(post);
    negative.push({ name, kind: "round2", election: "budget-2027", index, json, error: expectError(() => checkRound2Exported(A.setup, index, json)) });
  };
  const q0 = A.round2[0]!;
  r2Case("a share missing for one trustee", 0, modify(q0, (p) => p.shares.pop()));
  r2Case("a share to the sender itself", 0, modify(q0, (p) => (p.shares[1]!.to = toHex(trusteeId(0)))));
  r2Case("two shares to one trustee", 0, modify(q0, (p) => (p.shares[1]!.to = p.shares[0]!.to)));
  r2Case("a share to a trustee that doesn't exist", 0, modify(q0, (p) => (p.shares[1]!.to = toHex(trusteeId(7)))));
  r2Case("an extra share", 0, modify(q0, (p) => p.shares.push(p.shares[0]!)));
  r2Case("a nonce of 11 bytes", 0, modify(q0, (p) => (p.shares[0]!.nonce = p.shares[0]!.nonce.slice(2))));
  r2Case("a box of 47 bytes", 0, modify(q0, (p) => (p.shares[1]!.box = p.shares[1]!.box.slice(2))));
  r2Case("a recipient that isn't a canonical scalar", 0, modify(q0, (p) => (p.shares[0]!.to = "ff".repeat(32))));
  r2Case("shares as a string", 0, { shares: "none" });

  // Round 3.
  const cfCase = (name: string, index: number, json: string) => {
    negative.push({ name, kind: "confirm", election: "budget-2027", index, json, error: expectError(() => checkConfirmationExported(A.election, index, json)) });
  };
  const cf0 = (A.record as { trustees: { round3: { confirmation: { c: string; z: string } } }[] }).trustees[0]!.round3.confirmation;
  cfCase("Org1MSP's confirmation posted by Org2MSP", 1, JSON.stringify(cf0));
  cfCase("a changed confirmation", 0, JSON.stringify({ ...cf0, z: shex(le(hexBytes(cf0.z)) + 1n) }));
  cfCase("a confirmation with c of l or more", 0, JSON.stringify({ ...cf0, c: "ff".repeat(32) }));
  cfCase("a missing z", 0, JSON.stringify({ c: cf0.c }));

  // Decryption shares.
  const tA = totalsOf["budget-2027"]!;
  const dsCase = (name: string, index: number, json: string) => {
    negative.push({ name, kind: "dshare", election: "budget-2027", index, totals: tA.totals, json, error: expectError(() => checkDecryptionShare(A.election, tA.totals, index, json)) });
  };
  const forged = decryptionShareWith(
    { ...A.election, verifyingShares: A.election.verifyingShares.map((s, i) => (i === 1 ? toHex(G.multiply(987654321n).toBytes()) : s)) },
    { ...A.keyShares[1]!, share: shex(987654321n) },
    tA.totals,
    seededRandom("v1 negative forged share"),
  );
  dsCase("a share made with another key", 1, JSON.stringify(forged));
  dsCase("Org1MSP's share posted by Org2MSP", 1, JSON.stringify(posted["budget-2027"]![0]!.share));
  dsCase("two entries for three options", 0, JSON.stringify(modify(posted["budget-2027"]![0]!.share, (s) => s.shares.pop())));
  dsCase("one entry for three options", 0, JSON.stringify(modify(posted["budget-2027"]![0]!.share, (s) => s.shares.splice(1))));
  dsCase("a non-canonical d", 0, JSON.stringify(modify(posted["budget-2027"]![0]!.share, (s) => (s.shares[1]!.d = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"))));
  dsCase("a changed c in entry 2", 2, JSON.stringify(modify(posted["budget-2027"]![2]!.share, (s) => (s.shares[2]!.c = shex(le(hexBytes(s.shares[2]!.c)) + 1n)))));
  dsCase("a trustee field, which the contract takes from the caller", 0, JSON.stringify({ trustee: toHex(trusteeId(0)), ...posted["budget-2027"]![0]!.share }));

  // The tally.
  const tCase = (name: string, ballotsN: number, p: { index: number; share: DecryptionSharePost }[], totals = tA.totals) => {
    negative.push({ name, kind: "tally", election: "budget-2027", ballots: ballotsN, totals, posted: p, error: expectError(() => recoverTally(A.election, totals, ballotsN, p)) });
  };
  const pA = posted["budget-2027"]!;
  tCase("a tally from one organisation alone", tA.ballots, [pA[1]!]);
  tCase("a tally with no shares", tA.ballots, []);
  tCase("a count larger than the number of ballots", 2, [pA[0]!, pA[1]!]);
  tCase("counts that don't add up to the number of ballots", 6, [pA[0]!, pA[2]!]);
  tCase("totals changed after the shares were checked", tA.ballots, [pA[0]!, pA[1]!], modify(tA.totals, (t) => (t[0]!.b = toHex(P.fromBytes(hexBytes(t[0]!.b)).add(G.multiply(1000n)).toBytes()))));

  const write = (x: unknown) => JSON.stringify(x, null, 2) + "\n";
  return {
    "framing.json": write(framing),
    "context.json": write(context),
    "ceremony.json": write({ ceremonies: Object.values(ceremonies).map((c) => c.record) }),
    "ballots.json": write({ ballots }),
    "tracking.json": write({ tracking }),
    "shares.json": write(sharesFile),
    "tally.json": write({ tally }),
    "negative.json": write({ negative }),
  };
}


export const VECTORS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors", "v1");

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = await generateVectors();
  mkdirSync(VECTORS_DIR, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(VECTORS_DIR, name), text);
  console.log(`Wrote ${Object.keys(files).length} files to ${VECTORS_DIR}`);
}
