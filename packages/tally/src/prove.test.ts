/**
 * The prover does the same work for a 0 and a 1 (private-tally-spec.md,
 * Group and encoding). The group module is replaced by one that records
 * every point operation and scalar field operation, in order, with the
 * scalar of every multiplication, while a slot or a ballot is proved; the
 * records for different votes must be the same. Noble freezes its classes,
 * so each point is a recording proxy around noble's own. The timing itself
 * is measured by scripts/timing.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { VECTORS_DIR } from "../scripts/vectors.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const log = vi.hoisted(() => ({ ops: [] as string[], scalars: [] as bigint[], on: false }));

vi.mock("./group.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./group.ts")>();
  const POINT_OPS = new Set(["multiply", "multiplyUnsafe", "add", "subtract", "negate", "double", "equals", "is0"]);
  const targets = new WeakMap<object, object>();
  const unwrap = (x: any) => (x && typeof x === "object" && targets.has(x) ? targets.get(x) : x);
  const wrap = (p: any): any => {
    if (!(p instanceof real.Point)) return p;
    const proxy = new Proxy(p, {
      get(t, k) {
        const v = Reflect.get(t, k, t);
        if (typeof k === "string" && POINT_OPS.has(k) && typeof v === "function") {
          return (...args: any[]) => {
            if (log.on) {
              log.ops.push(`point.${k}`);
              if (k.startsWith("multiply")) log.scalars.push(args[0]);
            }
            return wrap(v.apply(t, args.map(unwrap)));
          };
        }
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    targets.set(proxy, p);
    return proxy;
  };
  const Fn = new Proxy(real.Fn, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      if (typeof v !== "function") return v;
      return (...args: any[]) => {
        if (log.on) log.ops.push(`scalar.${String(k)}`);
        return v.apply(t, args);
      };
    },
  });
  return {
    ...real,
    Fn,
    G: wrap(real.G),
    ZERO: wrap(real.ZERO),
    decodePoint: (b: Uint8Array) => wrap(real.decodePoint(b)),
    mulSecret: (p: any, s: bigint) => {
      if (log.on) {
        log.ops.push("mulSecret");
        log.scalars.push(s);
      }
      return wrap(real.mulSecret(unwrap(p), s));
    },
    mulPub: (p: any, s: bigint) => {
      if (log.on) log.ops.push("mulPub");
      return wrap(real.mulPub(unwrap(p), s));
    },
  };
});

const { choiceMessages, drawBallotRandomness, proveBallot, proveSlot } = await import("./prove.ts");
const { prepare } = await import("./election.ts");
const { seededRandom } = await import("./testing.ts");
const { voterTagX509 } = await import("./voter.ts");
const { checkBallot } = await import("./verify.ts");
type Election = import("./election.ts").Election;

const context = JSON.parse(readFileSync(join(VECTORS_DIR, "context.json"), "utf8"));
const election: Election = context.elections.find((e: any) => e.name === "budget-2027");
const tag = voterTagX509(election.channel, election.electionId, "Org1MSP", "ada");

/** Runs f with the log on, and returns what it recorded. */
function traced<T>(f: () => T): { result: T; ops: string[]; scalars: bigint[] } {
  log.ops = [];
  log.scalars = [];
  log.on = true;
  try {
    const result = f();
    return { result, ops: log.ops, scalars: log.scalars };
  } finally {
    log.on = false;
  }
}

describe("the prover's work for a 0 and a 1", () => {
  it("is the same sequence of operations in one slot", () => {
    const { H, ctx } = prepare(election);
    const { r, bits } = drawBallotRandomness(1, seededRandom("structural slot"));
    const run = (m: number) => traced(() => proveSlot(H, ctx, tag, 0, m, r[0]!, bits[0]!.cs, bits[0]!.zs, bits[0]!.w));
    const zero = run(0);
    const one = run(1);
    // a, r·H, z_s·G, c_s·a, z_s·H, c_s·target, w·G and w·H.
    expect(zero.ops.filter((o) => o === "mulSecret")).toHaveLength(8);
    expect(zero.ops).toEqual(one.ops);
    // The same scalars, in the same order: none of them is the vote.
    expect(zero.scalars).toEqual(one.scalars);
    // The two are different ciphertexts, so the records aren't the same by accident.
    expect(zero.result.ciphertext.b).not.toBe(one.result.ciphertext.b);
    expect(zero.result.ciphertext.a).toBe(one.result.ciphertext.a);
  });

  it("is the same sequence of operations for every choice in a ballot", () => {
    const runs = [0, 1, 2].map((choice) => traced(() => proveBallot(election, tag, choiceMessages(3, choice), drawBallotRandomness(3, seededRandom("structural ballot")))));
    expect(runs[0]!.ops.length).toBeGreaterThan(50);
    expect(runs[1]!.ops).toEqual(runs[0]!.ops);
    expect(runs[2]!.ops).toEqual(runs[0]!.ops);
    expect(runs[1]!.scalars).toEqual(runs[0]!.scalars);
    expect(runs[2]!.scalars).toEqual(runs[0]!.scalars);
    expect(runs[0]!.scalars.filter((s) => s === 0n || s === 1n)).toEqual([]);
    // And each ballot is valid for its choice.
    for (const run of runs) checkBallot(election, tag, JSON.stringify(run.result.ballot));
  });
});
