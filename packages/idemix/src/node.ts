/**
 * Starts the idemix module in a Node process, for tests and the explorer's
 * indexer, which checks anonymous ballots with sync's verifyIdentity and
 * verifyPseudonym as it reads each block. It reads the module and wasm_exec.js from dist/wasm,
 * or from dir, and refuses either if its SHA-256 isn't the pinned one.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IdemixError, sha256Hex, startModule, type IdemixApi, type IdemixSync, type StartTimings } from "./module.ts";
import { PINNED } from "./pinned.ts";

export const DIST_WASM = fileURLToPath(new URL("../dist/wasm/", import.meta.url));

export async function startIdemixNode(dir: string = DIST_WASM): Promise<{ api: IdemixApi; sync: IdemixSync; timings: StartTimings & { read: number } }> {
  const execPath = join(dir, "wasm_exec.js");
  if ((await sha256Hex(await readFile(execPath))) !== PINNED.wasmExecSha256) {
    throw new IdemixError(`${execPath} isn't the wasm_exec.js pinned with the idemix module.`);
  }
  await import(pathToFileURL(execPath).href);
  const t = performance.now();
  const bytes = new Uint8Array(await readFile(join(dir, "weft-idemix.wasm")));
  const read = performance.now() - t;
  const { api, sync, timings } = await startModule(bytes);
  return { api, sync, timings: { ...timings, read } };
}
