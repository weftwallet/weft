#!/usr/bin/env node
/**
 * The normal build carries none of Weft Experimental's code (docs/adr/0009):
 * none of its names, the ballot window and handler, @weftwallet/tally with
 * noble's ristretto255, the voter credentials' module and its worker, no
 * WebAssembly file and no content security policy of its own. The one
 * sentence allowed is D11's, which tells a voter what a voter invite is, and
 * it must be there once.
 *
 *   pnpm --filter @weftwallet/extension check:normal [build folder ...]
 *
 * Without folders, it checks .output/chrome-mv3 and .output/firefox-mv3,
 * which `pnpm --filter @weftwallet/extension build` and `build -b firefox`
 * make. The e2e tests (e2e/tests/experimental.spec.ts) run the same check on
 * the e2e build.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPERIMENTAL_MARKS =
  /Weft Experimental|castBallot|voterCredentials|experimental@weft|ballotRead|Sign and vote|ballot-option|weft-ballot-v1|weft-election-fingerprint|ristretto255|weftIdemix|weft-idemix|wasm-unsafe-eval|Get a voter credential/;

/** What normal Weft says for a voter invite (D11 of step 5), its one sentence that names Weft Experimental. */
export const VOTER_INVITE_MESSAGE =
  "This is a voter invite for an election, and only Weft Experimental can hold voter credentials. Nothing was sent to the CA. Open the invite in Weft Experimental.";

/** Every text file in a build, with its path. */
function files(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(js|html|json|css)$/.test(e.name))
    .map((e) => ({ path: join(e.parentPath, e.name), text: readFileSync(join(e.parentPath, e.name), "utf8") }));
}

/** What in a normal build is Weft Experimental's: an empty list when there is nothing. */
export function experimentalTraces(dir) {
  const all = files(dir);
  const problems = [];
  for (const f of all) {
    const m = f.text.replaceAll(VOTER_INVITE_MESSAGE, "").match(EXPERIMENTAL_MARKS);
    if (m) problems.push(`${relative(dir, f.path)} has "${m[0]}".`);
  }
  const said = all.filter((f) => f.text.includes(VOTER_INVITE_MESSAGE)).length;
  if (said !== 1) problems.push(`The voter invite's sentence is in ${said} files, not 1.`);
  for (const f of readdirSync(dir, { recursive: true })) if (String(f).endsWith(".wasm")) problems.push(`${f} is a WebAssembly file.`);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (manifest.content_security_policy !== undefined) problems.push("manifest.json has a content_security_policy.");
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dirs = process.argv.slice(2).length ? process.argv.slice(2) : [join(root, ".output", "chrome-mv3"), join(root, ".output", "firefox-mv3")];
  let failed = false;
  for (const dir of dirs) {
    if (!existsSync(join(dir, "manifest.json"))) {
      console.error(`✗ ${dir} has no build. Run pnpm --filter @weftwallet/extension build (and build -b firefox) first.`);
      failed = true;
      continue;
    }
    const problems = experimentalTraces(dir);
    if (problems.length) {
      failed = true;
      console.error(`✗ ${relative(process.cwd(), dir)} carries Weft Experimental's code:\n  ${problems.join("\n  ")}`);
    } else console.log(`✓ ${relative(process.cwd(), dir)} carries none of Weft Experimental's code.`);
  }
  process.exit(failed ? 1 : 0);
}
