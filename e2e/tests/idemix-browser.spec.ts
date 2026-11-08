/**
 * The idemix WebAssembly module in a real browser (docs/adr/0008), as Weft
 * Experimental runs it: the pinned module in a module worker, started with
 * @weftwallet/idemix's client. A voter enrols against a real Fabric CA (a
 * scratch one, from FABRIC_CA_BIN), the CA's two requests made by the test
 * and the credential request by the module in the browser. Then one
 * credential's one-off identities each get their own Nym, and its pseudonym
 * is the same under every Nym in one election and different in another.
 *
 * The page is served by Playwright's routing at http://localhost:4390, from
 * packages/idemix/dist. It needs the module built (Go) and skips without it.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ROOT } from "../support/stack.ts";

const DIST = join(ROOT, "packages", "idemix", "dist");
const CA_BIN = process.env.FABRIC_CA_BIN ?? join(ROOT, "e2e", ".bin");
const built = existsSync(join(DIST, "wasm", "weft-idemix.wasm")) && existsSync(join(DIST, "client.js"));
// localhost, so the page is a secure context and has WebCrypto. Playwright answers every request; nothing listens on the port.
const ORIGIN = "http://localhost:4390";
const MSP = "ChairVoters2027MSP";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const TYPES: Record<string, string> = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html" };

/** A page at ORIGIN with the idemix package's dist at /idemix/. */
async function modulePage(page: Page) {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>idemix</title>" });
    const file = normalize(join(DIST, path.replace(/^\/idemix\//, "")));
    if (!path.startsWith("/idemix/") || !file.startsWith(DIST) || !existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  await page.goto(`${ORIGIN}/`);
}

test.describe("the idemix module in the browser", () => {
  test.skip(!built, "The idemix module isn't built (pnpm --filter @weftwallet/idemix build:wasm, which needs Go).");
  test.skip(!existsSync(join(CA_BIN, "fabric-ca-server")), `Fabric CA isn't in ${CA_BIN}. Run e2e/scripts/fabric-ca.sh, or set FABRIC_CA_BIN.`);

  let server: ChildProcess | undefined;
  let home = "";
  let url = "";

  test.beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "weft-idemix-browser-"));
    const port = await freePort();
    url = `http://localhost:${port}`;
    server = spawn(join(CA_BIN, "fabric-ca-server"), ["start", "-b", "admin:adminpw", "--port", String(port), "--home", join(home, "server"), "--operations.listenaddress", `127.0.0.1:${await freePort()}`], {
      stdio: "ignore",
    });
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${url}/api/v1/cainfo`)).ok) break;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const client = (args: string[]) => execFileSync(join(CA_BIN, "fabric-ca-client"), args, { env: { ...process.env, FABRIC_CA_CLIENT_HOME: join(home, "admin") }, stdio: "pipe" });
    client(["enroll", "-u", `http://admin:adminpw@localhost:${port}`]);
    client(["affiliation", "add", "voters", "-u", url]);
    client(["register", "-u", url, "--id.name", "voter1", "--id.secret", "voter1pw", "--id.type", "client", "--id.affiliation", "voters", "--id.maxenrollments", "1"]);
  });

  test.afterAll(() => {
    server?.kill();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("one credential: a new Nym for every identity, one pseudonym per election under all of them", async ({ page }) => {
    test.setTimeout(120_000);
    await modulePage(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    // The module starts in a module worker, checking both files' SHA-256 against the pinned ones.
    const info = (await (await fetch(`${url}/api/v1/cainfo`)).json()) as { result: { IssuerPublicKey: string } };
    const started = await page.evaluate(async (ipk) => {
      const client = "/idemix/client.js";
      const { startIdemixWorker } = await import(client);
      const worker = new Worker("/idemix/worker.js", { type: "module" });
      const api = await startIdemixWorker({ worker, wasmUrl: "/idemix/wasm/weft-idemix.wasm", wasmExecUrl: "/idemix/wasm/wasm_exec.js" });
      (globalThis as unknown as { api: typeof api }).api = api;
      return { info: await api.info(), loaded: await api.loadIssuerKey(ipk), timings: api.timings };
    }, info.result.IssuerPublicKey);
    expect(started.info).toMatchObject({ curve: "FP256BN_AMCL" });
    expect(started.loaded.issuerKeyHash).toMatch(/^[0-9a-f]{64}$/);

    // Enrolment: the CA's nonce, the module's credential request, the CA's credential.
    const post = async (body: unknown) =>
      (await (
        await fetch(`${url}/api/v1/idemix/credential`, {
          method: "POST",
          headers: { authorization: `Basic ${Buffer.from("voter1:voter1pw").toString("base64")}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json()) as { success: boolean; result: Record<string, any> };
    const first = await post({});
    expect(first.success).toBe(true);
    const request = await page.evaluate((nonce) => (globalThis as any).api.credentialRequest(nonce), first.result.Nonce as string);
    const second = await post({ request: request.request });
    expect(second.success).toBe(true);
    const credential = {
      secretKey: request.secretKey,
      credential: second.result.Credential,
      cri: second.result.CRI,
      ou: second.result.Attrs.OU,
      role: second.result.Attrs.Role,
      enrollmentId: second.result.Attrs.EnrollmentID,
    };

    const out = await page.evaluate(
      async ({ credential, msp }) => {
        const api = (globalThis as any).api;
        const checked = await api.checkCredential(credential);
        const ids = [await api.newIdentity(credential, msp), await api.newIdentity(credential, msp), await api.newIdentity(credential, msp)];
        const e1 = ["privatevote-chair-2027", "chair-2027"] as const;
        const e2 = ["privatevote-chair-2028", "chair-2028"] as const;
        const inE1 = await Promise.all(ids.map((id: { handle: number }) => api.pseudonym(id.handle, ...e1)));
        const inE2 = await Promise.all(ids.map((id: { handle: number }) => api.pseudonym(id.handle, ...e2)));
        // The proof made under one Nym checks out against that Nym only, as the contract checks it.
        const tracking = "ab".repeat(32);
        const proof = await api.pseudonymProof(ids[0].handle, ...e1, tracking);
        const own = await api.verifyPseudonym(ids[0].nym, ...e1, tracking, proof).then(
          () => "valid",
          (e: Error) => e.message,
        );
        const other = await api.verifyPseudonym(ids[1].nym, ...e1, tracking, proof).then(
          () => "valid",
          (e: Error) => e.message,
        );
        for (const id of ids) await api.dispose(id.handle);
        api.terminate();
        return { checked, nyms: ids.map((i: { nym: string }) => i.nym), inE1, inE2, proof: proof.pseudonym, own, other };
      },
      { credential, msp: MSP },
    );

    expect(out.checked).toBe("valid");
    // Every identity has its own Nym.
    for (const nym of out.nyms) expect(nym).toMatch(/^[0-9a-f]{128}$/);
    expect(new Set(out.nyms).size).toBe(3);
    // One pseudonym per election, under every Nym, and another in another election.
    expect(new Set(out.inE1).size).toBe(1);
    expect(new Set(out.inE2).size).toBe(1);
    expect(out.inE1[0]).not.toBe(out.inE2[0]);
    expect(out.inE1[0]).toMatch(/^[0-9a-f]{128}$/);
    expect(out.proof).toBe(out.inE1[0]);
    expect(out.own).toBe("valid");
    expect(out.other).toMatch(/not valid/);
    expect(errors).toEqual([]);
    test.info().annotations.push({ type: "module start", description: `${Math.round(started.timings.total)} ms in the worker` });
  });
});
