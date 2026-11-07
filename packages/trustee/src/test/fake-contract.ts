/**
 * TEST ONLY: an in-memory stand-in for examples/private-ballot-contract,
 * with the contract's checks from @weftwallet/tally/verify and its messages
 * from contract-api.md, behind weft-trustee's Ledger interface. It records
 * every call, so tests can check what each command sent.
 */
import {
  checkBallot,
  checkConfirmation,
  checkDecryptionShare,
  checkRound1,
  checkRound2,
  addTotals,
  electionContext,
  electionFingerprint,
  electionKeys,
  recoverTally,
  toHex,
  TallyError,
  voterTagX509,
  type Ballot,
  type Election,
  type ElectionSetup,
} from "@weftwallet/tally/verify";
import type { CeremonyRecord, ElectionRecord } from "../commands.ts";
import { Refusal, ValidationFailure, type Ledger, type Submitted } from "../ledger.ts";

export interface Caller {
  msp: string;
  trustee: boolean;
  /** For the voter tag. */
  idBytes?: Uint8Array;
}

export interface Call {
  msp: string;
  kind: "evaluate" | "submit";
  fn: string;
  args: string[];
}

interface Stored {
  rec: ElectionRecord;
  round1: Record<string, unknown>;
  round2: Record<string, unknown>;
  confirm: Record<string, unknown>;
  close: Set<string>;
  ballots: { tracking: string; ballot: Ballot }[];
  ciphertexts: Set<string>;
  voted: Set<string>;
  dshares: Record<string, unknown>;
}

export class FakeContract {
  readonly channel: string;
  readonly chaincode: string;
  readonly calls: Call[] = [];
  block = 3n;
  private tx = 0;
  private elections = new Map<string, Stored>();
  /** The next submit of this function fails validation with this code, once. */
  failNext: { fn: string; code: string } | null = null;

  constructor(channel = "privatevote-budget-2027", chaincode = "private-ballot") {
    this.channel = channel;
    this.chaincode = chaincode;
  }

  ledgerFor(caller: Caller): Ledger {
    return {
      evaluate: async (fn, ...args) => {
        this.calls.push({ msp: caller.msp, kind: "evaluate", fn, args });
        return this.call(caller, fn, args, false).result;
      },
      submit: async (fn, ...args) => {
        this.calls.push({ msp: caller.msp, kind: "submit", fn, args });
        if (this.failNext?.fn === fn) {
          const code = this.failNext.code;
          this.failNext = null;
          this.block++;
          throw new ValidationFailure(code, this.txId());
        }
        const snapshot = this.snapshot();
        try {
          const out = this.call(caller, fn, args, true);
          this.block++;
          return out;
        } catch (err) {
          this.restore(snapshot);
          throw err;
        }
      },
      close: () => {},
    };
  }

  /** The submitted calls, as "msp fn". */
  submitted(): string[] {
    return this.calls.filter((c) => c.kind === "submit").map((c) => `${c.msp} ${c.fn}`);
  }

  record(id: string): ElectionRecord {
    return structuredClone(this.elections.get(id)!.rec);
  }

  private txId(): string {
    return (++this.tx).toString(16).padStart(64, "a");
  }

  private snapshot() {
    return new Map([...this.elections].map(([k, v]) => [k, { ...v, rec: structuredClone(v.rec), close: new Set(v.close), ciphertexts: new Set(v.ciphertexts), voted: new Set(v.voted), ballots: [...v.ballots], round1: { ...v.round1 }, round2: { ...v.round2 }, confirm: { ...v.confirm }, dshares: { ...v.dshares } }]));
  }

  private restore(s: Map<string, Stored>) {
    this.elections = s;
  }

  private setup(rec: ElectionRecord): ElectionSetup {
    return { channel: this.channel, chaincode: this.chaincode, electionId: rec.id, options: rec.options, threshold: rec.threshold, trustees: rec.trustees.map((t) => t.msp) };
  }

  private election(rec: ElectionRecord): Election {
    return { ...this.setup(rec), publicKey: rec.publicKey!, verifyingShares: rec.verifyingShares! };
  }

  private get(id: string): Stored {
    const e = this.elections.get(id);
    if (!e) throw new Refusal(`There's no election ${id}.`);
    return e;
  }

  private trustee(caller: Caller, s: Stored): number {
    if (!caller.trustee) throw new Refusal("This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true.");
    const i = s.rec.trustees.findIndex((t) => t.msp === caller.msp);
    if (i < 0) throw new Refusal(`${caller.msp} isn't a trustee of this election.`);
    return i;
  }

  private ceremonyOpen(s: Stored): void {
    if (s.rec.state !== "keygen") throw new Refusal(`The key ceremony has ended: the election is in ${s.rec.state}.`);
  }

  private waiting(s: Stored, posts: Record<string, unknown>, round: number): void {
    const missing = s.rec.trustees.find((t) => !(t.msp in posts));
    if (missing) throw new Refusal(`Round ${round} isn't finished: waiting for ${missing.msp}.`);
  }

  private check<T>(f: () => T): T {
    try {
      return f();
    } catch (err) {
      if (err instanceof TallyError) throw new Refusal(err.message);
      throw err;
    }
  }

  private out(result: unknown, write: boolean): Submitted {
    return { result: typeof result === "string" ? result : JSON.stringify(result), block: this.block, txId: write ? this.txId() : "" };
  }

  private call(caller: Caller, fn: string, args: string[], write: boolean): Submitted {
    const [id] = args;
    switch (fn) {
      case "GetElection":
        return this.out(this.get(id!).rec, write);
      case "GetCeremony": {
        const s = this.get(id!);
        const cer: CeremonyRecord = {
          electionId: id!,
          trustees: s.rec.trustees.map((t) => ({
            id: t.id,
            msp: t.msp,
            round1: (s.round1[t.msp] ?? null) as never,
            round2: (s.round2[t.msp] ?? null) as never,
            confirmation: (s.confirm[t.msp] ?? null) as never,
            closeRequested: s.close.has(t.msp),
          })),
        };
        return this.out(cer, write);
      }
      case "GetDecryptionShares": {
        const s = this.get(id!);
        return this.out({ electionId: id, shares: s.rec.trustees.filter((t) => t.msp in s.dshares).map((t) => ({ id: t.id, msp: t.msp, shares: (s.dshares[t.msp] as { shares: unknown }).shares })) }, write);
      }
      case "CreateElection": {
        const e = JSON.parse(args[0]!) as { id: string; title: string; options: string[]; closesAt: string; trustees: string[]; threshold: number; voters: ElectionRecord["voters"] };
        if (!caller.trustee) throw new Refusal("This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true.");
        if (!e.trustees.includes(caller.msp)) throw new Refusal(`${caller.msp} isn't one of the trustee organisations named in this election.`);
        if (this.elections.has(e.id)) throw new Refusal(`Election ${e.id} already exists.`);
        if (e.options.length < 2 || new Set(e.options).size !== e.options.length) throw new Refusal("An election has 2 to 20 options, all different.");
        if (e.trustees.length < 2) throw new Refusal("An election has at least two trustee organisations, all different.");
        if (e.threshold < 2 || e.threshold > e.trustees.length) throw new Refusal("The threshold must be from 2 to the number of trustees.");
        const rec: ElectionRecord = {
          v: 1,
          id: e.id,
          title: e.title,
          options: e.options,
          closesAt: e.closesAt,
          creatorMsp: caller.msp,
          trustees: e.trustees.map((msp, i) => ({ id: (i + 1).toString(16).padStart(2, "0").padEnd(64, "0"), msp })),
          threshold: e.threshold,
          voters: e.voters,
          state: "keygen",
        };
        this.elections.set(e.id, { rec, round1: {}, round2: {}, confirm: {}, close: new Set(), ballots: [], ciphertexts: new Set(), voted: new Set(), dshares: {} });
        return this.out(rec, write);
      }
      case "PostCommitments": {
        const s = this.get(id!);
        this.ceremonyOpen(s);
        const i = this.trustee(caller, s);
        if (caller.msp in s.round1) throw new Refusal(`${caller.msp} has already posted round 1.`);
        this.check(() => checkRound1(this.setup(s.rec), i, args[1]!));
        s.round1[caller.msp] = JSON.parse(args[1]!);
        return this.out(s.rec, write);
      }
      case "PostShares": {
        const s = this.get(id!);
        this.ceremonyOpen(s);
        const i = this.trustee(caller, s);
        this.waiting(s, s.round1, 1);
        if (caller.msp in s.round2) throw new Refusal(`${caller.msp} has already posted round 2.`);
        this.check(() => checkRound2(this.setup(s.rec), i, args[1]!));
        s.round2[caller.msp] = JSON.parse(args[1]!);
        return this.out(s.rec, write);
      }
      case "ConfirmShares": {
        const s = this.get(id!);
        this.ceremonyOpen(s);
        const i = this.trustee(caller, s);
        this.waiting(s, s.round2, 2);
        if (caller.msp in s.confirm) throw new Refusal(`${caller.msp} has already posted round 3.`);
        const keys = this.keys(s);
        this.check(() => checkConfirmation({ ...this.setup(s.rec), ...keys }, i, args[1]!));
        s.confirm[caller.msp] = JSON.parse(args[1]!);
        return this.out(s.rec, write);
      }
      case "ReportBadShare": {
        const s = this.get(id!);
        this.ceremonyOpen(s);
        const i = this.trustee(caller, s);
        this.waiting(s, s.round2, 2);
        const from = s.rec.trustees.findIndex((t) => t.id === args[1]);
        if (from < 0 || from === i) throw new Refusal(`Trustee ${args[1]} isn't another trustee of this election.`);
        s.rec.state = "failed";
        return this.out(s.rec, write);
      }
      case "CancelElection": {
        const s = this.get(id!);
        if (!caller.trustee) throw new Refusal("This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true.");
        if (s.rec.creatorMsp !== caller.msp) throw new Refusal(`${caller.msp} didn't create this election, so it can't cancel it.`);
        this.ceremonyOpen(s);
        s.rec.state = "cancelled";
        return this.out(s.rec, write);
      }
      case "OpenElection": {
        const s = this.get(id!);
        this.ceremonyOpen(s);
        this.waiting(s, s.confirm, 3);
        const keys = this.keys(s);
        Object.assign(s.rec, keys);
        const e = this.election(s.rec);
        s.rec.context = toHex(electionContext(e));
        s.rec.fingerprint = electionFingerprint(e);
        s.rec.state = "open";
        return this.out(s.rec, write);
      }
      case "CastBallot": {
        const s = this.get(id!);
        if (s.rec.state === "decrypting" || s.rec.state === "counted") throw new Refusal("Voting has closed.");
        if (s.rec.state !== "open") throw new Refusal(`The election isn't open: it is in ${s.rec.state}.`);
        const tag = voterTagX509(this.channel, id!, caller.msp, caller.idBytes!);
        const checked = this.check(() =>
          checkBallot(this.election(s.rec), tag, args[1]!, { hasCiphertext: (a) => s.ciphertexts.has(a), hasVoted: (t) => s.voted.has(t) }),
        );
        s.ballots.push({ tracking: checked.tracking, ballot: checked.ballot });
        checked.ciphertexts.forEach((a) => s.ciphertexts.add(a));
        s.voted.add(toHex(tag));
        return this.out({ electionId: id, txId: "", tracking: checked.tracking }, write);
      }
      case "CloseElection": {
        const s = this.get(id!);
        if (s.rec.state === "decrypting" || s.rec.state === "counted") throw new Refusal(`Voting has already closed: the election is in ${s.rec.state}.`);
        if (s.rec.state !== "open") throw new Refusal(`The election isn't open: it is in ${s.rec.state}.`);
        this.trustee(caller, s);
        s.close.add(caller.msp);
        if (s.close.size >= s.rec.threshold) {
          const { totals, ballots } = addTotals(s.rec.options.length, s.ballots.map((b) => b.ballot.ciphertexts));
          s.rec.totals = totals;
          s.rec.ballots = ballots;
          s.rec.closedBy = s.rec.trustees.filter((t) => s.close.has(t.msp)).map((t) => t.msp);
          s.rec.state = "decrypting";
        }
        return this.out(s.rec, write);
      }
      case "PostDecryptionShare": {
        const s = this.get(id!);
        const i = this.trustee(caller, s);
        if (s.rec.state !== "decrypting") throw new Refusal(`The election is in ${s.rec.state}: decryption shares are posted while it is in decrypting.`);
        if (caller.msp in s.dshares) throw new Refusal(`${caller.msp} has already posted its decryption share.`);
        this.check(() => checkDecryptionShare(this.election(s.rec), s.rec.totals!, i, args[1]!));
        s.dshares[caller.msp] = JSON.parse(args[1]!);
        return this.out(s.rec, write);
      }
      case "PublishTally": {
        const s = this.get(id!);
        if (s.rec.state === "counted") throw new Refusal("The tally is already published.");
        if (s.rec.state !== "decrypting") throw new Refusal(`The tally can't be published: the election is in ${s.rec.state}.`);
        const posted = s.rec.trustees.map((t, index) => ({ index, share: s.dshares[t.msp] })).filter((p) => p.share) as never[];
        const result = this.check(() => recoverTally(this.election(s.rec), s.rec.totals!, s.rec.ballots!, posted));
        s.rec.tally = { counts: Object.fromEntries(s.rec.options.map((o, j) => [o, result.counts[j]!])), total: result.total };
        s.rec.state = "counted";
        return this.out(s.rec, write);
      }
      default:
        throw new Refusal(`The contract has no function ${fn}.`);
    }
  }

  private keys(s: Stored) {
    const setup = this.setup(s.rec);
    const r1 = s.rec.trustees.map((t, i) => checkRound1(setup, i, JSON.stringify(s.round1[t.msp])));
    return electionKeys(setup, r1);
  }

  /** Changes a stored round 2 box, for the bad share test. */
  tamperRound2(id: string, msp: string): void {
    const post = this.elections.get(id)!.round2[msp] as { shares: { box: string }[] };
    const box = post.shares[0]!.box;
    post.shares[0]!.box = (box[0] === "0" ? "1" : "0") + box.slice(1);
  }
}
