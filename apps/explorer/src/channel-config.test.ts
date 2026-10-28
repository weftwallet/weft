import { common, msp, orderer, peer } from "@hyperledger/fabric-protos";
import { describe, expect, it } from "vitest";
import { configChanges, configUpdateSigners, describePolicy, summariseConfig } from "./channel-config.ts";
import { ca } from "./test/certs.ts";

interface Spec {
  orgs: { mspId: string; root: string; anchors?: string[] }[];
  consenters: string[];
  batchTimeout: string;
  maxMessages: number;
  capabilities: string[];
  endorsement: number; // ImplicitMeta rule: 0 ANY, 1 ALL, 2 MAJORITY
}

const value = (bytes: Uint8Array) => {
  const v = new common.ConfigValue();
  v.setValue(bytes);
  return v;
};

function implicit(rule: number, sub: string) {
  const meta = new common.ImplicitMetaPolicy();
  meta.setRule(rule);
  meta.setSubPolicy(sub);
  const policy = new common.Policy();
  policy.setType(common.Policy.PolicyType.IMPLICIT_META);
  policy.setValue(meta.serializeBinary());
  const cp = new common.ConfigPolicy();
  cp.setPolicy(policy);
  return cp;
}

function configEnvelope(spec: Spec, signers: string[] = []): Uint8Array {
  const application = new common.ConfigGroup();
  for (const o of spec.orgs) {
    const fabric = new msp.FabricMSPConfig();
    fabric.setName(o.mspId);
    fabric.setRootCertsList([Buffer.from(o.root)]);
    const config = new msp.MSPConfig();
    config.setType(0);
    config.setConfig(fabric.serializeBinary());
    const group = new common.ConfigGroup();
    group.getValuesMap().set("MSP", value(config.serializeBinary()));
    if (o.anchors) {
      const anchors = new peer.AnchorPeers();
      anchors.setAnchorPeersList(
        o.anchors.map((a) => {
          const p = new peer.AnchorPeer();
          const [host, port] = a.split(":");
          p.setHost(host!);
          p.setPort(Number(port));
          return p;
        }),
      );
      group.getValuesMap().set("AnchorPeers", value(anchors.serializeBinary()));
    }
    application.getGroupsMap().set(o.mspId.replace("MSP", ""), group);
  }
  const caps = new common.Capabilities();
  for (const c of spec.capabilities) caps.getCapabilitiesMap().set(c, new common.Capability());
  application.getValuesMap().set("Capabilities", value(caps.serializeBinary()));
  application.getPoliciesMap().set("Endorsement", implicit(spec.endorsement, "Endorsement"));

  const ordererGroup = new common.ConfigGroup();
  const raft = new orderer.etcdraft.ConfigMetadata();
  raft.setConsentersList(
    spec.consenters.map((c) => {
      const consenter = new orderer.etcdraft.Consenter();
      const [host, port] = c.split(":");
      consenter.setHost(host!);
      consenter.setPort(Number(port));
      return consenter;
    }),
  );
  const consensus = new orderer.ConsensusType();
  consensus.setType("etcdraft");
  consensus.setMetadata(raft.serializeBinary());
  ordererGroup.getValuesMap().set("ConsensusType", value(consensus.serializeBinary()));
  const timeout = new orderer.BatchTimeout();
  timeout.setTimeout(spec.batchTimeout);
  ordererGroup.getValuesMap().set("BatchTimeout", value(timeout.serializeBinary()));
  const size = new orderer.BatchSize();
  size.setMaxMessageCount(spec.maxMessages);
  size.setAbsoluteMaxBytes(1000);
  size.setPreferredMaxBytes(500);
  ordererGroup.getValuesMap().set("BatchSize", value(size.serializeBinary()));

  const channel = new common.ConfigGroup();
  channel.getGroupsMap().set("Application", application);
  channel.getGroupsMap().set("Orderer", ordererGroup);
  const config = new common.Config();
  config.setChannelGroup(channel);
  const envelope = new common.ConfigEnvelope();
  envelope.setConfig(config);

  if (signers.length) {
    const update = new common.ConfigUpdateEnvelope();
    update.setSignaturesList(
      signers.map((mspId) => {
        const id = new msp.SerializedIdentity();
        id.setMspid(mspId);
        id.setIdBytes(Buffer.from("cert"));
        const header = new common.SignatureHeader();
        header.setCreator(id.serializeBinary());
        const s = new common.ConfigSignature();
        s.setSignatureHeader(header.serializeBinary());
        return s;
      }),
    );
    const payload = new common.Payload();
    payload.setData(update.serializeBinary());
    const last = new common.Envelope();
    last.setPayload(payload.serializeBinary());
    envelope.setLastUpdate(last);
  }
  return envelope.serializeBinary();
}

describe("channel configuration", async () => {
  const org1 = (await ca("ca.org1")).pem;
  const org2 = (await ca("ca.org2")).pem;
  const org3 = (await ca("ca.org3")).pem;
  const base: Spec = {
    orgs: [
      { mspId: "Org1MSP", root: org1 },
      { mspId: "Org2MSP", root: org2 },
    ],
    consenters: ["orderer1:7050", "orderer2:7050", "orderer3:7050"],
    batchTimeout: "2s",
    maxMessages: 10,
    capabilities: ["V2_0"],
    endorsement: 2,
  };

  it("is summarised", () => {
    const s = summariseConfig(configEnvelope(base))!;
    expect(s.organisations.map((o) => o.mspId)).toEqual(["Org1MSP", "Org2MSP"]);
    expect(s.organisations[0]!.rootCas[0]).toMatchObject({ subject: "ca.org1" });
    expect(s.organisations[0]!.rootCas[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(s).toMatchObject({
      consensus: "etcdraft",
      consenters: ["orderer1:7050", "orderer2:7050", "orderer3:7050"],
      batch: { timeout: "2s", maxMessages: 10 },
      capabilities: { application: ["V2_0"] },
      policies: { "Application/Endorsement": "MAJORITY of Endorsement" },
    });
  });

  it("says what the channel starts with", () => {
    expect(configChanges(null, summariseConfig(configEnvelope(base))!)).toEqual([
      "The channel starts with Org1MSP, Org2MSP as members.",
    ]);
  });

  it("says what changed, in words", () => {
    const before = summariseConfig(configEnvelope(base))!;
    const after = summariseConfig(
      configEnvelope({
        ...base,
        orgs: [
          { mspId: "Org1MSP", root: org1, anchors: ["peer0.org1.example.com:7051"] },
          { mspId: "Org3MSP", root: org3 },
        ],
        consenters: ["orderer1:7050", "orderer2:7050", "orderer4:7050"],
        batchTimeout: "1s",
        maxMessages: 500,
        capabilities: ["V2_5"],
        endorsement: 0,
      }),
    )!;
    expect(configChanges(before, after)).toEqual([
      "Org1MSP's anchor peers: added peer0.org1.example.com:7051.",
      "Org3MSP joined as a member.",
      "Org2MSP left (was a member).",
      "Consenters: added orderer4:7050; removed orderer3:7050.",
      "Batch timeout changed from 2s to 1s.",
      "Most transactions per block changed from 10 to 500.",
      "Application capabilities: added V2_5; removed V2_0.",
      "Policy Application/Endorsement changed from MAJORITY of Endorsement to ANY of Endorsement.",
    ]);
  });

  it("notices a root CA swapped for another", () => {
    const before = summariseConfig(configEnvelope(base))!;
    const after = summariseConfig(configEnvelope({ ...base, orgs: [{ mspId: "Org1MSP", root: org3 }, base.orgs[1]!] }))!;
    const [change] = configChanges(before, after);
    expect(change).toMatch(/^Org1MSP's root CAs: added ca\.org3 \([0-9a-f]{16}\); removed ca\.org1 \([0-9a-f]{16}\)\.$/);
  });

  it("still says something changed when it's a setting it doesn't summarise", () => {
    const before = summariseConfig(configEnvelope(base))!;
    expect(configChanges(before, { ...before, digest: "different" })).toEqual(["Settings this explorer doesn't summarise changed."]);
    expect(configChanges(before, before)).toEqual([]);
  });

  it("lists who signed the update", () => {
    const signers = configUpdateSigners(configEnvelope(base, ["Org1MSP", "Org2MSP"]));
    expect(signers.map((s) => msp.SerializedIdentity.deserializeBinary(s).getMspid())).toEqual(["Org1MSP", "Org2MSP"]);
  });

  it("writes out signature policies", () => {
    const principal = (mspId: string, role: number) => {
      const r = new msp.MSPRole();
      r.setMspIdentifier(mspId);
      r.setRole(role);
      const p = new msp.MSPPrincipal();
      p.setPrincipalClassification(msp.MSPPrincipal.Classification.ROLE);
      p.setPrincipal(r.serializeBinary());
      return p;
    };
    const signedBy = (i: number) => {
      const s = new common.SignaturePolicy();
      s.setSignedBy(i);
      return s;
    };
    const nOutOf = new common.SignaturePolicy.NOutOf();
    nOutOf.setN(1);
    nOutOf.setRulesList([signedBy(0), signedBy(1)]);
    const rule = new common.SignaturePolicy();
    rule.setNOutOf(nOutOf);
    const envelope = new common.SignaturePolicyEnvelope();
    envelope.setRule(rule);
    envelope.setIdentitiesList([principal("Org1MSP", 1), principal("Org2MSP", 3)]);
    const policy = new common.Policy();
    policy.setType(common.Policy.PolicyType.SIGNATURE);
    policy.setValue(envelope.serializeBinary());
    expect(describePolicy(policy)).toBe("OR(Org1MSP.admin, Org2MSP.peer)");
  });
});
