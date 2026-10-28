import { describe, expect, it } from "vitest";
import {
  certificateHealth,
  explainEndorseError,
  explainStatus,
  isLowS,
  InviteError,
  p1363ToLowSDer,
  parseDerSignature,
  parseInvite,
  resolveInviteUrl,
  signForFabric,
  generateKeyPair,
  utf8,
  toBase64,
  fromBase64,
  fromBase64Url,
  toBase64Url,
} from "./index.js";

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function raw(r: bigint, s: bigint): Uint8Array {
  const hex = r.toString(16).padStart(64, "0") + s.toString(16).padStart(64, "0");
  return Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
}

describe("signatures", () => {
  it("flips a high S into the lower half", () => {
    const highS = P256_N - 5n;
    const der = p1363ToLowSDer(raw(123n, highS));
    expect(parseDerSignature(der)).toEqual({ r: 123n, s: 5n });
    expect(isLowS(der)).toBe(true);
  });

  it("pads integers whose top bit is set", () => {
    const der = p1363ToLowSDer(raw(0x80n << 248n, 1n));
    // SEQUENCE, len, INTEGER, 33 bytes (leading 0x00)
    expect(der[2]).toBe(0x02);
    expect(der[3]).toBe(33);
    expect(der[4]).toBe(0x00);
  });

  it("always produces low-S signatures from WebCrypto", async () => {
    const { privateKey } = await generateKeyPair();
    for (let i = 0; i < 20; i++) {
      expect(isLowS(await signForFabric(privateKey, utf8(`message ${i}`)))).toBe(true);
    }
  });
});

describe("base64", () => {
  it("round-trips binary", () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("round-trips base64url without padding", () => {
    for (const length of [1, 2, 3, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 97 + 251) % 256);
      const text = toBase64Url(bytes);
      expect(text).not.toMatch(/[+/=]/);
      expect(fromBase64Url(text)).toEqual(bytes);
    }
  });
});

describe("invites", () => {
  const valid = {
    weft: 1,
    network: "Acme Supply Network",
    organization: "Org1",
    mspId: "Org1MSP",
    caUrl: "https://ca.org1.example.com:7054/",
    relayUrl: "https://relay.org1.example.com",
    channels: ["mychannel"],
  };

  it("accepts a valid invite and trims trailing slashes", () => {
    expect(parseInvite(valid).caUrl).toBe("https://ca.org1.example.com:7054");
  });

  it("keeps an optional explorer URL, without a trailing slash", () => {
    expect(parseInvite({ ...valid, explorerUrl: "https://explorer.org1.example.com/" }).explorerUrl).toBe("https://explorer.org1.example.com");
    expect(parseInvite(valid).explorerUrl).toBeUndefined();
    expect(() => parseInvite({ ...valid, explorerUrl: "not a url" })).toThrow(/explorerUrl/);
  });

  it("lists every problem at once", () => {
    expect(() => parseInvite({ ...valid, mspId: "", channels: [] })).toThrow(/mspId.*channels/);
  });

  it("resolves weft:// links", () => {
    expect(resolveInviteUrl("weft://invite?u=https%3A%2F%2Forg1.example.com%2Finvite.json")).toBe(
      "https://org1.example.com/invite.json",
    );
  });

  it("refuses plain HTTP except on localhost", () => {
    expect(() => resolveInviteUrl("http://org1.example.com/invite.json")).toThrow(InviteError);
    expect(resolveInviteUrl("http://localhost:8080/invite.json")).toBe("http://localhost:8080/invite.json");
  });
});

describe("certificate health", () => {
  const now = new Date("2026-10-19T00:00:00Z");
  it("classifies expiry", () => {
    expect(certificateHealth({ notAfter: "2027-06-01T00:00:00Z" }, now).state).toBe("valid");
    expect(certificateHealth({ notAfter: "2026-10-28T12:00:00Z" }, now)).toEqual({ state: "expiring", daysLeft: 9 });
    expect(certificateHealth({ notAfter: "2026-10-01T00:00:00Z" }, now).state).toBe("expired");
  });
});

describe("explanations", () => {
  it("explains known validation codes", () => {
    expect(explainStatus("MVCC_READ_CONFLICT")).toMatchObject({ retryable: true });
    expect(explainStatus("ENDORSEMENT_POLICY_FAILURE").title).toMatch(/organisations/);
  });

  it("falls back for unknown codes", () => {
    expect(explainStatus("SOMETHING_NEW")).toMatchObject({ code: "SOMETHING_NEW", retryable: false });
  });

  it("treats gRPC timeouts as the network being unreachable", () => {
    expect(explainEndorseError("4 DEADLINE_EXCEEDED: Deadline exceeded after 5.003s, Waiting for LB pick").code).toBe(
      "UNAVAILABLE",
    );
  });

  it("recognises access-denied endorsement errors", () => {
    expect(explainEndorseError("rpc error: code = PermissionDenied desc = access denied").code).toBe("ACCESS_DENIED");
  });
});

describe("Fabric CA client", () => {
  it("explains an unreachable CA instead of 'Failed to fetch'", async () => {
    const { FabricCaClient } = await import("./index.js");
    const ca = new FabricCaClient({
      url: "https://localhost:7054",
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    await expect(ca.enroll("alice", "alicepw", await generateKeyPair())).rejects.toThrow(
      /Couldn't reach the CA at https:\/\/localhost:7054.*self-signed/,
    );
  });
});
