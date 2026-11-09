#!/usr/bin/env node
/**
 * `pnpm check:mac`: the checks that need Docker and a real machine, in
 * order, on a fresh experimental playground. It stops a step's dependants
 * when the step fails, with a message that says why, runs what doesn't
 * depend on it, and prints a summary, the log file's path and what to look
 * at by hand afterwards.
 *
 *   pnpm check:mac              every step
 *   pnpm check:mac --no-https   skip the --https round even when mkcert is installed
 *   pnpm check:mac --verbose    show each command's output as it runs, not only in the log
 *
 * It takes the playground down first, so it ends with a new network running
 * `pnpm playground:up --experimental`, ready for the checks by hand. The log
 * is .mac-check/mac-check-<time>.log, with every command's whole output.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requirePinnedNode } from "./node-version.mjs";

requirePinnedNode();

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const flags = new Set(process.argv.slice(2).filter((a) => a !== "--"));
const verbose = flags.has("--verbose");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const logDir = join(repo, ".mac-check");
mkdirSync(logDir, { recursive: true });
const logPath = join(logDir, `mac-check-${stamp}.log`);
const log = createWriteStream(logPath);

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint(1);
const green = paint(32);
const red = paint(31);
const dim = paint(2);
const say = (line = "") => {
  console.log(line);
  log.write(`${line.replace(/\x1b\[[0-9;]*m/g, "")}\n`);
};
const seconds = (ms) => (ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`);

/** Runs a command from the repository root, its output in the log (and on screen with --verbose). Resolves with its status and output. */
function sh(command, args, { env = {}, cwd = repo, timeout = 60 * 60_000 } = {}) {
  log.write(`\n$ ${[command, ...args].join(" ")}${cwd !== repo ? `   (in ${relative(repo, cwd) || "."})` : ""}\n`);
  return new Promise((done) => {
    let output = "";
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    const take = (chunk) => {
      output += chunk;
      log.write(chunk);
      if (verbose) process.stdout.write(chunk);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ status: 127, output: `${output}${error.message}\n` });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      done({ status: status ?? (signal ? 1 : 0), output: signal ? `${output}\nStopped after ${seconds(timeout)} (${signal}).\n` : output });
    });
  });
}

/** The last lines of a command's output, for a failure's message. */
const tail = (output, n = 12) => output.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-n).join("\n       ");

/** A failed command, as a step's error: what it was, and the end of its output. */
class Failed extends Error {}
async function must(command, args, options, what = `${command} ${args.join(" ")}`) {
  const r = await sh(command, args, options);
  if (r.status !== 0) throw new Failed(`${what} exited with ${r.status}.\n       ${tail(r.output)}`);
  return r.output;
}

const results = [];
/**
 * One step. `needs` names earlier steps it depends on: if one didn't pass,
 * this one is skipped and says which. A step returns a line to show under
 * it, and throws to fail.
 */
async function step(name, needs, run, { optional = false } = {}) {
  const missing = needs.find((n) => results.find((r) => r.name === n)?.outcome !== "pass");
  if (missing) {
    results.push({ name, outcome: "skip", detail: `Not run: "${missing}" didn't pass.` });
    say(`${dim("SKIP")} ${name}\n     ${dim(`Not run: "${missing}" didn't pass.`)}`);
    return;
  }
  say(`${dim("....")} ${name}`);
  const t = Date.now();
  try {
    const detail = await run();
    if (detail === SKIPPED) {
      results.push({ name, outcome: optional ? "optional" : "skip", detail: SKIPPED.reason, ms: Date.now() - t });
      say(`${dim("SKIP")} ${name}\n     ${dim(SKIPPED.reason)}`);
      return;
    }
    const ms = Date.now() - t;
    results.push({ name, outcome: "pass", detail, ms });
    say(`${green("PASS")} ${name} ${dim(`(${seconds(ms)})`)}${detail ? `\n     ${detail}` : ""}`);
  } catch (error) {
    const ms = Date.now() - t;
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, outcome: "fail", detail, ms });
    say(`${red("FAIL")} ${name} ${dim(`(${seconds(ms)})`)}\n     ${detail}`);
  }
}
const SKIPPED = { reason: "" };
const skip = (reason) => ((SKIPPED.reason = reason), SKIPPED);

const has = (command) => spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0 || spawnSync("which", [command], { stdio: "ignore" }).status === 0;

/* ------------------------------------------------------------------ */
/* The steps                                                           */
/* ------------------------------------------------------------------ */

say(bold("Weft: the checks for a Mac with Docker"));
say(dim(`${new Date().toString()}. Log: ${relative(process.cwd(), logPath)}`));
say(dim(`Node ${process.version}, ${process.platform} ${process.arch}\n`));

const playground = await import(pathToFileURL(join(repo, "playground", "experimental.mjs")).href);
const STATE = join(repo, "playground", ".state");

await step("Docker is running", [], async () => {
  if (!has("docker")) throw new Error("Docker isn't installed. Install Docker Desktop or OrbStack, start it, then run pnpm check:mac again. Every step but the Go and module checks needs it.");
  const r = await sh("docker", ["info", "--format", "{{.ServerVersion}} {{.OperatingSystem}} {{.NCPU}} CPUs {{.MemTotal}}"]);
  if (r.status !== 0) throw new Error(`Docker is installed but its daemon didn't answer. Start Docker Desktop or OrbStack, then run pnpm check:mac again.\n       ${tail(r.output, 3)}`);
  const [version, ...rest] = r.output.trim().split(" ");
  const mem = Number(rest.at(-1));
  return `Docker ${version}, ${rest.slice(0, -1).join(" ")}${mem ? `, ${(mem / 2 ** 30).toFixed(1)} GiB` : ""}`;
});

await step("The packages are built", [], async () => {
  await must("pnpm", ["build"], {}, "pnpm build");
  return "pnpm build";
});

await step("pnpm playground:down", ["Docker is running"], async () => {
  await must("pnpm", ["playground:down"], {}, "pnpm playground:down");
  return "the old network, its channels and .state's files are gone";
});

await step("pnpm playground:up --experimental", ["pnpm playground:down", "The packages are built"], async () => {
  const out = await must("pnpm", ["playground:up", "--experimental"], { timeout: 45 * 60_000 }, "pnpm playground:up --experimental");
  if (!/Weft playground is running/.test(out)) throw new Error("playground:up finished without saying the playground is running. See the log.");
  return "the network, both explorers, the relay, the voters' CAs and their proxies, with every election in ELECTIONS";
});

await step("The private-ballot contract builds offline in fabric-ccenv:2.5", ["pnpm playground:up --experimental"], async () => {
  // As the peer builds it: the vendored module, in hyperledger/fabric-ccenv:2.5,
  // here with no network at all, so a toolchain download would fail.
  if (!has("go")) throw new Error("Go isn't on PATH, and the contract's modules are vendored with it, as test-network's deployCC does. Install Go (brew install go).");
  const work = mkdtempSync(join(tmpdir(), "weft-ccenv-"));
  try {
    cpSync(join(repo, "contracts", "private-ballot"), join(work, "src"), { recursive: true, filter: (p) => !p.split(/[\\/]/).includes("vendor") });
    await must("go", ["mod", "vendor"], { cwd: join(work, "src") }, "go mod vendor");
    const toolchain = readFileSync(join(work, "src", "go.mod"), "utf8").match(/^toolchain (\S+)/m)?.[1] ?? "none";
    const out = await must(
      "docker",
      ["run", "--rm", "--network", "none", "-v", `${join(work, "src")}:/chaincode/input:ro`, "-w", "/chaincode/input", "hyperledger/fabric-ccenv:2.5", "sh", "-c", "go version && go env GOTOOLCHAIN && go build -v -mod=vendor -o /tmp/chaincode . && echo built"],
      { timeout: 20 * 60_000 },
      "the build in fabric-ccenv:2.5 without network",
    );
    if (!/\bbuilt\s*$/.test(out.trim())) throw new Error("The build in fabric-ccenv:2.5 didn't finish. See the log.");
    const go = out.match(/go version (go\S+)/)?.[1] ?? "unknown Go";
    const mode = out.split("\n")[1]?.trim() ?? "";
    return `${go} in the image (GOTOOLCHAIN=${mode || "unset"}), go.mod's toolchain line ${toolchain}, built with --network none`;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

for (const e of playground.voterElections()) {
  await step(`pnpm playground:credentials ${e.id}`, ["pnpm playground:up --experimental"], async () => {
    const out = await must("pnpm", ["playground:credentials", e.id], {}, `pnpm playground:credentials ${e.id}`);
    return tail(out, 3).replace(/\n\s+/g, "; ");
  });
}

await step("pnpm playground:smoke", ["pnpm playground:up --experimental"], async () => {
  const out = await must("pnpm", ["playground:smoke"], {}, "pnpm playground:smoke");
  return tail(out, 1);
});

await step("pnpm playground:count on a fresh election", ["pnpm playground:up --experimental"], async () => {
  // A fresh election on budget-2027's channel, as the e2e tests make one, so counting it changes nothing else.
  const channel = playground.electionChannel(playground.ELECTIONS.find((x) => !x.voterOrg));
  const id = `mac-${Date.now().toString(36)}`;
  const seeded = playground.seedElection({ orgs: [{ msp: "Org1MSP" }, { msp: "Org2MSP" }] }, STATE, { id, channel, seed: { title: `Mac check ${id.slice(4)}`, options: ["Plan A", "Plan B", "Plan C"], openForDays: 1 } }, { msp: "Org1MSP" });
  log.write(`\nseedElection ${id} on ${channel}: ${seeded}\n`);
  if (!String(seeded).startsWith("created")) throw new Error(`The playground couldn't create ${id} on ${channel}: ${seeded}`);
  const out = await must("pnpm", ["playground:count", id, "--channel", channel], { timeout: 10 * 60_000 }, `pnpm playground:count ${id} --channel ${channel}`);
  return `${id} on ${channel}: ${tail(out, 4).replace(/\n\s+/g, "; ")}`;
});

await step("Playwright's Chromium is installed", ["The packages are built"], async () => {
  await must("pnpm", ["--filter", "@weftwallet/e2e", "exec", "playwright", "install", "chromium"], { timeout: 20 * 60_000 }, "playwright install chromium");
  return "";
});

await step("The experimental e2e projects, on playground/.state", ["pnpm playground:up --experimental", "Playwright's Chromium is installed"], async () => {
  const projects = ["experimental-setup", "experimental-stack", "voter-credentials-setup", "voter-credentials"].flatMap((p) => ["--project", p]);
  // test:e2e builds the sites and the e2e builds of Weft and Weft Experimental, then runs Playwright with these projects.
  const out = await must("pnpm", ["test:e2e", ...projects], { env: { WEFT_E2E_STACK: "playground" }, timeout: 45 * 60_000 }, "WEFT_E2E_STACK=playground pnpm test:e2e (the experimental projects)");
  const passed = out.match(/(\d+) passed[^\n]*/)?.[0] ?? "";
  const skipped = out.match(/(\d+) skipped/)?.[0];
  return [passed, skipped].filter(Boolean).join(", ");
});

await step(
  "With --https: pnpm playground:up --experimental --https, and the smoke test",
  ["pnpm playground:up --experimental"],
  async () => {
    if (flags.has("--no-https")) return skip("Skipped with --no-https.");
    if (!has("mkcert")) return skip("mkcert isn't installed (brew install mkcert), so the HTTPS round was skipped.");
    await must("pnpm", ["playground:up", "--experimental", "--https"], { timeout: 30 * 60_000 }, "pnpm playground:up --experimental --https");
    const root = spawnSync("mkcert", ["-CAROOT"], { encoding: "utf8" }).stdout.trim();
    const out = await must("pnpm", ["playground:smoke"], { env: { NODE_EXTRA_CA_CERTS: join(root, "rootCA.pem") } }, "pnpm playground:smoke over HTTPS");
    // Back to plain http://localhost, which the checks by hand use.
    await must("pnpm", ["playground:up", "--experimental"], { timeout: 30 * 60_000 }, "pnpm playground:up --experimental, back to HTTP");
    return `${tail(out, 1)}; then back to HTTP`;
  },
  { optional: true },
);

for (const dir of ["contracts/private-ballot", "packages/idemix"]) {
  await step(`go mod download && go mod verify in ${dir}`, [], async () => {
    if (!has("go")) throw new Error("Go isn't on PATH. Install Go (brew install go); any Go from 1.21 downloads the pinned toolchain itself.");
    await must("go", ["mod", "download"], { cwd: join(repo, dir) }, "go mod download");
    const out = await must("go", ["mod", "verify"], { cwd: join(repo, dir) }, "go mod verify");
    return tail(out, 1);
  });
}

await step("pnpm --filter @weftwallet/idemix check:wasm", [], async () => {
  if (!has("go")) throw new Error("Go isn't on PATH. Install Go (brew install go); any Go from 1.21 downloads the pinned toolchain itself.");
  const out = await must("pnpm", ["--filter", "@weftwallet/idemix", "check:wasm"], { timeout: 30 * 60_000 }, "check:wasm");
  const builds = [...out.matchAll(/Build (\d), with an empty build cache, in (\d+) s/g)].map((m) => `build ${m[1]} ${m[2]} s`);
  return `${tail(out, 1)}${builds.length ? ` (${builds.join(", ")})` : ""}`;
});

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

const count = (o) => results.filter((r) => r.outcome === o).length;
say(`\n${bold("Summary")}`);
for (const r of results) {
  const mark = r.outcome === "pass" ? green("PASS") : r.outcome === "fail" ? red("FAIL") : dim("SKIP");
  say(`  ${mark} ${r.name}${r.ms !== undefined ? dim(` ${seconds(r.ms)}`) : ""}`);
}
say(`\n${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped${count("optional") ? `, ${count("optional")} optional not run` : ""}.`);

const running = results.find((r) => r.name === "pnpm playground:up --experimental")?.outcome === "pass";
say(`\n${bold("To look at by hand")}${running ? " (the experimental playground is running)" : " (start the playground with pnpm playground:up --experimental first)"}`);
for (const [i, line] of [
  "Firefox, normal Weft (pnpm --filter @weftwallet/extension dev:firefox): join the playground as alice, vote in the docs playground's election with Keep the receipt in Weft on. Check that the approval window shows the salt Weft generated, that the receipt is kept and listed with the vote in the popup, and that Check it in the explorer opens the explorer's election page with the choice and salt handed over (no typing), and the receipt checks out.",
  "Firefox, Weft Experimental (pnpm --filter @weftwallet/extension dev:firefox:experimental): in Weft Playground's Private election section, copy chair-2027's voter invite, open it from Join from an invite, check the review card names Chair 2027, enrol as a demo voter, and vote in chair-2027 and in budget-2027 (as alice). Each voter enrols once, so use a different voter (voter1 to voter5, secrets voter1pw to voter5pw) in each browser, and run pnpm playground:credentials chair-2027 to list the voters that already hold one. The dev build runs the voting module, so the enrolment and the vote work there as in a built extension. Check the credential's row says Chair 2027, the window's steps and receipt, and that both explorers find each tracking code.",
  "Firefox's console for Weft Experimental (about:debugging, This Firefox, Inspect): the extension's content security policy lets it reach the relay at http://localhost:8787 and the CA proxies at http://localhost:7080 and http://localhost:7081, with no CSP or mixed-content error during enrolment and the vote.",
  "Firefox: the idemix module starts in the approval window and the popup (no wasm-unsafe-eval or worker error), and Check every ballot on chair-2027's explorer page checks every pseudonym in the workers.",
  `Timings to note for prototype-results.md: this run's step times above (playground:up, the ccenv build, the smoke test's per-step times, the e2e projects, check:wasm's two builds) from ${relative(process.cwd(), logPath)}; in Firefox, the popup's enrolment and the window's vote (the weft-voter-* User Timing marks in the window's and the popup's Performance tab), and the full check's "Took" line with the idemix module's start, in Chromium and in Firefox.`,
].entries()) {
  say(`  ${i + 1}. ${line}`);
}
say(`\nLog: ${logPath}`);
log.end(() => process.exit(count("fail") > 0 ? 1 : 0));
