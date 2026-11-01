/**
 * Proves the wallet and relay agree on bytes, without a running network:
 * fabric-gateway builds real proposal messages offline, @weftwallet/core decodes,
 * verifies and signs them, and fabric-gateway accepts the signature.
 */
import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import { connect } from "@hyperledger/fabric-gateway";
import { common, gateway as gw, msp } from "@hyperledger/fabric-protos";
import {
  decodePreparedTransaction,
  decodeProposedTransaction,
  decodeSignedCommitStatusRequest,
  checkReceiptRequest,
  fillGeneratedSalt,
  isLowS,
  signForFabric,
  summarizeIdentity,
  verifyProposal,
  VerificationError,
  FABRIC_ATTRS_OID,
} from "@weftwallet/core";
import type { ContractCall } from "@weftwallet/protocol";
// After @weftwallet/core, which loads the Reflect polyfill @peculiar/x509 needs.
import { BasicConstraintsExtension, Extension, X509CertificateGenerator } from "@peculiar/x509";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let keys: CryptoKeyPair;
let certificate: string;
const mspId = "Org1MSP";
const client = new grpc.Client("localhost:1", grpc.credentials.createInsecure());

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const attrs = new TextEncoder().encode(JSON.stringify({ attrs: { role: "auditor", "hf.Type": "client" } }));
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=appUser, OU=client, O=Org1",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 9 * 86_400_000),
    keys,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    extensions: [new BasicConstraintsExtension(false), new Extension(FABRIC_ATTRS_OID, false, attrs)],
  });
  certificate = cert.toString("pem");
});

afterAll(() => client.close());

const call: ContractCall = {
  channel: "mychannel",
  chaincode: "basic",
  fn: "TransferAsset",
  args: ["asset6", "Christopher"],
};

function newProposal(c: ContractCall = call) {
  const gateway = connect({ client, identity: { mspId, credentials: Buffer.from(certificate) } });
  const proposal = gateway
    .getNetwork(c.channel)
    .getContract(c.chaincode, c.contract)
    .newProposal(c.fn, { arguments: c.args ?? [], transientData: c.transient ?? {} });
  return { gateway, proposal };
}

describe("proposal round trip", () => {
  it("decodes the fields the user approved", () => {
    const { proposal } = newProposal();
    const decoded = decodeProposedTransaction(proposal.getBytes());
    expect(decoded).toMatchObject({
      channel: "mychannel",
      chaincode: "basic",
      fn: "TransferAsset",
      args: ["asset6", "Christopher"],
      creatorMspId: mspId,
      transactionId: proposal.getTransactionId(),
      headerTransactionId: proposal.getTransactionId(),
    });
    expect(decoded.creatorCertificate.trim()).toBe(certificate.trim());
  });

  it("qualifies the function with the contract name", () => {
    const { proposal } = newProposal({ ...call, contract: "assets" });
    expect(decodeProposedTransaction(proposal.getBytes()).fn).toBe("assets:TransferAsset");
  });

  it("decodes private inputs, names and values", () => {
    const { proposal } = newProposal({ ...call, transient: { price: "100" } });
    const decoded = decodeProposedTransaction(proposal.getBytes());
    expect(decoded.transientKeys).toEqual(["price"]);
    expect(new TextDecoder().decode(decoded.transient[0]!.value)).toBe("100");
  });

  it("verifyProposal refuses a private input whose value was swapped", () => {
    const approved = { ...call, transient: { price: "100" } };
    const { proposal } = newProposal({ ...call, transient: { price: "1" } });
    expect(() => verifyProposal(approved, { mspId, certificate }, decodeProposedTransaction(proposal.getBytes()))).toThrow(
      /private input "price"/,
    );
    const same = newProposal(approved).proposal;
    expect(() => verifyProposal(approved, { mspId, certificate }, decodeProposedTransaction(same.getBytes()))).not.toThrow();
  });

  it("verifyProposal checks a salt Weft filled in against the bytes the relay built", () => {
    const vote: ContractCall = {
      channel: "mychannel",
      chaincode: "ballot",
      fn: "CastVote",
      args: ["board-2026"],
      transient: { ballot: JSON.stringify({ option: "Ada", salt: "generate" }) },
    };
    const asked = checkReceiptRequest(vote, { type: "weft-ballot-receipt", version: 1, channel: "mychannel", electionId: "board-2026", option: "Ada", salt: "generate" });
    const { call: filled, receipt } = fillGeneratedSalt(vote, asked);
    expect(JSON.parse(filled.transient!.ballot!)).toEqual({ option: "Ada", salt: receipt.salt });
    // The relay builds the proposal from the filled-in call it is sent.
    const built = newProposal(filled).proposal;
    expect(() => verifyProposal(filled, { mspId, certificate }, decodeProposedTransaction(built.getBytes()))).not.toThrow();
    // One built from the placeholder, or from another salt, is refused.
    for (const ballot of [vote.transient!.ballot!, JSON.stringify({ option: "Ada", salt: "0".repeat(32) })]) {
      const swapped = newProposal({ ...filled, transient: { ballot } }).proposal;
      expect(() => verifyProposal(filled, { mspId, certificate }, decodeProposedTransaction(swapped.getBytes()))).toThrow(/private input "ballot"/);
    }
  });

  it("signs exactly what fabric-gateway would sign", async () => {
    const { gateway, proposal } = newProposal();
    const decoded = decodeProposedTransaction(proposal.getBytes());
    // The digest fabric-gateway computes is SHA-256 of the signable bytes.
    expect(createHash("sha256").update(decoded.signable).digest()).toEqual(Buffer.from(proposal.getDigest()));

    const signature = await signForFabric(keys.privateKey, decoded.signable);
    expect(isLowS(signature)).toBe(true);

    const publicKey = createPublicKey(certificate);
    expect(nodeVerify("sha256", decoded.signable, publicKey, signature)).toBe(true);

    // fabric-gateway accepts the signed bytes back.
    const signed = gateway.newSignedProposal(proposal.getBytes(), signature);
    expect(signed.getTransactionId()).toBe(proposal.getTransactionId());
  });

  it("verifyProposal passes for the approved call", () => {
    const { proposal } = newProposal();
    expect(() =>
      verifyProposal(call, { mspId, certificate }, decodeProposedTransaction(proposal.getBytes())),
    ).not.toThrow();
  });

  it("verifyProposal refuses a swapped argument", () => {
    const { proposal } = newProposal({ ...call, args: ["asset6", "Mallory"] });
    expect(() => verifyProposal(call, { mspId, certificate }, decodeProposedTransaction(proposal.getBytes()))).toThrow(
      VerificationError,
    );
  });

  it("verifyProposal refuses a different function", () => {
    const { proposal } = newProposal({ ...call, fn: "DeleteAsset" });
    expect(() => verifyProposal(call, { mspId, certificate }, decodeProposedTransaction(proposal.getBytes()))).toThrow(
      /function/,
    );
  });
});

describe("transaction and commit decoding", () => {
  function header(txId: string) {
    const identity = new msp.SerializedIdentity();
    identity.setMspid(mspId);
    identity.setIdBytes(Buffer.from(certificate));
    const signatureHeader = new common.SignatureHeader();
    signatureHeader.setCreator(identity.serializeBinary());
    const channelHeader = new common.ChannelHeader();
    channelHeader.setChannelId("mychannel");
    channelHeader.setTxId(txId);
    const h = new common.Header();
    h.setChannelHeader(channelHeader.serializeBinary());
    h.setSignatureHeader(signatureHeader.serializeBinary());
    return h;
  }

  it("decodes a prepared transaction", () => {
    const payload = new common.Payload();
    payload.setHeader(header("tx-123"));
    const envelope = new common.Envelope();
    envelope.setPayload(payload.serializeBinary());
    const prepared = new gw.PreparedTransaction();
    prepared.setTransactionId("tx-123");
    prepared.setEnvelope(envelope);

    const decoded = decodePreparedTransaction(prepared.serializeBinary());
    expect(decoded).toMatchObject({
      transactionId: "tx-123",
      headerTransactionId: "tx-123",
      channel: "mychannel",
      creatorMspId: mspId,
    });
    expect(Buffer.from(decoded.signable)).toEqual(Buffer.from(payload.serializeBinary()));
  });

  it("decodes a commit status request", () => {
    const request = new gw.CommitStatusRequest();
    request.setTransactionId("tx-123");
    request.setChannelId("mychannel");
    const signed = new gw.SignedCommitStatusRequest();
    signed.setRequest(request.serializeBinary());

    const decoded = decodeSignedCommitStatusRequest(signed.serializeBinary());
    expect(decoded).toMatchObject({ transactionId: "tx-123", channel: "mychannel" });
  });
});

describe("identity summary", () => {
  it("reads name, role and Fabric attributes", async () => {
    const summary = await summarizeIdentity({ id: "1", mspId, certificate });
    expect(summary).toMatchObject({
      name: "appUser",
      role: "client",
      mspId,
      attributes: { role: "auditor", "hf.Type": "client" },
    });
    expect(summary.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});
