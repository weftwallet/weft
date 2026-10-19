/**
 * The wallet never signs bytes it has not checked. These functions compare
 * what the relay returned with what the user approved (docs/adr/0001).
 */

import type { ContractCall, RelaySigner } from "@weftwallet/protocol";
import type { DecodedCommitRequest, DecodedProposal, DecodedTransaction } from "./fabric-messages.js";

export class VerificationError extends Error {
  readonly field: string;

  constructor(field: string, expected: unknown, actual: unknown) {
    super(
      `Refusing to sign: ${field} does not match what you approved (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}).`,
    );
    this.name = "VerificationError";
    this.field = field;
  }
}

function normalizePem(pem: string): string {
  return pem.replace(/\r/g, "").trim();
}

/** The function name Fabric sees: "contract:fn" when a contract is named. */
export function qualifiedFunctionName(call: Pick<ContractCall, "contract" | "fn">): string {
  return call.contract ? `${call.contract}:${call.fn}` : call.fn;
}

export function verifyProposal(call: ContractCall, signer: RelaySigner, decoded: DecodedProposal): void {
  const check = (field: string, expected: unknown, actual: unknown) => {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new VerificationError(field, expected, actual);
  };
  check("channel", call.channel, decoded.channel);
  check("contract", call.chaincode, decoded.chaincode);
  check("function", qualifiedFunctionName(call), decoded.fn);
  check("arguments", call.args ?? [], decoded.args);
  check("transient data keys", Object.keys(call.transient ?? {}).sort(), [...decoded.transientKeys].sort());
  check("signing organisation", signer.mspId, decoded.creatorMspId);
  check("signing certificate", normalizePem(signer.certificate), normalizePem(decoded.creatorCertificate));
  check("transaction ID", decoded.transactionId, decoded.headerTransactionId);
  if (call.endorsingOrganizations?.length) {
    check("endorsing organisations", [...call.endorsingOrganizations].sort(), [...decoded.endorsingOrganizations].sort());
  }
}

export function verifyTransaction(
  proposal: Pick<DecodedProposal, "transactionId" | "channel">,
  signer: RelaySigner,
  decoded: DecodedTransaction,
): void {
  if (decoded.transactionId !== proposal.transactionId) {
    throw new VerificationError("transaction ID", proposal.transactionId, decoded.transactionId);
  }
  if (decoded.headerTransactionId !== proposal.transactionId) {
    throw new VerificationError("transaction header ID", proposal.transactionId, decoded.headerTransactionId);
  }
  if (decoded.channel !== proposal.channel) throw new VerificationError("channel", proposal.channel, decoded.channel);
  if (decoded.creatorMspId !== signer.mspId) {
    throw new VerificationError("signing organisation", signer.mspId, decoded.creatorMspId);
  }
  if (normalizePem(decoded.creatorCertificate) !== normalizePem(signer.certificate)) {
    throw new VerificationError("signing certificate", "your certificate", "a different certificate");
  }
}

export function verifyCommitRequest(
  proposal: Pick<DecodedProposal, "transactionId" | "channel">,
  decoded: DecodedCommitRequest,
): void {
  if (decoded.transactionId !== proposal.transactionId) {
    throw new VerificationError("transaction ID", proposal.transactionId, decoded.transactionId);
  }
  if (decoded.channel !== proposal.channel) throw new VerificationError("channel", proposal.channel, decoded.channel);
}
