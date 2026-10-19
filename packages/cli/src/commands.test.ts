import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkInvite, createInvite, shareInvite } from "./commands.ts";

const dir = mkdtempSync(join(tmpdir(), "weft-cli-"));

describe("createInvite", () => {
  it("builds from explicit fields", async () => {
    const invite = await createInvite({
      relay: "https://relay.org1.example.com",
      mspId: "Org1MSP",
      caUrl: "https://ca.org1.example.com:7054",
      channels: ["mychannel"],
    });
    expect(invite).toMatchObject({ organization: "Org1MSP", network: "Org1MSP network", channels: ["mychannel"] });
  });

  it("builds from a YAML profile", async () => {
    const profile = join(dir, "connection.yaml");
    writeFileSync(
      profile,
      "client: {organization: Org1}\norganizations: {Org1: {mspid: Org1MSP, certificateAuthorities: [ca1]}}\ncertificateAuthorities: {ca1: {url: 'https://ca.example.com'}}\nchannels: {mychannel: {}}\n",
    );
    expect((await createInvite({ profile, relay: "https://relay.example.com", channels: [] })).channels).toEqual([
      "mychannel",
    ]);
  });

  it("requires a relay", async () => {
    await expect(createInvite({ channels: [] })).rejects.toThrow(/--relay/);
  });
});

describe("shareInvite", () => {
  it("writes an SVG QR of the join link", async () => {
    const qr = join(dir, "invite.svg");
    const result = await shareInvite("weft://invite?u=https%3A%2F%2Forg1.example.com%2Finvite.json", { qr });
    expect(result.url).toBe("https://org1.example.com/invite.json");
    expect(readFileSync(qr, "utf8")).toMatch(/^<svg/);
  });
});

describe("checkInvite", () => {
  it("reports an invalid invite file", async () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ weft: 1 }));
    const [line] = await checkInvite(file);
    expect(line).toMatchObject({ ok: false, label: "Invite" });
  });
});
