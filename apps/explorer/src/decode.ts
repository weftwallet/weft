/**
 * Turns a Fabric block (common.Block) into plain objects. Nothing here
 * decides what to publish: that's policy.ts. Nothing here trusts the block
 * either: the header hash is recomputed, so the chain can be checked.
 */

import { createHash, X509Certificate } from "node:crypto";
import { common, ledger, msp, peer } from "@hyperledger/fabric-protos";
import { configUpdateSigners, summariseConfig, type ConfigSummary } from "./channel-config.ts";

export interface Party {
  mspId: string;
  /** The certificate's common name, when it parses. */
  name: string | null;
  certificate: string;
}

export interface Write {
  namespace: string;
  key: string;
  isDelete: boolean;
  value: Uint8Array;
}

/** An application organisation in a channel, as its configuration describes it. */
export interface ChannelMember {
  mspId: string;
  rootCerts: string[];
  intermediateCerts: string[];
  /** CRLs the organisation's CAs issued, PEM. Peers refuse the certificates they list. */
  crls: string[];
}

export interface DecodedTransaction {
  index: number;
  txId: string;
  /** "endorser" for contract calls, "config" for channel configuration. */
  type: "endorser" | "config" | "other";
  typeName: string;
  timestamp: number | null;
  /** Fabric's validation code name, e.g. "VALID" or "MVCC_READ_CONFLICT". */
  validation: string;
  creator: Party | null;
  chaincode: string | null;
  /** First argument, by Fabric convention the function name. */
  fn: string | null;
  args: Uint8Array[];
  endorsers: Party[];
  reads: number;
  writes: Write[];
  /**
   * Private data collections the transaction touched. The ledger has only
   * hashes: SHA-256 of each key and value, never the values themselves.
   */
  privateData: PrivateDataSet[];
  /** The contract's response, as returned to the submitter. */
  response: { status: number; message: string; payload: Uint8Array } | null;
  event: { name: string; payload: Uint8Array } | null;
  /** Config transactions only: the channel's application organisations after this change. */
  members?: ChannelMember[];
  /** Config transactions only: the configuration it leaves, who signed the update, and (set when indexed) what changed. */
  config?: { summary: ConfigSummary; signers: Party[]; changes?: string[]; first?: boolean };
}

export interface PrivateDataSet {
  namespace: string;
  collection: string;
  reads: number;
  writes: { keyHash: string; valueHash: string | null; isDelete: boolean }[];
}

export interface DecodedBlock {
  channel: string;
  number: number;
  /** SHA-256 of the block header, computed here, hex. */
  hash: string;
  previousHash: string;
  dataHash: string;
  /** Whether data_hash matches the block's data, recomputed. */
  dataHashValid: boolean;
  timestamp: number | null;
  transactions: DecodedTransaction[];
}

const VALIDATION_NAMES = new Map<number, string>(
  Object.entries(peer.TxValidationCode).map(([name, code]) => [code as number, name]),
);
const HEADER_TYPES = new Map<number, string>(
  Object.entries(common.HeaderType).map(([name, code]) => [code as number, name]),
);

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/* Block header hash: SHA-256 over DER(SEQUENCE { INTEGER number, OCTET STRING previous_hash, OCTET STRING data_hash }). */

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derElement(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function derInteger(value: bigint): Buffer {
  const bytes: number[] = [];
  let n = value;
  do {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  } while (n > 0n);
  if (bytes[0]! & 0x80) bytes.unshift(0); // keep it positive
  return derElement(0x02, Buffer.from(bytes));
}

export function blockHeaderHash(number: bigint, previousHash: Uint8Array, dataHash: Uint8Array): string {
  const der = derElement(
    0x30,
    Buffer.concat([derInteger(number), derElement(0x04, Buffer.from(previousHash)), derElement(0x04, Buffer.from(dataHash))]),
  );
  return createHash("sha256").update(der).digest("hex");
}

export function blockDataHash(data: Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const entry of data) hash.update(entry);
  return hash.digest("hex");
}

function party(serialized: Uint8Array): Party | null {
  if (serialized.length === 0) return null;
  const identity = msp.SerializedIdentity.deserializeBinary(serialized);
  const certificate = Buffer.from(identity.getIdBytes_asU8()).toString("utf8");
  let name: string | null = null;
  try {
    const subject = new X509Certificate(certificate).subject;
    name = /(?:^|\n)CN=([^\n]+)/.exec(subject)?.[1] ?? null;
  } catch {
    /* not a certificate (e.g. an idemix identity); keep the MSP ID */
  }
  return { mspId: identity.getMspid(), name, certificate };
}

function timestampOf(header: common.ChannelHeader): number | null {
  const ts = header.getTimestamp();
  return ts ? ts.getSeconds() * 1000 + Math.floor(ts.getNanos() / 1e6) : null;
}

function decodeEndorserTransaction(tx: DecodedTransaction, data: Uint8Array) {
  const transaction = peer.Transaction.deserializeBinary(data);
  // A transaction has one action in practice; read the first.
  const action = transaction.getActionsList()[0];
  if (!action) return;
  const payload = peer.ChaincodeActionPayload.deserializeBinary(action.getPayload_asU8());

  const proposal = peer.ChaincodeProposalPayload.deserializeBinary(payload.getChaincodeProposalPayload_asU8());
  const spec = peer.ChaincodeInvocationSpec.deserializeBinary(proposal.getInput_asU8()).getChaincodeSpec();
  tx.chaincode = spec?.getChaincodeId()?.getName() || null;
  const input = spec?.getInput()?.getArgsList_asU8() ?? [];
  if (input[0]) tx.fn = Buffer.from(input[0]).toString("utf8");
  tx.args = input.slice(1);

  const endorsed = payload.getAction();
  if (!endorsed) return;
  tx.endorsers = endorsed
    .getEndorsementsList()
    .map((e) => party(e.getEndorser_asU8()))
    .filter((p): p is Party => p !== null);

  const responsePayload = peer.ProposalResponsePayload.deserializeBinary(endorsed.getProposalResponsePayload_asU8());
  const chaincodeAction = peer.ChaincodeAction.deserializeBinary(responsePayload.getExtension_asU8());
  const response = chaincodeAction.getResponse();
  if (response) {
    tx.response = { status: response.getStatus(), message: response.getMessage(), payload: response.getPayload_asU8() };
  }
  const events = chaincodeAction.getEvents_asU8();
  if (events.length > 0) {
    const event = peer.ChaincodeEvent.deserializeBinary(events);
    if (event.getEventName()) tx.event = { name: event.getEventName(), payload: event.getPayload_asU8() };
  }

  const results = chaincodeAction.getResults_asU8();
  if (results.length === 0) return;
  const rwset = ledger.rwset.TxReadWriteSet.deserializeBinary(results);
  for (const ns of rwset.getNsRwsetList()) {
    const kv = ledger.rwset.kvrwset.KVRWSet.deserializeBinary(ns.getRwset_asU8());
    tx.reads += kv.getReadsList().length;
    for (const w of kv.getWritesList()) {
      tx.writes.push({ namespace: ns.getNamespace(), key: w.getKey(), isDelete: w.getIsDelete(), value: w.getValue_asU8() });
    }
    for (const c of ns.getCollectionHashedRwsetList()) {
      const hashed = ledger.rwset.kvrwset.HashedRWSet.deserializeBinary(c.getHashedRwset_asU8());
      tx.privateData.push({
        namespace: ns.getNamespace(),
        collection: c.getCollectionName(),
        reads: hashed.getHashedReadsList().length,
        writes: hashed.getHashedWritesList().map((w) => ({
          keyHash: hex(w.getKeyHash_asU8()),
          valueHash: w.getIsDelete() ? null : hex(w.getValueHash_asU8()),
          isDelete: w.getIsDelete(),
        })),
      });
    }
  }
}

/** An entry that isn't a well-formed envelope. Listed, so the block's count stays honest. */
function unreadable(index: number, validation: string): DecodedTransaction {
  return {
    index,
    txId: "",
    type: "other",
    typeName: "UNREADABLE",
    timestamp: null,
    validation,
    creator: null,
    chaincode: null,
    fn: null,
    args: [],
    endorsers: [],
    reads: 0,
    writes: [],
    privateData: [],
    response: null,
    event: null,
  };
}

const crlPem = (der: Uint8Array) => {
  const text = Buffer.from(der).toString("utf8");
  if (/-----BEGIN (X509 )?CRL-----/.test(text)) return text.trim();
  return `-----BEGIN X509 CRL-----\n${Buffer.from(der).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END X509 CRL-----`;
};

const pem = (der: Uint8Array) => {
  const text = Buffer.from(der).toString("utf8");
  // Fabric stores PEM text here; fall back to wrapping DER.
  if (text.includes("BEGIN CERTIFICATE")) return text.trim();
  return `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----`;
};

/** The application organisations a config transaction leaves the channel with. */
function decodeMembers(data: Uint8Array): ChannelMember[] {
  const config = common.ConfigEnvelope.deserializeBinary(data).getConfig();
  const application = config?.getChannelGroup()?.getGroupsMap().get("Application");
  if (!application) return [];
  const members: ChannelMember[] = [];
  application.getGroupsMap().forEach((group) => {
    const value = group.getValuesMap().get("MSP");
    if (!value) return;
    const mspConfig = msp.MSPConfig.deserializeBinary(value.getValue_asU8());
    if (mspConfig.getType() !== 0) return; // 0 is X.509; idemix organisations can't sign in this way
    const fabric = msp.FabricMSPConfig.deserializeBinary(mspConfig.getConfig_asU8());
    members.push({
      mspId: fabric.getName(),
      rootCerts: fabric.getRootCertsList_asU8().map(pem),
      intermediateCerts: fabric.getIntermediateCertsList_asU8().map(pem),
      crls: fabric.getRevocationListList_asU8().map(crlPem),
    });
  });
  return members.sort((a, b) => a.mspId.localeCompare(b.mspId));
}

function decodeEnvelope(raw: Uint8Array, index: number, validation: string): { tx: DecodedTransaction; channelId: string } {
  const envelope = common.Envelope.deserializeBinary(raw);
  const payload = common.Payload.deserializeBinary(envelope.getPayload_asU8());
  const header = payload.getHeader();
  const channelHeader = common.ChannelHeader.deserializeBinary(header?.getChannelHeader_asU8() ?? new Uint8Array());
  const signatureHeader = common.SignatureHeader.deserializeBinary(header?.getSignatureHeader_asU8() ?? new Uint8Array());
  const typeCode = channelHeader.getType();
  const type =
    typeCode === common.HeaderType.ENDORSER_TRANSACTION ? "endorser" : typeCode === common.HeaderType.CONFIG ? "config" : "other";

  const tx: DecodedTransaction = {
    index,
    txId: channelHeader.getTxId(),
    type,
    typeName: HEADER_TYPES.get(typeCode) ?? String(typeCode),
    timestamp: timestampOf(channelHeader),
    validation,
    creator: party(signatureHeader.getCreator_asU8()),
    chaincode: null,
    fn: null,
    args: [],
    endorsers: [],
    reads: 0,
    writes: [],
    privateData: [],
    response: null,
    event: null,
  };
  if (type === "endorser") {
    try {
      decodeEndorserTransaction(tx, payload.getData_asU8());
    } catch {
      /* A malformed transaction is still listed, with what could be read. */
    }
  }
  if (type === "config") {
    try {
      tx.members = decodeMembers(payload.getData_asU8());
    } catch {
      /* listed without its membership */
    }
    try {
      const summary = summariseConfig(payload.getData_asU8());
      if (summary) {
        tx.config = {
          summary,
          signers: configUpdateSigners(payload.getData_asU8()).flatMap((creator) => party(creator) ?? []),
        };
      }
    } catch {
      /* listed without its summary */
    }
  }
  return { tx, channelId: channelHeader.getChannelId() };
}

export function decodeBlock(block: common.Block): DecodedBlock {
  const header = block.getHeader();
  if (!header) throw new Error("Block has no header.");
  const data = block.getData()?.getDataList_asU8() ?? [];
  const filter = block.getMetadata()?.getMetadataList_asU8()[common.BlockMetadataIndex.TRANSACTIONS_FILTER] ?? new Uint8Array();
  const number = BigInt(header.getNumber());
  const previousHash = header.getPreviousHash_asU8();
  const dataHash = header.getDataHash_asU8();

  let channel = "";
  const transactions = data.map((raw, i) => {
    // Config blocks have no filter entries; they're valid by construction.
    const code = filter[i];
    const validation = code === undefined ? "VALID" : (VALIDATION_NAMES.get(code) ?? `CODE_${code}`);
    try {
      const { tx, channelId } = decodeEnvelope(raw, i, validation);
      channel ||= channelId;
      return tx;
    } catch {
      return unreadable(i, validation);
    }
  });

  return {
    channel,
    number: Number(number),
    hash: blockHeaderHash(number, previousHash, dataHash),
    previousHash: hex(previousHash),
    dataHash: hex(dataHash),
    dataHashValid: blockDataHash(data) === hex(dataHash),
    timestamp: transactions.find((t) => t.timestamp !== null)?.timestamp ?? null,
    transactions,
  };
}
