import type { VoterInvite } from "@weftwallet/protocol";
import { describe, expect, it } from "vitest";
import { InviteError, VoterInviteError, fetchInvite, fetchInviteDocument, parseInvite } from "./invite.ts";
import { isVoterInviteDocument, parseVoterInvite } from "./voter-invite.ts";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const invite: VoterInvite = {
  weftVoterInvite: 1,
  network: "Weft playground",
  organization: "Chair 2027 voters",
  mspId: "ChairVoters2027MSP",
  affiliation: "voters",
  caUrl: "http://localhost:7081",
  caName: "ca-chair-2027",
  relayUrl: "http://localhost:8787",
  relayOperator: "Weft Playground",
  channel: "privatevote-chair-2027",
  chaincode: "private-ballot",
  electionId: "chair-2027",
  issuerKeyHash: "f".repeat(64),
  curve: "FP256BN_AMCL",
  endorsers: [
    { mspId: "Org1MSP", caChain: PEM },
    { mspId: "Org2MSP", caChain: PEM },
  ],
  explorerUrl: "http://localhost:8790",
};

const served = (json: unknown) => async () => new Response(JSON.stringify(json), { headers: { "content-type": "application/json" } });

describe("parseVoterInvite", () => {
  it("keeps only the fields a voter invite has, without trailing slashes", () => {
    expect(parseVoterInvite({ ...invite, extra: "dropped", relayUrl: "http://localhost:8787/" })).toEqual(invite);
    const { caName: _n, explorerUrl: _e, ...bare } = invite;
    expect(parseVoterInvite(bare)).toEqual(bare);
  });

  it("checks every field, naming the source", () => {
    const bad = (change: Record<string, unknown>) => () => parseVoterInvite({ ...invite, ...change }, "x.json");
    expect(bad({ weftVoterInvite: 2 })).toThrow('x.json isn\'t a voter invite Weft Experimental can use: "weftVoterInvite" must be 1.');
    expect(bad({ weft: 1 })).toThrow(/has a "weft" field/);
    for (const field of ["network", "organization", "mspId", "affiliation", "relayOperator", "channel", "chaincode", "electionId"]) {
      expect(bad({ [field]: "" })).toThrow(`"${field}" is missing or empty`);
    }
    expect(bad({ caUrl: "ftp://ca" })).toThrow(/"caUrl" must be an http or https URL/);
    expect(bad({ relayUrl: "relay" })).toThrow(/"relayUrl" must be an http or https URL/);
    expect(bad({ explorerUrl: "nope" })).toThrow(/"explorerUrl" must be an http or https URL/);
    expect(bad({ caName: "" })).toThrow(/"caName" must be a name/);
    expect(bad({ issuerKeyHash: "F".repeat(64) })).toThrow(/"issuerKeyHash" must be 64 lowercase hex characters/);
    expect(bad({ curve: "BN254" })).toThrow(/"curve" must be FP256BN_AMCL/);
    expect(bad({ endorsers: [] })).toThrow(/"endorsers" must list at least one organisation/);
    expect(bad({ endorsers: [{ caChain: PEM }] })).toThrow(/endorsers\[0\] has no "mspId"/);
    expect(bad({ endorsers: [{ mspId: "Org1MSP", caChain: "nope" }] })).toThrow(/endorsers\[0\]'s "caChain" must be PEM/);
    expect(() => parseVoterInvite([invite])).toThrow("This document isn't a voter invite Weft Experimental can use: it isn't a JSON object.");
  });

  it("throws InviteError with the problem as the detail", () => {
    const error = (() => {
      try {
        parseVoterInvite({ ...invite, curve: "x" });
      } catch (e) {
        return e;
      }
    })() as InviteError;
    expect(error).toBeInstanceOf(InviteError);
    expect(error.detail).toBe('"curve" must be FP256BN_AMCL');
  });

  it("recognises a voter invite by its field, whatever else is wrong", () => {
    expect(isVoterInviteDocument(invite)).toBe(true);
    expect(isVoterInviteDocument({ weftVoterInvite: 7 })).toBe(true);
    expect(isVoterInviteDocument({ weft: 1 })).toBe(false);
    expect(isVoterInviteDocument(null)).toBe(false);
  });
});

describe("normal Weft and a voter invite (D11)", () => {
  it("parseInvite names a voter invite before any other check", () => {
    expect(() => parseInvite({ weftVoterInvite: 1 })).toThrow(VoterInviteError);
    expect(() => parseInvite(invite)).toThrow(
      "This is a voter invite for an election, and only Weft Experimental can hold voter credentials. Nothing was sent to the CA. Open the invite in Weft Experimental.",
    );
  });

  it("fetchInvite passes that message on, rather than calling the invite mistaken", async () => {
    const error = (await fetchInvite("http://localhost:8787/.well-known/weft-voter-invite/chair-2027.json", served(invite)).catch((e) => e)) as InviteError;
    expect(error).toBeInstanceOf(VoterInviteError);
    expect(error.message).toMatch(/^This is a voter invite for an election/);
    expect(error.detail).toBe('The document has "weftVoterInvite": 1. Weft reads invites with "weft": 1.');
  });

  it("an organisation's invite with mistakes still gets the usual message", async () => {
    const error = (await fetchInvite("http://localhost:8787/invite.json", served({ weft: 1 })).catch((e) => e)) as InviteError;
    expect(error).not.toBeInstanceOf(VoterInviteError);
    expect(error.message).toBe("This invite has mistakes in it, so Weft can't use it. Ask your administrator for a new one.");
  });

  it("fetchInviteDocument returns the JSON unchecked, with the resolved URL", async () => {
    const out = await fetchInviteDocument("weft://invite?u=http://localhost:8787/x.json", served(invite));
    expect(out).toEqual({ url: "http://localhost:8787/x.json", json: invite });
  });
});
