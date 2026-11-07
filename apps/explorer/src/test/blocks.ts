/** Builds Fabric blocks the way peers do, for tests. */

import { createHash } from "node:crypto";
import { common, ledger, msp, peer } from "@hyperledger/fabric-protos";
import timestamps from "google-protobuf/google/protobuf/timestamp_pb.js";
import { blockDataHash, blockHeaderHash } from "../decode.ts";

function identity(mspId: string, cert = "not a certificate"): Uint8Array {
  const id = new msp.SerializedIdentity();
  id.setMspid(mspId);
  id.setIdBytes(Buffer.from(cert));
  return id.serializeBinary();
}

export interface TxSpec {
  txId: string;
  chaincode: string;
  /** Arguments, as text or, for a test of bytes that aren't UTF-8, as bytes. */
  args: (string | Uint8Array)[];
  writes?: { key: string; value?: string | Uint8Array; ns?: string }[];
  /** Private data writes: only their hashes go in the block, as peers record them. */
  privateWrites?: { collection: string; key: string; value?: string }[];
  creator?: string;
  /** The creator's id_bytes: its certificate, as Fabric carries it. */
  creatorCert?: string;
  endorsers?: string[];
  event?: string;
  /** The event's payload, "event-data" by default. */
  eventPayload?: string;
  config?: boolean;
  /** Config transactions: member organisations and their root certificates (PEM). */
  members?: { mspId: string; rootCerts: string[]; crls?: string[] }[];
}

function envelope(channel: string, spec: TxSpec, seconds: number): Uint8Array {
  const channelHeader = new common.ChannelHeader();
  channelHeader.setType(spec.config ? common.HeaderType.CONFIG : common.HeaderType.ENDORSER_TRANSACTION);
  channelHeader.setChannelId(channel);
  channelHeader.setTxId(spec.txId);
  const ts = new timestamps.Timestamp();
  ts.setSeconds(seconds);
  channelHeader.setTimestamp(ts);
  const signatureHeader = new common.SignatureHeader();
  signatureHeader.setCreator(identity(spec.creator ?? "Org1MSP", spec.creatorCert));
  const header = new common.Header();
  header.setChannelHeader(channelHeader.serializeBinary());
  header.setSignatureHeader(signatureHeader.serializeBinary());

  const payload = new common.Payload();
  payload.setHeader(header);

  if (spec.config && spec.members) {
    const application = new common.ConfigGroup();
    for (const m of spec.members) {
      const fabric = new msp.FabricMSPConfig();
      fabric.setName(m.mspId);
      fabric.setRootCertsList(m.rootCerts.map((c) => Buffer.from(c)));
      fabric.setRevocationListList((m.crls ?? []).map((c) => Buffer.from(c)));
      const mspConfig = new msp.MSPConfig();
      mspConfig.setType(0);
      mspConfig.setConfig(fabric.serializeBinary());
      const value = new common.ConfigValue();
      value.setValue(mspConfig.serializeBinary());
      const org = new common.ConfigGroup();
      org.getValuesMap().set("MSP", value);
      application.getGroupsMap().set(m.mspId, org);
    }
    const channelGroup = new common.ConfigGroup();
    channelGroup.getGroupsMap().set("Application", application);
    const config = new common.Config();
    config.setChannelGroup(channelGroup);
    const envelope = new common.ConfigEnvelope();
    envelope.setConfig(config);
    payload.setData(envelope.serializeBinary());
  }

  if (!spec.config) {
    const input = new peer.ChaincodeInput();
    input.setArgsList(spec.args.map((a) => Buffer.from(a)));
    const ccSpec = new peer.ChaincodeSpec();
    const ccId = new peer.ChaincodeID();
    ccId.setName(spec.chaincode);
    ccSpec.setChaincodeId(ccId);
    ccSpec.setInput(input);
    const invocation = new peer.ChaincodeInvocationSpec();
    invocation.setChaincodeSpec(ccSpec);
    const proposalPayload = new peer.ChaincodeProposalPayload();
    proposalPayload.setInput(invocation.serializeBinary());

    const byNs = new Map<string, ledger.rwset.kvrwset.KVWrite[]>();
    if (spec.privateWrites?.length && !byNs.has(spec.chaincode)) byNs.set(spec.chaincode, []);
    for (const w of spec.writes ?? []) {
      const write = new ledger.rwset.kvrwset.KVWrite();
      write.setKey(w.key);
      if (w.value === undefined) write.setIsDelete(true);
      else write.setValue(Buffer.from(w.value));
      const ns = w.ns ?? spec.chaincode;
      byNs.set(ns, [...(byNs.get(ns) ?? []), write]);
    }
    const rwset = new ledger.rwset.TxReadWriteSet();
    rwset.setNsRwsetList(
      [...byNs].map(([ns, writes]) => {
        const kv = new ledger.rwset.kvrwset.KVRWSet();
        kv.setWritesList(writes);
        kv.setReadsList([new ledger.rwset.kvrwset.KVRead()]);
        const nsr = new ledger.rwset.NsReadWriteSet();
        nsr.setNamespace(ns);
        nsr.setRwset(kv.serializeBinary());
        const collections = new Map<string, ledger.rwset.kvrwset.KVWriteHash[]>();
        for (const w of ns === spec.chaincode ? (spec.privateWrites ?? []) : []) {
          const hashed = new ledger.rwset.kvrwset.KVWriteHash();
          hashed.setKeyHash(createHash("sha256").update(w.key).digest());
          if (w.value === undefined) hashed.setIsDelete(true);
          else hashed.setValueHash(createHash("sha256").update(w.value).digest());
          collections.set(w.collection, [...(collections.get(w.collection) ?? []), hashed]);
        }
        nsr.setCollectionHashedRwsetList(
          [...collections].map(([name, writes]) => {
            const set = new ledger.rwset.kvrwset.HashedRWSet();
            set.setHashedWritesList(writes);
            const c = new ledger.rwset.CollectionHashedReadWriteSet();
            c.setCollectionName(name);
            c.setHashedRwset(set.serializeBinary());
            return c;
          }),
        );
        return nsr;
      }),
    );
    const action = new peer.ChaincodeAction();
    action.setResults(rwset.serializeBinary());
    const response = new peer.Response();
    response.setStatus(200);
    response.setPayload(Buffer.from('{"ok":true}'));
    action.setResponse(response);
    if (spec.event) {
      const event = new peer.ChaincodeEvent();
      event.setEventName(spec.event);
      event.setPayload(Buffer.from(spec.eventPayload ?? "event-data"));
      action.setEvents(event.serializeBinary());
    }
    const prp = new peer.ProposalResponsePayload();
    prp.setExtension$(action.serializeBinary());
    const endorsed = new peer.ChaincodeEndorsedAction();
    endorsed.setProposalResponsePayload(prp.serializeBinary());
    endorsed.setEndorsementsList(
      (spec.endorsers ?? ["Org1MSP"]).map((m) => {
        const e = new peer.Endorsement();
        e.setEndorser(identity(m));
        return e;
      }),
    );
    const cap = new peer.ChaincodeActionPayload();
    cap.setChaincodeProposalPayload(proposalPayload.serializeBinary());
    cap.setAction(endorsed);
    const ta = new peer.TransactionAction();
    ta.setPayload(cap.serializeBinary());
    const tx = new peer.Transaction();
    tx.setActionsList([ta]);
    payload.setData(tx.serializeBinary());
  }

  const env = new common.Envelope();
  env.setPayload(payload.serializeBinary());
  return env.serializeBinary();
}

/** A chain of blocks with correct hashes; `codes` sets validation codes per block. */
export function chain(channel: string, blocks: { txs: TxSpec[]; codes?: number[] }[]): common.Block[] {
  let previous = new Uint8Array();
  return blocks.map((spec, n) => {
    const data = spec.txs.map((t, i) => envelope(channel, t, 1_760_000_000 + n * 60 + i));
    const dataHash = Buffer.from(blockDataHash(data), "hex");
    const header = new common.BlockHeader();
    header.setNumber(n);
    header.setPreviousHash(previous);
    header.setDataHash(dataHash);
    const blockData = new common.BlockData();
    blockData.setDataList(data);
    const metadata = new common.BlockMetadata();
    const entries: Uint8Array[] = [new Uint8Array(), new Uint8Array(), new Uint8Array(), new Uint8Array(), new Uint8Array()];
    entries[common.BlockMetadataIndex.TRANSACTIONS_FILTER] = Uint8Array.from(spec.codes ?? data.map(() => 0));
    metadata.setMetadataList(entries);
    const block = new common.Block();
    block.setHeader(header);
    block.setData(blockData);
    block.setMetadata(metadata);
    previous = Buffer.from(blockHeaderHash(BigInt(n), previous, dataHash), "hex");
    return block;
  });
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
