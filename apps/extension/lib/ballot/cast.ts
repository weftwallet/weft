/**
 * Experimental (docs/adr/0007): the relay flows of weft_castBallot. Reading
 * the election endorses GetElection and submits nothing; casting proposes
 * CastBallot, checks the proposal is exactly the ballot Weft made, then
 * signs, endorses, submits and waits for the commit, as weft_submit does.
 * The relay is passed in, so the flows are tested with a recorded one.
 */

import {
  CommitError,
  Message,
  VerificationError,
  decodePreparedTransaction,
  decodeProposedTransaction,
  decodeSignedCommitStatusRequest,
  fromBase64,
  toBase64,
  verifyCommitRequest,
  verifyProposal,
  verifyTransaction,
  type FlowProgress,
  type RelayClient,
  type Signer,
} from "@weftwallet/core";
import type { CastBallotParams, ContractCall, RelaySigner } from "@weftwallet/protocol";
import type { Election } from "@weftwallet/tally";
import { RecordError, checkAnswer, creatorIdBytes, decodeEndorsedAnswer, electionFrom, parseElectionRecord, type ElectionRecord, type Endorsers } from "./read";

/** The relay calls the flows use, so tests can pass a recorded relay. */
export type BallotRelay = Pick<RelayClient, "propose" | "endorse" | "submit" | "commitStatus">;

export interface ReadElection {
  record: ElectionRecord;
  /** For an open record: the election to encrypt under, and its fingerprint. */
  open: { election: Election; fingerprint: string } | null;
  /** The creator's id_bytes in the proposal the relay built, which the voter tag is made from. */
  idBytes: Uint8Array;
  /** A peer of the voter's organisation signed the answer, and Weft checked it. */
  peerChecked: boolean;
  /** The organisations whose peer signatures Weft checked. */
  checked: string[];
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * ChaincodeInput.args of a proposal, as bytes: Proposal.payload = 2 ->
 * ChaincodeProposalPayload.input = 1 -> ChaincodeInvocationSpec.chaincode_spec = 1
 * -> ChaincodeSpec.input = 3 -> ChaincodeInput.args = 1.
 */
function proposalArgs(proposalBytes: Uint8Array): Uint8Array[] {
  return new Message(proposalBytes).message(2).message(1).message(1).message(3).repeatedBytes(1);
}

/**
 * Proposes `call` and checks the proposal before anything is signed: ADR
 * 0001's check, then the function name and every argument byte for byte.
 */
async function proposeChecked(relay: BallotRelay, signer: RelaySigner, call: ContractCall) {
  const proposed = await relay.propose(signer, call);
  const decoded = decodeProposedTransaction(fromBase64(proposed.proposal));
  verifyProposal(call, signer, decoded);
  const sent = [call.fn, ...(call.args ?? [])].map((a) => new TextEncoder().encode(a));
  const got = proposalArgs(decoded.signable);
  if (got.length !== sent.length || got.some((g, i) => !sameBytes(g, sent[i]!))) {
    throw new VerificationError("arguments", "the arguments Weft made, byte for byte", "different bytes");
  }
  return { proposal: proposed.proposal, decoded };
}

/**
 * Reads the election: endorses GetElection without submitting, checks the
 * peers' signed answer, and reads the record from inside the signed bytes.
 * `trust` is what the answer's signatures are checked against: the CA chain
 * kept for an X.509 voter's identity, or null for none; for a voter
 * credential, the trustee organisations' CA chains from the voter invite
 * (docs/adr/0008, D9), every endorsement checked.
 */
export async function readElection(
  relay: BallotRelay,
  signer: RelaySigner,
  params: CastBallotParams,
  sign: Signer,
  trust: string | null | { endorsers: Endorsers },
  now = new Date(),
): Promise<ReadElection> {
  const call: ContractCall = { channel: params.channel, chaincode: params.chaincode, fn: "GetElection", args: [params.electionId] };
  const { proposal, decoded } = await proposeChecked(relay, signer, call);
  const endorsed = await relay.endorse(signer, proposal, toBase64(await sign(decoded.signable)));
  const prepared = fromBase64(endorsed.transaction);
  verifyTransaction(decoded, signer, decodePreparedTransaction(prepared));
  let answer;
  try {
    answer = decodeEndorsedAnswer(prepared);
  } catch (error) {
    if (error instanceof RecordError) throw error;
    throw new RecordError("signature", `Weft couldn't decode the peers' answer: ${error instanceof Error ? error.message : String(error)}.`);
  }
  const chain = typeof trust === "string" ? trust : null;
  const endorsers = trust !== null && typeof trust === "object" ? { endorsers: trust.endorsers } : {};
  const { text, peerChecked, checked } = await checkAnswer(answer, { proposal: decoded.signable, chaincode: params.chaincode, mspId: signer.mspId, chain, ...endorsers, now });
  const record = parseElectionRecord(text, params.electionId);
  const open = record.state === "open" ? electionFrom(record, params.channel, params.chaincode) : null;
  return { record, open, idBytes: creatorIdBytes(decoded.signable), peerChecked, checked };
}

export interface CastResult {
  transactionId: string;
  blockNumber: string;
  status: string;
  /** The contract's answer from the peers' signed response: { electionId, txId, tracking }. */
  text: string | null;
}

/**
 * Casts the ballot: `call` is CastBallot with the ballot Weft made, or
 * CastAnonymousBallot with the ballot and the pseudonym proof. Before
 * signing, the proposal must carry exactly those arguments and the creator's
 * id_bytes must be exactly `idBytes`: for an X.509 voter the bytes the voter
 * tag was made from, since a ballot bound to another tag would be refused by
 * the contract; for a voter credential the one-off identity Weft made for
 * this transaction, which the pseudonym proof is bound to.
 */
export async function castBallotCall(
  relay: BallotRelay,
  signer: RelaySigner,
  call: ContractCall,
  sign: Signer,
  idBytes: Uint8Array,
  progress: FlowProgress = {},
): Promise<CastResult> {
  progress.onStage?.("proposing");
  const { proposal, decoded } = await proposeChecked(relay, signer, call);
  if (!sameBytes(creatorIdBytes(decoded.signable), idBytes)) {
    throw new VerificationError("signing certificate's bytes", "the bytes the voter tag was made from", "different bytes");
  }
  const signature = toBase64(await sign(decoded.signable));

  progress.onStage?.("endorsing");
  const endorsed = await relay.endorse(signer, proposal, signature);
  const prepared = fromBase64(endorsed.transaction);
  const tx = decodePreparedTransaction(prepared);
  verifyTransaction(decoded, signer, tx);
  let text: string | null = null;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(decodeEndorsedAnswer(prepared).payload);
  } catch {
    text = null;
  }

  progress.onStage?.("submitting");
  const submitted = await relay.submit(signer, endorsed.transaction, toBase64(await sign(tx.signable)));
  const commit = decodeSignedCommitStatusRequest(fromBase64(submitted.commit));
  verifyCommitRequest(decoded, commit);

  progress.onStage?.("committing");
  const status = await relay.commitStatus(signer, submitted.commit, toBase64(await sign(commit.signable)));
  if (!status.successful) throw new CommitError(status);
  progress.onStage?.("done");
  return { transactionId: status.transactionId, blockNumber: status.blockNumber, status: status.status, text };
}

/** The tracking code in the contract's answer to CastBallot, or null. */
export function returnedTracking(text: string | null): string | null {
  if (!text) return null;
  try {
    const t = (JSON.parse(text) as { tracking?: unknown }).tracking;
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}
