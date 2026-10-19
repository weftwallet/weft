import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RelayConfig } from "./config.ts";
import { GatewayPool } from "./gateways.ts";
import { INVITE_PATH, loadInvite } from "./invite.ts";
import { buildServer } from "./server.ts";

const dir = mkdtempSync(join(tmpdir(), "weft-invite-"));
const profilePath = join(dir, "connection-org1.yaml");
writeFileSync(
  profilePath,
  `name: test-network-org1
client:
  organization: Org1
organizations:
  Org1:
    mspid: Org1MSP
    certificateAuthorities: [ca.org1.example.com]
certificateAuthorities:
  ca.org1.example.com:
    url: https://localhost:7054
    caName: ca-org1
`,
);

const base: RelayConfig = {
  port: 0,
  host: "127.0.0.1",
  peerEndpoint: "localhost:1",
  peerHostAlias: undefined,
  peerTlsCaCert: undefined,
  allowedOrigins: "*",
  allowedMspIds: undefined,
  maxGateways: 4,
  invite: null,
  publicUrl: undefined,
  joinPage: undefined,
};
const pool = new GatewayPool(base);
afterAll(() => pool.close());

describe("relay invite", () => {
  it("builds the invite from a YAML connection profile", () => {
    const invite = loadInvite({
      WEFT_CONNECTION_PROFILE: profilePath,
      WEFT_PUBLIC_URL: "https://relay.org1.example.com",
      WEFT_INVITE_CHANNELS: "mychannel, audit",
    });
    expect(invite).toMatchObject({
      mspId: "Org1MSP",
      caName: "ca-org1",
      relayUrl: "https://relay.org1.example.com",
      channels: ["mychannel", "audit"],
    });
  });

  it("is optional", () => {
    expect(loadInvite({})).toBeNull();
  });

  it("serves the invite, or 404 when there is none", async () => {
    const invite = loadInvite({
      WEFT_CONNECTION_PROFILE: profilePath,
      WEFT_PUBLIC_URL: "https://relay.org1.example.com",
      WEFT_INVITE_CHANNELS: "mychannel",
    });
    const withInvite = buildServer({ ...base, invite }, pool);
    const ok = await withInvite.inject({ method: "GET", url: INVITE_PATH, headers: { origin: "https://anything.example" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBeTruthy();
    expect(ok.json()).toMatchObject({ weft: 1, mspId: "Org1MSP" });

    const without = buildServer(base, pool);
    expect((await without.inject({ method: "GET", url: INVITE_PATH })).statusCode).toBe(404);
  });
});
