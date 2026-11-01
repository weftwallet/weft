/**
 * Ballot receipts (docs/adr/0006). A voting dApp sends a receipt request
 * with weft_submit; Weft checks it against the call before any window opens,
 * fills in a salt when asked to, and after the commit adds the transaction,
 * the block and its own commitment.
 *
 * Everything here is pure, so the background worker and the tests share it.
 */

import {
  GENERATE_SALT,
  RECEIPT_TYPE,
  type BallotReceipt,
  type BallotReceiptRequest,
  type ContractCall,
} from "@weftwallet/protocol";
import { toArrayBuffer } from "./bytes.ts";

/** A receipt request that doesn't fit its call. The message names what to fix. */
export class ReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptError";
  }
}

/** The ballot contract's rule for a salt (examples/ballot-contract). */
export const SALT_PATTERN = /^[0-9a-f]{32,128}$/;
/** How many random bytes Weft draws for a salt it generates: 32 hex characters. */
export const GENERATED_SALT_BYTES = 16;
const MAX_OPTION = 200;
const FIELDS = ["type", "version", "channel", "electionId", "option", "salt"] as const;

/** A private input's value read as a JSON object, or null when it isn't one. */
function jsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The private inputs whose value is a JSON object with `"salt": "generate"`. */
function placeholders(call: ContractCall): { key: string; value: Record<string, unknown> }[] {
  return Object.entries(call.transient ?? {})
    .map(([key, raw]) => ({ key, value: jsonObject(raw) }))
    .filter((e): e is { key: string; value: Record<string, unknown> } => e.value?.salt === GENERATE_SALT);
}

/**
 * Checks a receipt request against the call it came with, in the order the
 * docs list, and returns it as a BallotReceiptRequest. Throws ReceiptError
 * naming the first thing wrong.
 */
export function checkReceiptRequest(call: ContractCall, value: unknown): BallotReceiptRequest {
  const fail = (message: string): never => {
    throw new ReceiptError(message);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail('The "receipt" parameter must be an object.');
  const r = value as Record<string, unknown>;
  if (r.type !== RECEIPT_TYPE || r.version !== 1) fail(`The receipt's "type" must be "${RECEIPT_TYPE}" and its "version" 1.`);

  // The six fields and no others, so a site can't store data of its own in Weft.
  const extra = Object.keys(r).find((k) => !(FIELDS as readonly string[]).includes(k));
  if (extra) fail(`The receipt has a field Weft doesn't keep: "${extra}". Send only type, version, channel, electionId, option and salt.`);
  const missing = FIELDS.find((k) => !(k in r));
  if (missing) fail(`The receipt needs "${missing}".`);
  for (const k of ["channel", "electionId", "option", "salt"] as const) {
    if (typeof r[k] !== "string") fail(`The receipt's "${k}" must be a string.`);
  }
  const receipt = r as unknown as BallotReceiptRequest;

  if (receipt.channel !== call.channel) fail(`The receipt is for the channel "${receipt.channel}", but the call is on "${call.channel}".`);
  if (!(call.args ?? []).includes(receipt.electionId)) fail(`The receipt's electionId "${receipt.electionId}" isn't one of the call's arguments.`);
  const generate = receipt.salt === GENERATE_SALT;
  if (!generate && !SALT_PATTERN.test(receipt.salt)) fail(`The receipt's salt must be 32 to 128 lowercase hex characters, or "${GENERATE_SALT}".`);
  if (receipt.option.length < 1 || receipt.option.length > MAX_OPTION) fail(`The receipt's option must be 1 to ${MAX_OPTION} characters.`);

  // Weft keeps only what the user signs.
  const marked = placeholders(call);
  if (generate) {
    if (marked.length > 1) fail(`More than one private input has "salt": "${GENERATE_SALT}". Weft fills in the salt of one.`);
    if (marked.length === 0 || marked[0]!.value.option !== receipt.option) {
      fail(`The receipt's salt is "${GENERATE_SALT}", but no private input of this call is a JSON object with its option and "salt": "${GENERATE_SALT}".`);
    }
  } else {
    if (marked.length > 0) fail(`A private input has "salt": "${GENERATE_SALT}", but the receipt's salt doesn't. Send "${GENERATE_SALT}" in both, or the same salt in both.`);
    if (!receiptInput(call, receipt)) {
      fail("The receipt's option and salt aren't the ones in any private input of this call. Weft keeps only what the user signs.");
    }
  }
  return { type: RECEIPT_TYPE, version: 1, channel: receipt.channel, electionId: receipt.electionId, option: receipt.option, salt: receipt.salt };
}

/** The name of the private input the receipt's option and salt come from, or null. */
export function receiptInput(call: ContractCall, receipt: Pick<BallotReceiptRequest, "option" | "salt">): string | null {
  for (const [key, raw] of Object.entries(call.transient ?? {})) {
    const value = jsonObject(raw);
    if (value && value.option === receipt.option && value.salt === receipt.salt) return key;
  }
  return null;
}

/** Lowercase hex of `length` random bytes, from crypto.getRandomValues. */
export function randomSalt(length = GENERATED_SALT_BYTES): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * For a checked request with `salt: "generate"`: draws a salt and puts it in
 * both places, the private input that has the placeholder and the receipt.
 * That input is written again with JSON.stringify, its keys in their order,
 * and the contract reads the same object with the salt filled in. A request
 * with its own salt comes back as it was.
 */
export function fillGeneratedSalt(
  call: ContractCall,
  receipt: BallotReceiptRequest,
  salt: string = randomSalt(),
): { call: ContractCall; receipt: BallotReceiptRequest; generated: boolean } {
  if (receipt.salt !== GENERATE_SALT) return { call, receipt, generated: false };
  if (!SALT_PATTERN.test(salt)) throw new ReceiptError("A generated salt must be 32 to 128 lowercase hex characters.");
  const marked = placeholders(call);
  if (marked.length !== 1 || marked[0]!.value.option !== receipt.option) throw new ReceiptError("Check the receipt request before filling in its salt.");
  const { key, value } = marked[0]!;
  return {
    call: { ...call, transient: { ...call.transient, [key]: JSON.stringify({ ...value, salt }) } },
    receipt: { ...receipt, salt },
    generated: true,
  };
}

/** The ballot contract's commitment: SHA-256 of the election ID, option and salt, joined by newlines, as hex. */
export async function ballotCommitment(electionId: string, option: string, salt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${electionId}\n${option}\n${salt}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The commitment a ballot contract returned ({ "commitment": "<64 hex>" }), or null when it returned none. */
export function contractCommitment(resultText: string | null): string | null {
  const value = resultText ? jsonObject(resultText) : null;
  const commitment = value?.commitment;
  return typeof commitment === "string" && /^[0-9a-f]{64}$/i.test(commitment) ? commitment.toLowerCase() : null;
}

/**
 * The finished receipt for a committed vote, and whether the contract's
 * commitment is the one Weft computed. The receipt always carries Weft's.
 */
export async function finishReceipt(
  request: BallotReceiptRequest,
  committed: { transactionId: string; blockNumber: string; text: string | null },
): Promise<{ receipt: BallotReceipt; matches: boolean; returned: string | null }> {
  const commitment = await ballotCommitment(request.electionId, request.option, request.salt);
  const returned = contractCommitment(committed.text);
  return {
    receipt: {
      type: RECEIPT_TYPE,
      version: 1,
      channel: request.channel,
      electionId: request.electionId,
      txId: committed.transactionId,
      blockNumber: Number(committed.blockNumber),
      commitment,
      option: request.option,
      salt: request.salt,
    },
    matches: returned === commitment,
    returned,
  };
}

/** The file name Download receipt uses, as Weft Playground names it. */
export function receiptFileName(receipt: Pick<BallotReceipt, "electionId" | "blockNumber">): string {
  return `weft-receipt-${receipt.electionId.replace(/[^A-Za-z0-9_-]/g, "-")}-block-${receipt.blockNumber}.json`;
}

/** The receipt as the file and the copied text hold it. */
export function receiptJson(receipt: BallotReceipt): string {
  return JSON.stringify(receipt, null, 2);
}
