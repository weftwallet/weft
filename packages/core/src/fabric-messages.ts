/**
 * Decoders for the Fabric Gateway messages the wallet is asked to sign.
 *
 * Field numbers come from hyperledger/fabric-protos:
 *   gateway/gateway.proto, peer/proposal.proto, peer/chaincode.proto,
 *   common/common.proto, msp/identities.proto
 */

import { Message } from "./protobuf.js";

export interface DecodedProposal {
  /** From the gateway wrapper (ProposedTransaction.transaction_id). */
  transactionId: string;
  /** ChannelHeader.tx_id inside the proposal; must equal transactionId. */
  headerTransactionId: string;
  channel: string;
  chaincode: string;
  /** args[0] is the function name, as Fabric encodes it. */
  fn: string;
  args: string[];
  /** Keys of the transient map, in the order they were encoded. */
  transientKeys: string[];
  /** The transient map: private inputs the contract reads but the ledger never records. */
  transient: { key: string; value: Uint8Array }[];
  creatorMspId: string;
  /** PEM certificate of the creator, exactly as embedded. */
  creatorCertificate: string;
  endorsingOrganizations: string[];
  /** The bytes whose SHA-256 digest is signed (SignedProposal.proposal_bytes). */
  signable: Uint8Array;
}

interface HeaderParts {
  channel: string;
  txId: string;
  creatorMspId: string;
  creatorCertificate: string;
}

const decoder = new TextDecoder();

function decodeHeader(header: Message): HeaderParts {
  // Header: channel_header = 1, signature_header = 2
  const channelHeader = header.message(1);
  const signatureHeader = header.message(2);
  // SignatureHeader: creator = 1 (SerializedIdentity)
  const creator = signatureHeader.message(1);
  return {
    // ChannelHeader: channel_id = 4, tx_id = 5
    channel: channelHeader.string(4),
    txId: channelHeader.string(5),
    // SerializedIdentity: mspid = 1, id_bytes = 2
    creatorMspId: creator.string(1),
    creatorCertificate: creator.string(2),
  };
}

/** Decodes the bytes returned by fabric-gateway's `Proposal.getBytes()`. */
export function decodeProposedTransaction(bytes: Uint8Array): DecodedProposal {
  // ProposedTransaction: transaction_id = 1, proposal = 2, endorsing_organizations = 3
  const proposed = new Message(bytes);
  // SignedProposal: proposal_bytes = 1, signature = 2
  const signable = proposed.message(2).bytes(1);
  // Proposal: header = 1, payload = 2
  const proposal = new Message(signable);
  const header = decodeHeader(proposal.message(1));
  // ChaincodeProposalPayload: input = 1 (ChaincodeInvocationSpec bytes), TransientMap = 2
  const payload = proposal.message(2);
  // ChaincodeInvocationSpec: chaincode_spec = 1
  // ChaincodeSpec: chaincode_id = 2, input = 3
  const spec = payload.message(1).message(1);
  // ChaincodeID: name = 2
  const chaincode = spec.message(2).string(2);
  // ChaincodeInput: args = 1 (repeated bytes)
  const rawArgs = spec.message(3).repeatedBytes(1).map((b) => decoder.decode(b));
  // map<string, bytes> entries: key = 1, value = 2
  const transient = payload.repeatedBytes(2).map((entry) => {
    const e = new Message(entry);
    return { key: e.string(1), value: e.bytes(2) };
  });

  return {
    transactionId: proposed.string(1),
    headerTransactionId: header.txId,
    channel: header.channel,
    chaincode,
    fn: rawArgs[0] ?? "",
    args: rawArgs.slice(1),
    transientKeys: transient.map((t) => t.key),
    transient,
    creatorMspId: header.creatorMspId,
    creatorCertificate: header.creatorCertificate,
    endorsingOrganizations: proposed.repeatedString(3),
    signable,
  };
}

export interface DecodedTransaction {
  transactionId: string;
  headerTransactionId: string;
  channel: string;
  creatorMspId: string;
  creatorCertificate: string;
  /** Envelope.payload: the bytes whose digest is signed. */
  signable: Uint8Array;
}

/** Decodes the bytes returned by fabric-gateway's `Transaction.getBytes()`. */
export function decodePreparedTransaction(bytes: Uint8Array): DecodedTransaction {
  // PreparedTransaction: transaction_id = 1, envelope = 2
  const prepared = new Message(bytes);
  // Envelope: payload = 1, signature = 2
  const signable = prepared.message(2).bytes(1);
  // Payload: header = 1, data = 2
  const header = decodeHeader(new Message(signable).message(1));
  return {
    transactionId: prepared.string(1),
    headerTransactionId: header.txId,
    channel: header.channel,
    creatorMspId: header.creatorMspId,
    creatorCertificate: header.creatorCertificate,
    signable,
  };
}

export interface DecodedCommitRequest {
  transactionId: string;
  channel: string;
  /** CommitStatusRequest bytes: what gets signed. */
  signable: Uint8Array;
}

/** Decodes the bytes returned by fabric-gateway's `Commit.getBytes()`. */
export function decodeSignedCommitStatusRequest(bytes: Uint8Array): DecodedCommitRequest {
  // SignedCommitStatusRequest: request = 1, signature = 2
  const signable = new Message(bytes).bytes(1);
  // CommitStatusRequest: transaction_id = 1, channel_id = 2, identity = 3
  const request = new Message(signable);
  return {
    transactionId: request.string(1),
    channel: request.string(2),
    signable,
  };
}
