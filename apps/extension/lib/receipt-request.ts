/**
 * A ballot receipt sent with weft_submit (docs/adr/0006), read in the worker
 * before any window opens. Pure, so it is tested without a browser.
 */

import { ReceiptError, checkReceiptRequest, fillGeneratedSalt, receiptInput } from "@weftwallet/core";
import { ErrorCode, WeftError, type BallotReceiptRequest, type ContractCall } from "@weftwallet/protocol";

export interface ReceiptAsked {
  /** Checked against the call; a salt Weft generated is filled in. */
  request: BallotReceiptRequest;
  /** The private input the option and salt come from. */
  input: string;
  /** Weft chose the salt (the site sent "generate"). */
  generated: boolean;
}

/**
 * The call, with a generated salt filled in, and the receipt checked against
 * it; `receipt` is null when the request had none. Anything wrong fails with
 * InvalidParams naming the field, before a window opens.
 */
export function parseReceipt(
  method: "weft_evaluate" | "weft_submit",
  call: ContractCall,
  params: unknown,
  salt?: string,
): { call: ContractCall; receipt: ReceiptAsked | null } {
  const asked = (params as { receipt?: unknown } | null | undefined)?.receipt;
  if (asked === undefined) return { call, receipt: null };
  if (method !== "weft_submit") {
    throw new WeftError(ErrorCode.InvalidParams, 'Only weft_submit takes a "receipt": a read has nothing to record.');
  }
  try {
    const filled = fillGeneratedSalt(call, checkReceiptRequest(call, asked), salt);
    return { call: filled.call, receipt: { request: filled.receipt, input: receiptInput(filled.call, filled.receipt)!, generated: filled.generated } };
  } catch (error) {
    if (error instanceof ReceiptError) throw new WeftError(ErrorCode.InvalidParams, error.message);
    throw error;
  }
}

/** What is sealed: the only secret part of a receipt. */
export function receiptSecret(receipt: Pick<BallotReceiptRequest, "option" | "salt">): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ option: receipt.option, salt: receipt.salt }));
}
