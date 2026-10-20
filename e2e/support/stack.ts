/**
 * The services the tests talk to, started once for the whole run.
 *
 * Default ("ca") mode needs no Docker: two real Fabric CA servers (one issuing
 * one-year certificates, one issuing ten-day ones for the expiry tests), the
 * playground's CA proxy in front of each, and the relay with an invite. There
 * are no peers, so contract calls fail with "network could not be reached".
 *
 * With WEFT_E2E_STACK=playground the tests use a running `pnpm playground:up`
 * instead (real peers, Org1 demo users alice and bob), and the @fabric tests run.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const EXTENSION = join(ROOT, "apps/extension/.output-e2e/chrome-mv3");
const DOCS_DIST = join(ROOT, "apps/docs/dist");

export const PORTS = { ca: 7054, caShort: 7055, proxy: 7080, proxyShort: 7081, relay: 8787, docs: 4321, site: 5175 } as const;

export interface StackInfo {
  mode: "ca" | "playground";
  /** The relay's invite. */
  inviteUrl: string;
  /** An invite whose CA issues ten-day certificates (ca mode only). */
  shortInviteUrl: string | null;
  caUrl: string;
  relayUrl: string;
  /** Enrolment IDs and secrets registered on the main CA. */
  users: Record<string, string>;
  /** Users on the ten-day CA. */
  shortUsers: Record<string, string>;
  /** Base URL of the built docs site, or null when it isn't built. */
  docsUrl: string | null;
}

const processes: ChildProcess[] = [];
const servers: Server[] = [];
let workDir = "";

function caBin(): string {
  const dir = process.env.FABRIC_CA_BIN ?? join(ROOT, "e2e/.bin");
  if (!existsSync(join(dir, "fabric-ca-server"))) {
    throw new Error(`Fabric CA isn't in ${dir}. Run e2e/scripts/fabric-ca.sh, or set FABRIC_CA_BIN.`);
  }
  return dir;
}

function background(name: string, command: string, args: string[], env: Record<string, string> = {}, cwd = ROOT) {
  const log = join(workDir, `${name}.log`);
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (d: Buffer) => chunks.push(d));
  child.stderr?.on("data", (d: Buffer) => chunks.push(d));
  child.on("exit", () => writeFileSync(log, Buffer.concat(chunks)));
  processes.push(child);
  return { child, output: () => Buffer.concat(chunks).toString() };
}

async function waitFor(url: string, what: string, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} didn't start at ${url}. Logs: ${workDir}`);
}

/** For the CA, whose self-signed HTTPS fetch() would refuse: an open port is enough. */
async function waitForPort(port: number, what: string, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.end();
        resolve(true);
      }).on("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} didn't start on port ${port}. Logs: ${workDir}`);
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer().once("error", () => resolve(false)).listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/** Starts a Fabric CA, registers users, and puts the CA proxy in front of it. */
async function startCa(name: string, port: number, proxyPort: number, expiry: string, users: Record<string, string>) {
  const bin = caBin();
  const home = join(workDir, name);
  mkdirSync(home, { recursive: true });
  // Each CA needs its own operations port, or the second one fails to start.
  const env = { FABRIC_CA_SERVER_OPERATIONS_LISTENADDRESS: `127.0.0.1:${port + 2000}` };
  const init = spawnSync(join(bin, "fabric-ca-server"), ["init", "-b", "admin:adminpw", "--tls.enabled", "-n", "ca-org1", "-H", home], {
    env: { ...process.env, ...env },
  });
  if (init.status !== 0) throw new Error(`fabric-ca-server init failed: ${init.stderr}`);
  const configPath = join(home, "fabric-ca-server-config.yaml");
  writeFileSync(configPath, readFileSync(configPath, "utf8").replace(/(signing:\s*\n\s*default:\s*\n(?:.*\n)*?\s*expiry:\s*)\S+/, `$1${expiry}`));
  background(name, join(bin, "fabric-ca-server"), ["start", "-b", "admin:adminpw", "--tls.enabled", "-p", String(port), "-n", "ca-org1", "-H", home], env);
  await waitForPort(port, `Fabric CA (${name})`);

  const clientHome = join(home, "admin");
  const tls = join(home, "ca-cert.pem");
  const client = (args: string[]) => {
    const r = spawnSync(join(bin, "fabric-ca-client"), [...args, "--tls.certfiles", tls], {
      env: { ...process.env, FABRIC_CA_CLIENT_HOME: clientHome },
    });
    if (r.status !== 0) throw new Error(`fabric-ca-client ${args[0]} failed: ${r.stderr}`);
  };
  client(["enroll", "-u", `https://admin:adminpw@localhost:${port}`, "--caname", "ca-org1"]);
  for (const [id, secret] of Object.entries(users)) {
    client([
      "register", "-u", `https://localhost:${port}`, "--caname", "ca-org1",
      "--id.name", id, "--id.secret", secret, "--id.type", "client", "--id.attrs", "role=auditor:ecert",
    ]);
  }

  background(`${name}-proxy`, process.execPath, [
    join(ROOT, "playground/ca-proxy.mjs"),
    "--listen", String(proxyPort),
    "--target", `https://localhost:${port}`,
    "--upstream-ca", tls,
  ]);
  await waitFor(`http://localhost:${proxyPort}/cainfo`, `CA proxy (${name})`);
  return { tls };
}

/** Serves a folder, for the built docs site. */
function serveStatic(dir: string, port: number): Promise<void> {
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".webp": "image/webp" };
  const server = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = join(dir, path);
    const target = existsSync(file) ? file : existsSync(`${file}/index.html`) ? `${file}/index.html` : null;
    if (!target || !target.startsWith(dir)) {
      res.statusCode = 404;
      return res.end("not found");
    }
    res.setHeader("content-type", types[extname(target)] ?? "application/octet-stream");
    res.end(readFileSync(target));
  });
  servers.push(server);
  return new Promise((r) => server.listen(port, "127.0.0.1", r));
}

export async function startStack(): Promise<StackInfo> {
  const mode = process.env.WEFT_E2E_STACK === "playground" ? "playground" : "ca";
  if (!existsSync(join(EXTENSION, "manifest.json"))) {
    throw new Error("Build the test extension first: pnpm --filter @weftwallet/extension build:e2e");
  }
  workDir = mkdtempSync(join(tmpdir(), "weft-e2e-"));

  let docsUrl: string | null = null;
  if (existsSync(join(DOCS_DIST, "playground/index.html")) && (await portFree(PORTS.docs))) {
    await serveStatic(DOCS_DIST, PORTS.docs);
    docsUrl = `http://localhost:${PORTS.docs}`;
  }

  if (mode === "playground") {
    const inviteUrl = `http://localhost:${PORTS.relay}/.well-known/weft-invite.json`;
    await waitFor(inviteUrl, "The playground relay (run pnpm playground:up first)", 5000);
    return {
      mode, inviteUrl, shortInviteUrl: null,
      caUrl: `http://localhost:${PORTS.proxy}`, relayUrl: `http://localhost:${PORTS.relay}`,
      users: { alice: "alicepw", bob: "bobpw" }, shortUsers: {}, docsUrl,
    };
  }

  for (const port of [PORTS.ca, PORTS.caShort, PORTS.proxy, PORTS.proxyShort, PORTS.relay]) {
    if (!(await portFree(port))) {
      throw new Error(`Port ${port} is in use. Stop the playground (pnpm playground:down), or run with WEFT_E2E_STACK=playground to test against it.`);
    }
  }

  const users = { alice: "alicepw", bob: "bobpw" };
  const shortUsers = { erin: "erinpw" };
  const { tls } = await startCa("ca", PORTS.ca, PORTS.proxy, "8760h", users);
  await startCa("ca-short", PORTS.caShort, PORTS.proxyShort, "240h", shortUsers);

  const relayUrl = `http://localhost:${PORTS.relay}`;
  const invite = {
    weft: 1, network: "Weft e2e", organization: "Org1", mspId: "Org1MSP",
    caUrl: `http://localhost:${PORTS.proxy}`, caName: "ca-org1", relayUrl, channels: ["mychannel"],
  };
  const inviteFile = join(workDir, "invite.json");
  writeFileSync(inviteFile, JSON.stringify(invite));
  // No peers: the endpoint is closed, so contract calls fail fast.
  const relay = background("relay", process.execPath, [join(ROOT, "apps/relay/dist/main.js")], {
    PORT: String(PORTS.relay),
    WEFT_PEER_ENDPOINT: "localhost:7051",
    WEFT_PEER_HOST_ALIAS: "peer0.org1.example.com",
    WEFT_PEER_TLS_CA_CERT: tls,
    WEFT_INVITE_FILE: inviteFile,
    WEFT_PUBLIC_URL: relayUrl,
  });
  await waitFor(`${relayUrl}/v1/health`, `The relay (${relay.output().slice(-300)})`);

  // The ten-day CA's invite, served from a file next to the relay's.
  const shortInvite = { ...invite, network: "Weft e2e (ten-day certificates)", caUrl: `http://localhost:${PORTS.proxyShort}`, relayUrl };
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("access-control-allow-origin", "*");
    res.end(JSON.stringify(shortInvite));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(PORTS.proxyShort + 1000, "127.0.0.1", r));

  return {
    mode, inviteUrl: `${relayUrl}/.well-known/weft-invite.json`,
    shortInviteUrl: `http://localhost:${PORTS.proxyShort + 1000}/invite.json`,
    caUrl: invite.caUrl, relayUrl, users, shortUsers, docsUrl,
  };
}

export async function stopStack(): Promise<void> {
  for (const s of servers) s.close();
  for (const p of processes) p.kill();
  await new Promise((r) => setTimeout(r, 300));
  if (workDir && !process.env.WEFT_E2E_KEEP) rmSync(workDir, { recursive: true, force: true });
}
