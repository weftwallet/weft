/** The Go test tool: a scratch issuer, and IBM idemix's MSP as a verifier. */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tool = () => {
  const path = process.env.WEFT_IDEMIX_TESTTOOL;
  if (!path) throw new Error("The Go test tool wasn't built.");
  return path;
};

function run<T>(args: string[], input?: unknown): T {
  const out = execFileSync(tool(), args, { input: input === undefined ? "" : JSON.stringify(input), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  return JSON.parse(out) as T;
}

export interface ScratchIssuer {
  dir: string;
  issuerPublicKey: string;
  revocationPublicKey: string;
  nonce: string;
}

export function newIssuer(): ScratchIssuer {
  const dir = mkdtempSync(join(tmpdir(), "weft-idemix-issuer-"));
  return { dir, ...run<Omit<ScratchIssuer, "dir">>(["issuer", dir]) };
}

export function issue(issuer: ScratchIssuer, input: { nonce: string; request: unknown; ou: string; role: number; enrollmentId: string }) {
  return run<{ credential: string; cri: string; revocationHandle: number }>(["issue", issuer.dir], input);
}

/** IBM's MSP, set up as a peer sets it up, on a creator and signature. */
export function verify(input: { mspId: string; issuerPublicKey: string; revocationPublicKey: string; creator: string; message: string; signature: string }) {
  try {
    return { ok: run<{ mspId: string; ou: string; role: string }>(["verify"], input) };
  } catch (error) {
    return { error: String((error as { stderr?: string }).stderr ?? error).trim() };
  }
}

/**
 * The contract's pseudonym verifier, from the contract's own Go package:
 * the proof checked against the Nym in idBytes. Gives P, or the contract's
 * message.
 */
export function verifyPseudonym(input: { issuerPublicKey: string; idBytes: string; channel: string; electionId: string; tracking: string; pseudonymJson: string }) {
  try {
    return { ok: run<{ pseudonym: string }>(["pseudonym"], input) };
  } catch (error) {
    return { error: String((error as { stderr?: string }).stderr ?? error).trim() };
  }
}
