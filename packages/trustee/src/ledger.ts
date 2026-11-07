/**
 * The contract, as weft-trustee calls it: evaluate to read, submit to post,
 * through the organisation's own peer with @hyperledger/fabric-gateway and
 * the trustee identity, as the explorer's indexer connects. No relay.
 */
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import * as grpc from "@grpc/grpc-js";
import { connect, hash, signers, StatusCode, type Gateway } from "@hyperledger/fabric-gateway";
import type { Connection } from "./connection.ts";
import type { Identity } from "./identity.ts";

export interface Submitted {
  result: string;
  block: bigint;
  txId: string;
}

export interface Ledger {
  evaluate(fn: string, ...args: string[]): Promise<string>;
  submit(fn: string, ...args: string[]): Promise<Submitted>;
  close(): void;
}

/** The contract refused the call; the message is the contract's own. */
export class Refusal extends Error {
  override name = "Refusal";
}

/** The transaction was ordered but failed validation, so it changed nothing. */
export class ValidationFailure extends Error {
  override name = "ValidationFailure";
  readonly code: string;
  readonly txId: string;
  constructor(code: string, txId: string) {
    super(code);
    this.code = code;
    this.txId = txId;
  }
}

/** The peer didn't answer. */
export class Unreachable extends Error {
  override name = "Unreachable";
  readonly address: string;
  readonly reason: string;
  constructor(address: string, reason: string) {
    super(`${address}: ${reason}`);
    this.address = address;
    this.reason = reason;
  }
}

const STATUS_NAMES: Record<number, string> = Object.fromEntries(Object.entries(StatusCode).map(([name, code]) => [code, name]));

/** The contract's message from a refused endorsement or evaluation, or null if the error isn't one. */
export function contractMessage(err: unknown): string | null {
  const e = err as { details?: { message?: string }[]; message?: string };
  for (const text of [...(e?.details ?? []).map((d) => d.message ?? ""), e?.message ?? ""]) {
    const m = text.match(/chaincode response \d+, ([\s\S]*)$/);
    if (m) return m[1]!.trim();
  }
  return null;
}

const CONNECT_SECONDS = 10;

export async function gatewayLedger(conn: Connection, id: Identity): Promise<Ledger> {
  const options: grpc.ChannelOptions = conn.peerHostAlias ? { "grpc.ssl_target_name_override": conn.peerHostAlias } : {};
  let tls: Buffer;
  try {
    tls = readFileSync(conn.tlsCa);
  } catch {
    throw new Unreachable(conn.peer, `there's no TLS CA certificate at ${conn.tlsCa}`);
  }
  const client = new grpc.Client(conn.peer, grpc.credentials.createSsl(tls), options);
  await new Promise<void>((done, fail) =>
    client.waitForReady(Date.now() + CONNECT_SECONDS * 1000, (err) =>
      err ? (client.close(), fail(new Unreachable(conn.peer, `no answer within ${CONNECT_SECONDS} seconds`))) : done(),
    ),
  );
  let gateway: Gateway;
  try {
    gateway = connect({
      client,
      identity: { mspId: id.msp, credentials: Buffer.from(id.certificate) },
      signer: signers.newPrivateKeySigner(createPrivateKey(id.privateKey)),
      hash: hash.sha256,
      evaluateOptions: () => ({ deadline: Date.now() + 10_000 }),
      endorseOptions: () => ({ deadline: Date.now() + 30_000 }),
      submitOptions: () => ({ deadline: Date.now() + 10_000 }),
      commitStatusOptions: () => ({ deadline: Date.now() + 60_000 }),
    });
  } catch (err) {
    client.close();
    throw err;
  }
  const contract = gateway.getNetwork(conn.channel).getContract(conn.contract);
  const text = (b: Uint8Array) => Buffer.from(b).toString("utf8");
  const translate = (err: unknown): never => {
    const message = contractMessage(err);
    if (message !== null) throw new Refusal(message);
    const code = (err as { code?: number }).code;
    if (code === grpc.status.UNAVAILABLE || code === grpc.status.DEADLINE_EXCEEDED) throw new Unreachable(conn.peer, "it stopped answering");
    throw err;
  };
  return {
    async evaluate(fn, ...args) {
      try {
        return text(await contract.evaluateTransaction(fn, ...args));
      } catch (err) {
        return translate(err);
      }
    },
    async submit(fn, ...args) {
      let submitted;
      try {
        const endorsed = await contract.newProposal(fn, { arguments: args }).endorse();
        submitted = await endorsed.submit();
      } catch (err) {
        return translate(err);
      }
      const status = await submitted.getStatus();
      if (!status.successful) throw new ValidationFailure(STATUS_NAMES[status.code] ?? String(status.code), status.transactionId);
      return { result: text(submitted.getResult()), block: status.blockNumber, txId: status.transactionId };
    },
    close() {
      gateway.close();
      client.close();
    },
  };
}
