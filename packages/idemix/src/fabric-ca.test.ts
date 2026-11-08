/**
 * Enrolment against a real Fabric CA, run only when WEFT_FABRIC_CA_BIN names
 * a folder with fabric-ca-server and fabric-ca-client (for example
 * e2e/.bin after e2e/scripts/fabric-ca.sh). The module does both steps of
 * the idemix enrolment over HTTP, as Weft will, and IBM idemix's MSP accepts
 * the signatures under the CA's own issuer key files.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdemixApi, VoterCredentialSecret } from "./module.ts";
import { startIdemixNode } from "./node.ts";
import { verify } from "./test/tool.ts";

const bin = process.env.WEFT_FABRIC_CA_BIN;
const skip = process.env.WEFT_IDEMIX_SKIP ?? (bin ? undefined : "WEFT_FABRIC_CA_BIN isn't set");
const mspId = "ChairVoters2027MSP";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

describe.skipIf(skip)("enrolment against Fabric CA", () => {
  let server: ChildProcess;
  let home: string;
  let url: string;
  let api: IdemixApi;
  let credential: VoterCredentialSecret;
  const timings: Record<string, number> = {};

  const post = async (auth: string, body: unknown) => {
    const res = await fetch(`${url}/api/v1/idemix/credential`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as { success: boolean; result: Record<string, any>; errors: { code: number; message: string }[] };
  };
  const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "weft-idemix-ca-"));
    const port = await freePort();
    url = `http://localhost:${port}`;
    server = spawn(join(bin!, "fabric-ca-server"), ["start", "-b", "admin:adminpw", "--port", String(port), "--home", join(home, "server"), "--operations.listenaddress", `127.0.0.1:${await freePort()}`], { stdio: "ignore" });
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${url}/api/v1/cainfo`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    const client = (args: string[]) => execFileSync(join(bin!, "fabric-ca-client"), args, { env: { ...process.env, FABRIC_CA_CLIENT_HOME: join(home, "admin") }, stdio: "pipe" });
    client(["enroll", "-u", `http://admin:adminpw@localhost:${port}`]);
    client(["affiliation", "add", "voters", "-u", url]);
    for (const id of ["voter1", "voter2"]) {
      client(["register", "-u", url, "--id.name", id, "--id.secret", `${id}pw`, "--id.type", "client", "--id.affiliation", "voters", "--id.maxenrollments", "1"]);
    }
    api = (await startIdemixNode()).api;
  });

  afterAll(() => {
    server?.kill();
  });

  it("serves the issuer key with the bytes of its IssuerPublicKey file", async () => {
    const info = (await (await fetch(`${url}/api/v1/cainfo`)).json()) as { result: { IssuerPublicKey: string } };
    const file = readFileSync(join(home, "server", "IssuerPublicKey"));
    expect(Buffer.from(info.result.IssuerPublicKey, "base64").equals(file)).toBe(true);
    const { issuerKeyHash } = await api.loadIssuerKey(info.result.IssuerPublicKey);
    expect(issuerKeyHash).toBe(createHash("sha256").update(file).digest("hex"));
  });

  it("enrols with the module alone, and the CA refuses a second enrolment", async () => {
    const auth = basic("voter1", "voter1pw");
    let t = performance.now();
    const first = await post(auth, {});
    timings.nonce = performance.now() - t;
    expect(first.success).toBe(true);
    const req = await api.credentialRequest(first.result.Nonce);
    t = performance.now();
    const second = await post(auth, { request: req.request, caname: "" });
    timings.issue = performance.now() - t;
    expect(second.success, JSON.stringify(second.errors)).toBe(true);
    const attrs = second.result.Attrs as { OU: string; Role: number; EnrollmentID: string };
    expect(attrs).toMatchObject({ OU: "voters", Role: 1, EnrollmentID: "voter1" });
    credential = { secretKey: req.secretKey, credential: second.result.Credential, cri: second.result.CRI, ou: attrs.OU, role: attrs.Role, enrollmentId: attrs.EnrollmentID };
    await expect(api.checkCredential(credential)).resolves.toBe("valid");
    const again = await post(auth, {});
    expect(again.success).toBe(false);
    expect(again.errors[0]?.code).toBe(20);
  });

  it("signs as an identity IBM's MSP accepts under the CA's issuer key files", async () => {
    const id = await api.newIdentity(credential, mspId);
    const message = Buffer.from("a proposal");
    const signature = await api.sign(id.handle, message.toString("base64"));
    const len = (n: number) => (n < 0x80 ? [n] : [(n & 0x7f) | 0x80, n >> 7]);
    const idBytes = Buffer.from(id.idBytes, "base64");
    const creator = Buffer.concat([Buffer.from([0x0a, mspId.length]), Buffer.from(mspId), Buffer.from([0x12, ...len(idBytes.length)]), idBytes]);
    const result = verify({
      mspId,
      issuerPublicKey: readFileSync(join(home, "server", "IssuerPublicKey")).toString("base64"),
      revocationPublicKey: readFileSync(join(home, "server", "IssuerRevocationPublicKey")).toString("base64"),
      creator: creator.toString("base64"),
      message: message.toString("base64"),
      signature,
    });
    expect(result).toEqual({ ok: { mspId, ou: "voters", role: "MEMBER" } });
    console.log("Fabric CA round trips:", Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, `${v.toFixed(0)} ms`])));
  });

  it("finds the binaries it was given", () => {
    expect(existsSync(join(bin!, "fabric-ca-server"))).toBe(true);
  });
});
