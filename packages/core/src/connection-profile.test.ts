import { describe, expect, it } from "vitest";
import { inviteFromConnectionProfile, inviteLinks, resolveInviteUrl, InviteError } from "./index.js";

// Shape of fabric-samples' test-network/organizations/peerOrganizations/org1.example.com/connection-org1.json
const org1Profile = {
  name: "test-network-org1",
  version: "1.0.0",
  client: { organization: "Org1", connection: { timeout: { peer: { endorser: "300" } } } },
  organizations: {
    Org1: { mspid: "Org1MSP", peers: ["peer0.org1.example.com"], certificateAuthorities: ["ca.org1.example.com"] },
  },
  peers: { "peer0.org1.example.com": { url: "grpcs://localhost:7051" } },
  certificateAuthorities: {
    "ca.org1.example.com": { url: "https://localhost:7054", caName: "ca-org1", httpOptions: { verify: false } },
  },
};

describe("inviteFromConnectionProfile", () => {
  it("maps the test-network profile", () => {
    expect(
      inviteFromConnectionProfile(org1Profile, { relayUrl: "http://localhost:8787", channels: ["mychannel"] }),
    ).toEqual({
      weft: 1,
      network: "test-network-org1",
      organization: "Org1",
      mspId: "Org1MSP",
      caUrl: "https://localhost:7054",
      caName: "ca-org1",
      relayUrl: "http://localhost:8787",
      channels: ["mychannel"],
    });
  });

  it("uses the profile's channels when present", () => {
    const invite = inviteFromConnectionProfile(
      { ...org1Profile, channels: { mychannel: {}, audit: {} } },
      { relayUrl: "https://relay.example.com" },
    );
    expect(invite.channels).toEqual(["mychannel", "audit"]);
  });

  it("asks for channels when the profile has none", () => {
    expect(() => inviteFromConnectionProfile(org1Profile, { relayUrl: "https://relay.example.com" })).toThrow(
      /no channels/,
    );
  });

  it("asks which organisation when there are several", () => {
    const profile = {
      ...org1Profile,
      client: {},
      organizations: { ...org1Profile.organizations, Org2: { mspid: "Org2MSP", certificateAuthorities: [] } },
    };
    expect(() =>
      inviteFromConnectionProfile(profile, { relayUrl: "https://relay.example.com", channels: ["c"] }),
    ).toThrow(InviteError);
  });
});

describe("inviteLinks", () => {
  it("builds join and weft links that resolve back to the invite", () => {
    const links = inviteLinks("https://org1.example.com/.well-known/weft-invite.json");
    expect(links.join).toBe(
      "https://weft.ifeanyiugwu.dev/join/?weft-invite=https%3A%2F%2Forg1.example.com%2F.well-known%2Fweft-invite.json",
    );
    expect(resolveInviteUrl(links.join)).toBe(links.url);
    expect(resolveInviteUrl(links.weft)).toBe(links.url);
  });
});
