/**
 * weft-trustee's commands (key-ceremony.md): status, create, the key
 * ceremony's three rounds (commit, share, confirm), open, close, decrypt,
 * publish, cancel and destroy. Each reads the election from the ledger
 * first and refuses, without asking for the passphrase or signing anything,
 * when its step can't run yet. When a command's step completes the
 * condition for the next one, it calls that too: the last confirm calls
 * OpenElection, and the decrypt that brings the shares to k calls
 * PublishTally (D9 of the step 4 plan).
 */
import {
  BadShareError,
  ceremonyRound1,
  ceremonyRound2,
  ceremonyRound3,
  decryptionShare,
  electionFingerprint,
  formatFingerprint,
  type Ciphertext,
  type ConfirmationPost,
  type DecryptionSharePost,
  type Election,
  type ElectionSetup,
  type KeyShare,
  type Round1Post,
  type Round2Post,
  type TrusteeSecret,
} from "@weftwallet/tally/trustee";
import { checkDecryptionShare, recoverTally } from "@weftwallet/tally/verify";
import type { Connection } from "./connection.ts";
import { requireTrustee, type Identity } from "./identity.ts";
import { Refusal, ValidationFailure, type Ledger, type Submitted } from "./ledger.ts";
import { Failure, list, plural, row, shortTx, when, type Output } from "./output.ts";
import type { Prompt } from "./prompt.ts";
import { ElectionState, WrongPassphrase, type KdfParams } from "./store.ts";

/* ---------- the contract's records (contract-api.md) ---------- */

export interface ElectionRecord {
  v: 1;
  id: string;
  title: string;
  options: string[];
  closesAt: string;
  creatorMsp: string;
  trustees: { id: string; msp: string }[];
  threshold: number;
  voters: { kind: string; msps?: string[]; msp?: string };
  state: "keygen" | "open" | "decrypting" | "counted" | "failed" | "cancelled";
  publicKey?: string;
  verifyingShares?: string[];
  context?: string;
  fingerprint?: string;
  ballots?: number;
  totals?: Ciphertext[];
  closedBy?: string[];
  tally?: { counts: Record<string, number>; total: number };
  /** In failed: the MSP ID of the trustee organisation that reported a bad share. */
  reportedBy?: string;
}

export interface CeremonyRecord {
  electionId: string;
  trustees: {
    id: string;
    msp: string;
    round1: Round1Post | null;
    round2: Round2Post | null;
    confirmation: ConfirmationPost | null;
    closeRequested: boolean;
  }[];
}

export interface SharesRecord {
  electionId: string;
  shares: { id: string; msp: string; shares: DecryptionSharePost["shares"] }[];
}

/* ---------- what a command runs with ---------- */

export interface Env {
  connection: Connection;
  identity: Identity;
  /** Connects on first use, so a command that fails before reading the ledger doesn't connect. */
  ledger(): Promise<Ledger>;
  prompt: Prompt;
  out: Output;
  /** WEFT_TRUSTEE_PASSPHRASE, for scripts. */
  passphrase?: string;
  now(): Date;
  /** Lighter scrypt settings, for tests only. */
  kdf?: KdfParams;
}

const CMD = "weft-trustee";

function stateFor(env: Env, electionId: string): ElectionState {
  return new ElectionState(env.connection.home, env.identity.msp, env.connection.channel, electionId, env.kdf);
}

function setupOf(env: Env, rec: ElectionRecord): ElectionSetup {
  return {
    channel: env.connection.channel,
    chaincode: env.connection.contract,
    electionId: rec.id,
    options: rec.options,
    threshold: rec.threshold,
    trustees: rec.trustees.map((t) => t.msp),
  };
}

function electionOf(env: Env, rec: ElectionRecord): Election {
  if (!rec.publicKey || !rec.verifyingShares) throw new Failure(`${rec.id} has no election key yet: it is in ${rec.state}.`);
  return { ...setupOf(env, rec), publicKey: rec.publicKey, verifyingShares: rec.verifyingShares };
}

async function read<T>(env: Env, fn: string, ...args: string[]): Promise<T> {
  const ledger = await env.ledger();
  try {
    return JSON.parse(await ledger.evaluate(fn, ...args)) as T;
  } catch (err) {
    if (err instanceof Refusal) {
      if (err.message.startsWith("There's no election")) {
        throw new Failure(err.message, `Check the election ID, and that ${env.connection.channel} is its channel.`);
      }
      throw new Failure(err.message);
    }
    throw err;
  }
}

const getElection = (env: Env, id: string) => read<ElectionRecord>(env, "GetElection", id);
const getCeremony = (env: Env, id: string) => read<CeremonyRecord>(env, "GetCeremony", id);
const getShares = (env: Env, id: string) => read<SharesRecord>(env, "GetDecryptionShares", id);

/** Submits, and turns a refusal or a failed validation into the command's failure. */
async function post(env: Env, fn: string, args: string[], again = "Run this again."): Promise<Submitted> {
  const ledger = await env.ledger();
  try {
    return await ledger.submit(fn, ...args);
  } catch (err) {
    if (err instanceof Refusal) {
      if (err.message.includes("weft.trustee=true")) {
        throw new Failure(err.message, `Register a trustee identity with that attribute at ${env.identity.msp}'s CA, as for an explorer.`);
      }
      throw new Failure(err.message, "Nothing was posted.");
    }
    if (err instanceof ValidationFailure) throw new Failure(`The transaction failed validation (${err.code}), so it changed nothing.`, again);
    throw err;
  }
}

function trusteeIndex(env: Env, rec: ElectionRecord): number {
  const i = rec.trustees.findIndex((t) => t.msp === env.identity.msp);
  if (i < 0) throw new Failure(`${env.identity.msp} isn't a trustee of this election.`, `Its trustees are ${list(rec.trustees.map((t) => t.msp))}.`);
  return i;
}

function requireKeygen(rec: ElectionRecord): void {
  if (rec.state !== "keygen") throw new Failure(`The key ceremony has ended: the election is in ${rec.state}.`);
}

/** The trustees, in order, who haven't posted a round. */
function waitingFor(cer: CeremonyRecord, round: "round1" | "round2" | "confirmation"): string[] {
  return cer.trustees.filter((t) => t[round] === null).map((t) => t.msp);
}

const ROUND_NAMES = { round1: 1, round2: 2, confirmation: 3 } as const;

/** The contract's sentence for a round that isn't finished, and what to do. */
function roundNotFinished(cer: CeremonyRecord, round: "round1" | "round2"): Failure {
  const waiting = waitingFor(cer, round);
  const n = ROUND_NAMES[round];
  return new Failure(
    `Round ${n} isn't finished: waiting for ${waiting[0]}.`,
    `Nothing was posted. Run this again once ${list(waiting)} ${waiting.length === 1 ? "has" : "have"} posted round ${n}.`,
  );
}

async function askPassphrase(env: Env, state: ElectionState, confirm: boolean): Promise<string> {
  if (env.passphrase !== undefined) return env.passphrase;
  const p = await env.prompt.secret(`Passphrase for ${state.shown}: `);
  if (confirm) {
    if (p.length < 8) throw new Failure("That passphrase is shorter than 8 characters.", "Nothing was saved or posted. Run the command again with a longer one.");
    const again = await env.prompt.secret("Passphrase again: ");
    if (again !== p) throw new Failure("The two passphrases don't match.", "Nothing was saved or posted. Run the command again.");
  }
  return p;
}

async function openSecret<T>(env: Env, state: ElectionState, kind: "ceremony" | "key-share", passphrase: string): Promise<T> {
  try {
    return await state.read<T>(kind, passphrase);
  } catch (err) {
    if (err instanceof WrongPassphrase) {
      throw new Failure(`That passphrase doesn't open ${state.shown}.`, "Nothing was posted. Run the command again with the passphrase you set in round 1.");
    }
    throw err;
  }
}

function trusteesLine(rec: ElectionRecord): string {
  const k = rec.threshold;
  const n = rec.trustees.length;
  return `${list(rec.trustees.map((t, i) => `${t.msp} (${i + 1})`))}. Any ${k} of ${n} can decrypt.`;
}

function youLine(env: Env, rec: ElectionRecord): string {
  const { name, msp, trustee } = env.identity;
  const of = rec.trustees.some((t) => t.msp === msp) ? `${name}, for ${msp}` : `${name}, for ${msp}, which isn't a trustee of this election`;
  return trustee ? of : `${of}. Its certificate doesn't carry weft.trustee=true, so it can only read`;
}

function countLines(rec: ElectionRecord): string[] {
  const counts = rec.tally!.counts;
  const width = Math.max(...rec.options.map((o) => o.length));
  return [
    ...rec.options.map((o) => `${o.padEnd(width)}   ${counts[o] ?? 0}`),
    `${plural(rec.tally!.total, "ballot")}, and the counts add up to ${rec.tally!.total === 1 ? "it" : "them"}.`,
  ];
}

/* ---------- status ---------- */

export interface StatusOptions {
  election: string;
  json?: boolean;
}

export interface StatusReport {
  election: ElectionRecord;
  ceremony: CeremonyRecord;
  shares: SharesRecord | null;
  you: { msp: string; name: string; trustee: boolean; index: number | null };
  saved: { folder: string; ceremonyKey: boolean; keyShare: boolean };
  fingerprint: string | null;
}

export async function status(env: Env, o: StatusOptions): Promise<number> {
  const rec = await getElection(env, o.election);
  const cer = await getCeremony(env, o.election);
  const shares = rec.state === "decrypting" || rec.state === "counted" ? await getShares(env, o.election) : null;
  const state = stateFor(env, o.election);
  const index = rec.trustees.findIndex((t) => t.msp === env.identity.msp);
  const fingerprint = rec.publicKey ? electionFingerprint(electionOf(env, rec)) : null;
  if (fingerprint && rec.fingerprint !== fingerprint) {
    throw new Failure(`The fingerprint in ${rec.id}'s record isn't the one weft-trustee works out from its key, ${formatFingerprint(fingerprint)}.`, "Tell the other trustees, and don't let anyone vote in it.");
  }
  const report: StatusReport = {
    election: rec,
    ceremony: cer,
    shares,
    you: { msp: env.identity.msp, name: env.identity.name, trustee: env.identity.trustee, index: index < 0 ? null : index },
    saved: { folder: state.dir, ceremonyKey: state.has("ceremony"), keyShare: state.has("key-share") },
    fingerprint,
  };
  if (o.json) {
    env.out.line(JSON.stringify(report, null, 2));
    return 0;
  }
  const out = env.out;
  const id = rec.id;
  const msps = rec.trustees.map((t) => t.msp);
  const states: Record<ElectionRecord["state"], string> = {
    keygen: "keygen: the key ceremony is running",
    open:
      env.now() < new Date(rec.closesAt)
        ? `open: voting is open until ${when(rec.closesAt)}`
        : `open, past its planned closing time, ${when(rec.closesAt)}: voting stays open until ${rec.threshold} trustees close it`,
    decrypting: `decrypting: voting closed with ${plural(rec.ballots ?? 0, "ballot")}, and the trustees are decrypting the totals`,
    counted: "counted: the tally is published",
    failed: `failed: ${rec.reportedBy ?? "a trustee"} reported a bad share in the key ceremony, so it can't open`,
    cancelled: `cancelled: ${rec.creatorMsp} cancelled it during the key ceremony`,
  };
  out.line(`${rec.title} (${id}) on ${env.connection.channel}`);
  out.line(row("State", states[rec.state]));
  out.line(row("Trustees", trusteesLine(rec)));
  out.line(row("You", youLine(env, rec)));
  if (fingerprint) out.line(row("Key", `${formatFingerprint(fingerprint)}, the election fingerprint`));
  if (report.saved.keyShare) out.line(row("Saved", `your key share, encrypted, in ${state.shown}`));
  else if (report.saved.ceremonyKey) out.line(row("Saved", `your one-time ceremony key, encrypted, in ${state.shown}`));
  // The progress rows follow a blank line, for the states that have them.
  if (rec.state !== "failed" && rec.state !== "cancelled") out.line();

  const progress = (round: "round1" | "round2" | "confirmation") => cer.trustees.map((t) => `${t.msp} ${t[round] ? "posted" : "waiting"}`).join("   ");
  let next: string | null = null;
  const mine = index >= 0 ? cer.trustees[index]! : null;
  if (rec.state === "keygen") {
    const rounds = ["round1", "round2", "confirmation"] as const;
    let started = true;
    for (const r of rounds) {
      out.line(row(`Round ${ROUND_NAMES[r]}`, started ? progress(r) : "not started"));
      const waiting = waitingFor(cer, r);
      if (started && waiting.length && mine && next === null) {
        const command = { round1: "commit", round2: "share", confirmation: "confirm" }[r];
        next = mine[r] === null
          ? `Run ${CMD} ${command} --election ${id} to post round ${ROUND_NAMES[r]}.`
          : r === "confirmation"
            ? `Waiting for ${list(waiting)} to confirm. The election opens once ${waiting.length === 1 ? "it has" : "they have"}.`
            : `Waiting for ${list(waiting)} to post round ${ROUND_NAMES[r]}.`;
      }
      if (waiting.length) started = false;
    }
    if (started) next = `Every trustee has confirmed. Run ${CMD} open --election ${id} to open it.`;
  } else if (rec.state === "open") {
    const asked = cer.trustees.filter((t) => t.closeRequested).map((t) => t.msp);
    out.line(row("Closing", `${cer.trustees.map((t) => `${t.msp} ${t.closeRequested ? "asked" : "not yet"}`).join("   ")}. Voting closes when ${rec.threshold} have asked.`));
    if (mine && !mine.closeRequested) {
      next = env.now() < new Date(rec.closesAt)
        ? `Run ${CMD} close --election ${id} after ${when(rec.closesAt)}, or with --early to close it now.`
        : `Run ${CMD} close --election ${id} to close voting.`;
    } else if (mine) {
      const left = rec.threshold - asked.length;
      next = `You have asked to close. Voting closes when ${plural(left, "more trustee")} ${left === 1 ? "asks" : "ask"}.`;
    }
  } else if (rec.state === "decrypting" || rec.state === "counted") {
    out.line(row("Closed by", list(rec.closedBy ?? [])));
    const posted = new Set((shares?.shares ?? []).map((s) => s.msp));
    out.line(row("Shares", msps.map((m) => `${m} ${posted.has(m) ? "posted" : "waiting"}`).join("   ")));
    if (rec.state === "decrypting") {
      if (mine && !posted.has(env.identity.msp)) next = `Run ${CMD} decrypt --election ${id} to post your decryption share.`;
      else if (posted.size < rec.threshold) next = `The tally needs ${rec.threshold} of ${msps.length} shares: waiting for ${list(msps.filter((m) => !posted.has(m)))}.`;
      else next = `Run ${CMD} publish --election ${id} to publish the tally.`;
    } else {
      out.line();
      for (const l of countLines(rec)) out.line(l);
      if (report.saved.keyShare) next = `Run ${CMD} destroy --election ${id} to delete your key share.`;
    }
  } else if (state.exists()) {
    next = `Run ${CMD} destroy --election ${id} to delete what this machine saved for it.`;
  }
  if (next) {
    out.line();
    out.line(next);
  }
  return 0;
}

/* ---------- create ---------- */

export interface CreateOptions {
  election: string;
  title: string;
  options: string[];
  closesAt: string;
  trustees: string[];
  threshold?: number;
  voters?: string[];
}

/** A time as the contract wants it, 2027-01-31T17:00:00.000Z, or null. */
export function contractTime(text: string): string | null {
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function create(env: Env, o: CreateOptions): Promise<number> {
  requireTrustee(env.identity);
  const closesAt = contractTime(o.closesAt);
  if (!closesAt) throw new Failure(`${o.closesAt} isn't a time.`, "Give --closes-at in the form 2027-01-31T17:00:00.000Z.");
  // The contract compares closesAt with the transaction's timestamp, which this machine's clock sets.
  if (new Date(closesAt) <= env.now()) throw new Failure(`${when(closesAt)} has already passed.`, "Nothing was posted. Give a --closes-at in the future.");
  const n = o.trustees.length;
  const threshold = o.threshold ?? Math.floor(n / 2) + 1;
  const voters = o.voters?.length ? o.voters : o.trustees;
  const electionJson = JSON.stringify({
    id: o.election,
    title: o.title,
    options: o.options,
    closesAt,
    trustees: o.trustees,
    threshold,
    voters: { kind: "x509", msps: voters },
  });
  const r = await post(env, "CreateElection", [electionJson]);
  const rec = JSON.parse(r.result) as ElectionRecord;
  env.out.done(`Created ${rec.id} in block ${r.block}. It stays in keygen until the key ceremony ends. Transaction ${shortTx(r.txId)}.`);
  env.out.line();
  env.out.line(row("Trustees", trusteesLine(rec)));
  env.out.line(row("Voters", `X.509 identities of ${list(voters)}`));
  env.out.line(row("Closing", `${when(rec.closesAt)}, planned. Voting stays open until ${rec.threshold} trustees close it.`));
  env.out.line();
  env.out.line(`Each trustee now runs ${CMD} commit --election ${rec.id} to post round 1.`);
  return 0;
}

/* ---------- round 1: commit ---------- */

export interface ElectionOptions {
  election: string;
}

export async function commit(env: Env, o: ElectionOptions): Promise<number> {
  requireTrustee(env.identity);
  const rec = await getElection(env, o.election);
  requireKeygen(rec);
  const i = trusteeIndex(env, rec);
  const cer = await getCeremony(env, o.election);
  if (cer.trustees[i]!.round1) {
    throw new Failure(`${env.identity.msp} has already posted round 1.`, `Nothing was posted. Run ${CMD} status --election ${rec.id} to see what the ceremony is waiting for.`);
  }
  const state = stateFor(env, o.election);
  const setup = setupOf(env, rec);
  let postArg: Round1Post;
  if (state.has("ceremony")) {
    // An earlier commit saved round 1 and didn't post it: post the same again.
    const pass = await askPassphrase(env, state, false);
    await openSecret<TrusteeSecret>(env, state, "ceremony", pass);
    const saved = state.readPublic<Round1Post>("round1");
    if (!saved) throw new Failure(`${state.shown} has a ceremony key and no round 1 to post.`, `Delete the folder with ${CMD} destroy --election ${rec.id} --force, then run this again.`);
    postArg = saved;
    env.out.line(`Found the round 1 an earlier run saved in ${state.shown}, and posted it.`);
  } else {
    if (state.has("key-share")) throw new Failure(`${state.shown} already holds a key share for ${rec.id}.`, "Nothing was posted.");
    const pass = await askPassphrase(env, state, true);
    const { post: p, secret } = ceremonyRound1(setup, i);
    await state.write("ceremony", secret, pass);
    state.writePublic("round1", p);
    postArg = p;
    env.out.line(`Drew a polynomial of degree ${rec.threshold - 1} and a one-time ceremony key, and saved them, encrypted, in ${state.shown}.`);
  }
  const r = await post(env, "PostCommitments", [rec.id, JSON.stringify(postArg)]);
  env.out.done(`Posted round 1 in block ${r.block}: ${plural(postArg.commitments.length, "commitment")}, a proof of knowledge and the one-time public key. Transaction ${shortTx(r.txId)}.`);
  const after = await getCeremony(env, o.election);
  const waiting = waitingFor(after, "round1");
  env.out.line();
  env.out.line(
    waiting.length
      ? `Waiting for ${list(waiting)} to post round 1. ${CMD} status says when ${waiting.length === 1 ? "it has" : "they have"}; then run ${CMD} share --election ${rec.id}.`
      : `Every trustee has posted round 1. Run ${CMD} share --election ${rec.id} to post round 2.`,
  );
  return 0;
}

/* ---------- round 2: share ---------- */

export async function share(env: Env, o: ElectionOptions): Promise<number> {
  requireTrustee(env.identity);
  const rec = await getElection(env, o.election);
  requireKeygen(rec);
  const i = trusteeIndex(env, rec);
  const cer = await getCeremony(env, o.election);
  if (waitingFor(cer, "round1").length) throw roundNotFinished(cer, "round1");
  if (cer.trustees[i]!.round2) {
    throw new Failure(`${env.identity.msp} has already posted round 2.`, `Nothing was posted. Run ${CMD} confirm --election ${rec.id} once every trustee has.`);
  }
  const state = stateFor(env, o.election);
  const others = rec.trustees.filter((_, j) => j !== i).map((t) => t.msp);
  if (!state.has("ceremony")) {
    throw new Failure(
      `The state folder has no one-time ceremony key, so Weft can't make the shares for ${list(others)}. The creator can cancel ${rec.id} with ${CMD} cancel and create a new election.`,
    );
  }
  const pass = await askPassphrase(env, state, false);
  const secret = await openSecret<TrusteeSecret>(env, state, "ceremony", pass);
  let p: Round2Post;
  try {
    p = await ceremonyRound2(setupOf(env, rec), secret, cer.trustees.map((t) => t.round1!));
  } catch (err) {
    throw notThisRun(err, state, env.identity.msp);
  }
  env.out.line(others.length === 1 ? `Encrypted a share for ${others[0]} to its one-time key.` : `Encrypted a share for each of ${list(others)} to its one-time key.`);
  const r = await post(env, "PostShares", [rec.id, JSON.stringify(p)]);
  env.out.done(`Posted round 2 in block ${r.block}: ${plural(p.shares.length, "encrypted share")}. Transaction ${shortTx(r.txId)}.`);
  const waiting = waitingFor(await getCeremony(env, o.election), "round2");
  env.out.line();
  env.out.line(
    waiting.length
      ? `Waiting for ${list(waiting)} to post round 2; then run ${CMD} confirm --election ${rec.id}.`
      : `Every trustee has posted round 2. Run ${CMD} confirm --election ${rec.id} to post round 3.`,
  );
  return 0;
}

/** A state folder whose round 1 isn't the one on the ledger. */
function notThisRun(err: unknown, state: ElectionState, msp: string): unknown {
  if (err instanceof RangeError && /isn't the one this state posted|another election/.test(err.message)) {
    return new Failure(`The round 1 on the ledger for ${msp} isn't the one saved in ${state.shown}.`, "That folder is from another run of this election. Nothing was posted.");
  }
  return err;
}

/* ---------- round 3: confirm ---------- */

export async function confirm(env: Env, o: ElectionOptions): Promise<number> {
  requireTrustee(env.identity);
  const rec = await getElection(env, o.election);
  requireKeygen(rec);
  const i = trusteeIndex(env, rec);
  const cer = await getCeremony(env, o.election);
  if (waitingFor(cer, "round1").length) throw roundNotFinished(cer, "round1");
  if (waitingFor(cer, "round2").length) throw roundNotFinished(cer, "round2");
  const msp = env.identity.msp;
  if (cer.trustees[i]!.confirmation) throw new Failure(`${msp} has already posted round 3.`, `Nothing was posted. Run ${CMD} status --election ${rec.id} to see what the ceremony is waiting for.`);
  const state = stateFor(env, o.election);
  const others = rec.trustees.filter((_, j) => j !== i).map((t) => t.msp);
  let confirmation: ConfirmationPost;
  let keys: { publicKey: string; verifyingShares: readonly string[] } | null = null;
  const saved = state.readPublic<ConfirmationPost>("confirmation");
  if (state.has("key-share") && saved) {
    // An earlier confirm saved the key share and didn't post: post the same proof again.
    confirmation = saved;
    if (state.has("ceremony")) state.remove("ceremony");
    env.out.line(`Found your key share and the round 3 an earlier run saved in ${state.shown}, and posted it.`);
  } else {
    if (!state.has("ceremony")) {
      throw new Failure(
        `The state folder has no one-time ceremony key, so Weft can't decrypt the share${others.length === 1 ? "" : "s"} ${list(others)} sent you. The creator can cancel ${rec.id} with ${CMD} cancel and create a new election.`,
      );
    }
    const pass = await askPassphrase(env, state, false);
    const secret = await openSecret<TrusteeSecret>(env, state, "ceremony", pass);
    let result;
    try {
      result = await ceremonyRound3(setupOf(env, rec), secret, cer.trustees.map((t) => t.round1!), cer.trustees.map((t) => t.round2));
    } catch (err) {
      if (err instanceof BadShareError) {
        const from = rec.trustees[err.from]!;
        env.out.failed(err.message);
        const r = await post(env, "ReportBadShare", [rec.id, from.id]);
        env.out.done(`Posted a report in block ${r.block}. ${rec.id} is now failed, and it can't open.`);
        env.out.line(`  Find out why with ${from.msp}, then create a new election under a new ID.`);
        return 1;
      }
      throw notThisRun(err, state, msp);
    }
    env.out.line(
      others.length === 1
        ? `Decrypted the share from ${others[0]} and checked it against ${others[0]}'s round 1 commitments.`
        : `Decrypted the shares from ${list(others)} and checked each against its sender's round 1 commitments.`,
    );
    await state.write("key-share", result.keyShare, pass);
    state.writePublic("confirmation", result.confirmation);
    state.remove("ceremony");
    env.out.line("Saved your key share, encrypted, and deleted the one-time ceremony key.");
    confirmation = result.confirmation;
    keys = result.keys;
  }
  const r = await post(env, "ConfirmShares", [rec.id, JSON.stringify(confirmation)]);
  const after = await getCeremony(env, o.election);
  const waiting = waitingFor(after, "confirmation");
  if (waiting.length) {
    env.out.done(`Posted round 3 in block ${r.block}: a proof that you hold your key share. Transaction ${shortTx(r.txId)}.`);
    env.out.line();
    env.out.line(`Waiting for ${list(waiting)} to confirm. The election opens once ${waiting.length === 1 ? "it has" : "they have"}.`);
    return 0;
  }
  env.out.done(`Posted round 3 in block ${r.block}.`);
  return openAndShow(env, rec.id, keys, true);
}

/* ---------- open ---------- */

/** Calls OpenElection, unless another trustee already has, and shows the fingerprint after checking it. */
async function openAndShow(env: Env, id: string, keys: { publicKey: string } | null, afterConfirm: boolean): Promise<number> {
  const ledger = await env.ledger();
  let rec: ElectionRecord;
  let block: bigint | null = null;
  try {
    const r = await ledger.submit("OpenElection", id);
    rec = JSON.parse(r.result) as ElectionRecord;
    block = r.block;
  } catch (err) {
    if (err instanceof Refusal && err.message === "The key ceremony has ended: the election is in open.") rec = await getElection(env, id);
    else if (err instanceof Refusal) throw new Failure(err.message, `Run ${CMD} open --election ${id} to try again.`);
    else if (err instanceof ValidationFailure) throw new Failure(`Opening ${id} failed validation (${err.code}), so it changed nothing.`, `Run ${CMD} open --election ${id}.`);
    else throw err;
  }
  const fingerprint = electionFingerprint(electionOf(env, rec));
  if (rec.fingerprint !== fingerprint || (keys && keys.publicKey !== rec.publicKey)) {
    throw new Failure(
      `The election key on the ledger isn't the one weft-trustee works out from the key ceremony.`,
      `Don't let anyone vote in ${id}, and tell the other trustees.`,
    );
  }
  const lead = afterConfirm ? "Every trustee has confirmed. " : "";
  env.out.done(block === null ? `${lead}${id} is already open.` : `${lead}Opened ${id} in block ${block}.`);
  env.out.line();
  env.out.line(`Election key fingerprint   ${formatFingerprint(fingerprint)}`);
  env.out.line(`Compare it with the fingerprint on any explorer's page for ${id}.`);
  env.out.line(
    env.now() < new Date(rec.closesAt)
      ? `Voting is open until ${when(rec.closesAt)}.`
      : `Its planned closing time, ${when(rec.closesAt)}, has passed: voting stays open until ${rec.threshold} trustees run ${CMD} close.`,
  );
  return 0;
}

export async function open(env: Env, o: ElectionOptions): Promise<number> {
  const rec = await getElection(env, o.election);
  if (rec.state !== "keygen") {
    if (rec.state === "open") return openAndShow(env, rec.id, null, false);
    throw new Failure(`The key ceremony has ended: the election is in ${rec.state}.`);
  }
  const cer = await getCeremony(env, o.election);
  for (const round of ["round1", "round2", "confirmation"] as const) {
    const waiting = waitingFor(cer, round);
    if (waiting.length) {
      throw new Failure(`Round ${ROUND_NAMES[round]} isn't finished: waiting for ${waiting[0]}.`, `Nothing was posted. The election opens once ${list(waiting)} ${waiting.length === 1 ? "has" : "have"} posted round ${ROUND_NAMES[round]}.`);
    }
  }
  return openAndShow(env, rec.id, null, false);
}

/* ---------- close ---------- */

export interface CloseOptions extends ElectionOptions {
  early?: boolean;
}

export async function close(env: Env, o: CloseOptions): Promise<number> {
  requireTrustee(env.identity);
  const rec = await getElection(env, o.election);
  if (rec.state === "decrypting" || rec.state === "counted") {
    throw new Failure(`Voting has already closed: the election is in ${rec.state}.`, rec.state === "decrypting" ? `Each trustee can now post its decryption share with ${CMD} decrypt.` : `Run ${CMD} status --election ${rec.id} to see the tally.`);
  }
  if (rec.state !== "open") throw new Failure(`The election isn't open: it is in ${rec.state}.`);
  const i = trusteeIndex(env, rec);
  const before = await getCeremony(env, o.election);
  if (before.trustees[i]!.closeRequested) {
    const left = rec.threshold - before.trustees.filter((t) => t.closeRequested).length;
    throw new Failure(`${env.identity.msp} has already asked to close voting.`, `Nothing was posted. Voting closes when ${plural(left, "more trustee")} ${left === 1 ? "asks" : "ask"}.`);
  }
  const early = env.now() < new Date(rec.closesAt);
  if (early && !o.early) {
    throw new Failure(`Voting is open until ${rec.closesAt}.`, `Nothing was posted. Run this again after ${when(rec.closesAt)}, or add --early to close it now.`);
  }
  const ledger = await env.ledger();
  let r: Submitted;
  try {
    r = await ledger.submit("CloseElection", rec.id);
  } catch (err) {
    if (err instanceof ValidationFailure && err.code === "PHANTOM_READ_CONFLICT") {
      throw new Failure(`The close failed validation: a ballot was committed while it was being endorsed (PHANTOM_READ_CONFLICT). Run ${CMD} close again.`);
    }
    if (err instanceof ValidationFailure && err.code === "MVCC_READ_CONFLICT") {
      throw new Failure(`The close failed validation: another trustee's request was committed while it was being endorsed (MVCC_READ_CONFLICT). Run ${CMD} close again.`);
    }
    if (err instanceof Refusal) throw new Failure(err.message, "Nothing was posted.");
    if (err instanceof ValidationFailure) throw new Failure(`The close failed validation (${err.code}), so it changed nothing.`, `Run ${CMD} close again.`);
    throw err;
  }
  const after = JSON.parse(r.result) as ElectionRecord;
  const n = rec.trustees.length;
  if (after.state === "decrypting") {
    env.out.done(`Closed ${rec.id} in block ${r.block}: ${after.closedBy?.length ?? rec.threshold} of ${n} trustees asked. Added up ${plural(after.ballots ?? 0, "ballot")} per option.`);
    if (early) env.out.line(`That is before its planned closing time, ${when(rec.closesAt)}. Explorers show the block it closed in beside that time.`);
    env.out.line(`Each trustee can now post its decryption share with ${CMD} decrypt.`);
    return 0;
  }
  const cer = await getCeremony(env, o.election);
  const asked = cer.trustees.filter((t) => t.closeRequested).length;
  env.out.done(`Asked to close ${rec.id} in block ${r.block}. ${asked} of ${n} trustees have asked; voting closes when ${rec.threshold} have.`);
  return 0;
}

/* ---------- decrypt ---------- */

export async function decrypt(env: Env, o: ElectionOptions): Promise<number> {
  requireTrustee(env.identity);
  const rec = await getElection(env, o.election);
  if (rec.state === "open") {
    const before = env.now() < new Date(rec.closesAt);
    throw new Failure(
      before ? `${rec.id} isn't counting yet: it is open until ${when(rec.closesAt)}.` : `${rec.id} isn't counting yet: it is still open, past its planned closing time, ${when(rec.closesAt)}.`,
      before ? `Run ${CMD} close after that time, then this command.` : `Run ${CMD} close, then this command.`,
    );
  }
  if (rec.state === "keygen") throw new Failure("Voting hasn't closed yet: the election is in keygen, and decryption shares are posted once it is in decrypting.");
  if (rec.state === "counted") throw new Failure("The tally is already published.", `Run ${CMD} status --election ${rec.id} to see it.`);
  if (rec.state !== "decrypting") throw new Failure(`The election is in ${rec.state}: decryption shares are posted while it is in decrypting.`);
  const i = trusteeIndex(env, rec);
  const msp = env.identity.msp;
  const posted = await getShares(env, o.election);
  if (posted.shares.some((s) => s.msp === msp)) {
    throw new Failure(`${msp} has already posted its decryption share.`, posted.shares.length >= rec.threshold ? `Run ${CMD} publish --election ${rec.id} to publish the tally.` : "Nothing was posted.");
  }
  const state = stateFor(env, o.election);
  const n = rec.trustees.length;
  if (!state.has("key-share")) {
    const others = n - 1;
    throw new Failure(
      `There's no key share for ${rec.id} in ${state.shown}.`,
      rec.threshold === n
        ? `This election needs ${rec.threshold} of ${n} trustees, so it can't be counted without ${msp}'s share.`
        : `This election needs ${rec.threshold} of ${n} trustees, so it can still be counted if ${rec.threshold} of the other ${others} post theirs.`,
    );
  }
  const pass = await askPassphrase(env, state, false);
  const keyShare = await openSecret<KeyShare>(env, state, "key-share", pass);
  const election = electionOf(env, rec);
  let d: DecryptionSharePost;
  try {
    d = decryptionShare(election, keyShare, rec.totals!);
  } catch (err) {
    if (err instanceof RangeError) throw new Failure(`The key share in ${state.shown} isn't the one behind ${rec.trustees[i]!.msp}'s verifying share.`, "Nothing was posted.");
    throw err;
  }
  env.out.line(`Made a decryption share of each of the ${rec.options.length} totals, with a proof for each.`);
  const r = await post(env, "PostDecryptionShare", [rec.id, JSON.stringify(d)]);
  env.out.done(`Posted your decryption share in block ${r.block}. Transaction ${shortTx(r.txId)}.`);
  const after = await getShares(env, o.election);
  if (after.shares.length < rec.threshold) {
    const have = new Set(after.shares.map((s) => s.msp));
    env.out.line();
    env.out.line(`The tally needs ${rec.threshold} of ${n} shares: waiting for ${list(rec.trustees.map((t) => t.msp).filter((m) => !have.has(m)))}.`);
    return 0;
  }
  return publishAndShow(env, rec.id, `${after.shares.length} of ${n} shares are in. `);
}

/* ---------- publish ---------- */

async function publishAndShow(env: Env, id: string, lead: string): Promise<number> {
  const ledger = await env.ledger();
  let rec: ElectionRecord;
  let block: bigint | null = null;
  try {
    const r = await ledger.submit("PublishTally", id);
    rec = JSON.parse(r.result) as ElectionRecord;
    block = r.block;
  } catch (err) {
    if (err instanceof Refusal && err.message === "The tally is already published.") rec = await getElection(env, id);
    else if (err instanceof Refusal) throw new Failure(err.message, `Run ${CMD} publish --election ${id} to try again.`);
    else if (err instanceof ValidationFailure) throw new Failure(`Publishing the tally failed validation (${err.code}), so it changed nothing.`, `Run ${CMD} publish --election ${id}.`);
    else throw err;
  }
  await checkTally(env, rec);
  env.out.done(block === null ? `${lead}The tally is already published.` : `${lead}Published the tally in block ${block}.`);
  env.out.line();
  for (const l of countLines(rec)) env.out.line(l);
  if (stateFor(env, id).has("key-share")) {
    env.out.line();
    env.out.line(`Run ${CMD} destroy --election ${id} to delete your key share.`);
  }
  return 0;
}

/** Works out the counts again from the shares on the ledger, with @weftwallet/tally, and compares them with the record. */
async function checkTally(env: Env, rec: ElectionRecord): Promise<void> {
  const election = electionOf(env, rec);
  const { shares } = await getShares(env, rec.id);
  const posted = shares.map((s) => {
    const index = rec.trustees.findIndex((t) => t.msp === s.msp);
    return { index, share: checkDecryptionShare(election, rec.totals!, index, JSON.stringify({ shares: s.shares })) };
  });
  const result = recoverTally(election, rec.totals!, rec.ballots!, posted);
  const counts = rec.options.map((o) => rec.tally!.counts[o]);
  if (result.counts.some((c, j) => c !== counts[j]) || result.total !== rec.tally!.total) {
    throw new Failure(`The counts in ${rec.id}'s record aren't the ones weft-trustee works out from the decryption shares.`, "Tell the other trustees.");
  }
}

export async function publish(env: Env, o: ElectionOptions): Promise<number> {
  const rec = await getElection(env, o.election);
  if (rec.state === "counted") return publishAndShow(env, rec.id, "");
  if (rec.state !== "decrypting") throw new Failure(`The tally can't be published: the election is in ${rec.state}.`);
  const posted = await getShares(env, o.election);
  if (posted.shares.length < rec.threshold) {
    const m = posted.shares.length;
    throw new Failure(`The tally needs ${rec.threshold} decryption shares; ${m} ${m === 1 ? "has" : "have"} been posted.`, `Each trustee posts its share with ${CMD} decrypt.`);
  }
  return publishAndShow(env, rec.id, "");
}

/* ---------- cancel ---------- */

export async function cancel(env: Env, o: ElectionOptions): Promise<number> {
  requireTrustee(env.identity);
  const rec = await getElection(env, o.election);
  requireKeygen(rec);
  if (rec.creatorMsp !== env.identity.msp) throw new Failure(`${env.identity.msp} didn't create this election, so it can't cancel it.`, `Ask ${rec.creatorMsp}'s trustee.`);
  const r = await post(env, "CancelElection", [rec.id]);
  env.out.done(`Cancelled ${rec.id} in block ${r.block}. It can't open, and no one can vote in it.`);
  env.out.line(`Each trustee can delete what it saved for ${rec.id} with ${CMD} destroy --election ${rec.id}.`);
  return 0;
}

/* ---------- destroy ---------- */

export interface DestroyOptions extends ElectionOptions {
  force?: boolean;
  yes?: boolean;
}

export async function destroy(env: Env, o: DestroyOptions): Promise<number> {
  const state = stateFor(env, o.election);
  const msp = env.identity.msp;
  if (!state.exists()) throw new Failure(`There's nothing saved for ${o.election} in ${state.shown}.`, "Nothing was deleted.");
  const keyShare = state.has("key-share");
  if (!o.force) {
    const rec = await getElection(env, o.election);
    const over = rec.state === "counted" || rec.state === "failed" || rec.state === "cancelled";
    if (!over && keyShare) {
      throw new Failure(`The tally for ${o.election} isn't published yet, so Weft kept your key share.`, "Without it the election may not be counted. Run this again after the tally, or add --force to delete it now.");
    }
    if (!over && rec.state === "keygen") {
      throw new Failure(`${o.election} is still in its key ceremony, so Weft kept your one-time ceremony key.`, "Without it you can't finish the ceremony. Run this again once the election is cancelled, or add --force to delete it now.");
    }
  }
  env.out.line(
    keyShare
      ? `This deletes ${msp}'s key share for ${o.election} from ${state.shown}. Without it, ${msp} can't take part in decrypting anything from this election again. No one else can check that it was deleted.`
      : `This deletes what ${msp} saved for ${o.election} in ${state.shown}, including any one-time ceremony key. No one else can check that it was deleted.`,
  );
  if (!o.yes) {
    const typed = await env.prompt.line("Type the election ID to delete it: ");
    if (typed !== o.election) throw new Failure(`That isn't ${o.election}, so nothing was deleted.`);
  }
  state.destroy();
  env.out.done(keyShare ? "Deleted the key share and the state folder." : "Deleted the state folder.");
  return 0;
}
