/**
 * Client for the Weft relay plus the evaluate/submit flows that sit on top
 * of it. Each flow decodes and verifies every message before signing it.
 */

import {
  RELAY_PATHS,
  type ContractCall,
  type EvaluateResult,
  type RelayCommitStatusResponse,
  type RelayEndorseResponse,
  type RelayErrorResponse,
  type RelayEvaluateResponse,
  type RelayProposalResponse,
  type RelaySigner,
  type RelaySubmitResponse,
  type SubmitResult,
} from "@weftwallet/protocol";
import { fromBase64, toBase64, tryUtf8 } from "./bytes.ts";
import { decodePreparedTransaction, decodeProposedTransaction, decodeSignedCommitStatusRequest } from "./fabric-messages.ts";
import { explainEndorseError, explainStatus, type StatusExplanation } from "./status.ts";
import { verifyCommitRequest, verifyProposal, verifyTransaction } from "./verify.ts";

/** Signs Fabric message bytes (see signForFabric). Lets callers keep keys elsewhere. */
export type Signer = (message: Uint8Array) => Promise<Uint8Array>;

export class RelayError extends Error {
  readonly kind: string;
  readonly status: number;
  readonly explanation: StatusExplanation;
  readonly details: RelayErrorResponse["error"]["details"];

  constructor(status: number, body: RelayErrorResponse["error"]) {
    super(body.message);
    this.name = "RelayError";
    this.kind = body.kind;
    this.status = status;
    this.details = body.details;
    const detailText = body.details?.map((d) => d.message).join("; ") || body.message;
    this.explanation = explainEndorseError(detailText);
  }
}

/** A transaction that reached the orderer but did not commit as VALID. */
export class CommitError extends Error {
  readonly transactionId: string;
  readonly status: string;
  readonly blockNumber: string;
  readonly explanation: StatusExplanation;

  constructor(response: RelayCommitStatusResponse) {
    const explanation = explainStatus(response.status);
    super(explanation.title);
    this.name = "CommitError";
    this.transactionId = response.transactionId;
    this.status = response.status;
    this.blockNumber = response.blockNumber;
    this.explanation = explanation;
  }
}

export class RelayClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;

  constructor(baseUrl: string, fetchImpl?: typeof fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.fetch(`${this.baseUrl}${RELAY_PATHS.health}`);
      return response.ok;
    } catch {
      return false;
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new RelayError(0, { kind: "unreachable", message: `Could not reach the relay: ${String(cause)}` });
    }
    const json = (await response.json().catch(() => null)) as T | RelayErrorResponse | null;
    if (!response.ok) {
      const error = (json as RelayErrorResponse | null)?.error ?? {
        kind: "http",
        message: `Relay returned HTTP ${response.status}`,
      };
      throw new RelayError(response.status, error);
    }
    return json as T;
  }

  propose(signer: RelaySigner, call: ContractCall) {
    return this.post<RelayProposalResponse>(RELAY_PATHS.proposals, { signer, call });
  }
  evaluate(signer: RelaySigner, proposal: string, signature: string) {
    return this.post<RelayEvaluateResponse>(RELAY_PATHS.evaluate, { signer, proposal, signature });
  }
  endorse(signer: RelaySigner, proposal: string, signature: string) {
    return this.post<RelayEndorseResponse>(RELAY_PATHS.endorse, { signer, proposal, signature });
  }
  submit(signer: RelaySigner, transaction: string, signature: string) {
    return this.post<RelaySubmitResponse>(RELAY_PATHS.submit, { signer, transaction, signature });
  }
  commitStatus(signer: RelaySigner, commit: string, signature: string) {
    return this.post<RelayCommitStatusResponse>(RELAY_PATHS.commitStatus, { signer, commit, signature });
  }
}

function toResult(base64: string): EvaluateResult {
  return { base64, text: tryUtf8(fromBase64(base64)) };
}

/** Progress callbacks, so the UI can show "Approving… Ordering… Committed". */
export interface FlowProgress {
  onStage?(stage: "proposing" | "endorsing" | "submitting" | "committing" | "done"): void;
}

async function proposeAndSign(relay: RelayClient, signer: RelaySigner, call: ContractCall, sign: Signer) {
  const proposed = await relay.propose(signer, call);
  const decoded = decodeProposedTransaction(fromBase64(proposed.proposal));
  verifyProposal(call, signer, decoded);
  const signature = toBase64(await sign(decoded.signable));
  return { proposal: proposed.proposal, decoded, signature };
}

/** Read-only query: propose, sign, evaluate on one peer. Nothing is written. */
export async function evaluateCall(
  relay: RelayClient,
  signer: RelaySigner,
  call: ContractCall,
  sign: Signer,
  progress: FlowProgress = {},
): Promise<EvaluateResult> {
  progress.onStage?.("proposing");
  const { proposal, signature } = await proposeAndSign(relay, signer, call, sign);
  const { result } = await relay.evaluate(signer, proposal, signature);
  progress.onStage?.("done");
  return toResult(result);
}

/** Full write: propose, endorse, submit, wait for commit. Throws CommitError if not VALID. */
export async function submitCall(
  relay: RelayClient,
  signer: RelaySigner,
  call: ContractCall,
  sign: Signer,
  progress: FlowProgress = {},
): Promise<SubmitResult> {
  progress.onStage?.("proposing");
  const { proposal, decoded, signature } = await proposeAndSign(relay, signer, call, sign);

  progress.onStage?.("endorsing");
  const endorsed = await relay.endorse(signer, proposal, signature);
  const tx = decodePreparedTransaction(fromBase64(endorsed.transaction));
  verifyTransaction(decoded, signer, tx);

  progress.onStage?.("submitting");
  const submitted = await relay.submit(signer, endorsed.transaction, toBase64(await sign(tx.signable)));
  const commit = decodeSignedCommitStatusRequest(fromBase64(submitted.commit));
  verifyCommitRequest(decoded, commit);

  progress.onStage?.("committing");
  const status = await relay.commitStatus(signer, submitted.commit, toBase64(await sign(commit.signable)));
  if (!status.successful) throw new CommitError(status);

  progress.onStage?.("done");
  return {
    ...toResult(endorsed.result),
    transactionId: status.transactionId,
    blockNumber: status.blockNumber,
    status: status.status,
  };
}
