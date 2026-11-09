/**
 * Stops a script that runs on a Node other than the one in .nvmrc, before it
 * does anything. Weft is built and tested on that Node only (CI reads
 * .nvmrc), and tools such as Playwright's browser install can stall on a
 * newer one without saying why.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..");

export function requirePinnedNode() {
  const pinned = readFileSync(join(repo, ".nvmrc"), "utf8").trim().replace(/^v/, "");
  const major = process.versions.node.split(".")[0];
  if (major === pinned.split(".")[0]) return;
  console.error(
    `This is Node ${process.versions.node}, and Weft needs Node ${pinned} (.nvmrc).\n` +
      "Run fnm use or nvm use in the repository, or open a new terminal there if your shell switches on cd, then run this again.",
  );
  process.exit(1);
}
