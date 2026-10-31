/**
 * WebAuthn for unlocking Weft with a passkey (docs/adr/0005). Runs in an
 * extension page (not the worker, which has no WebAuthn), with the extension
 * as the relying party. Only passkeys with the PRF extension can unlock,
 * because PRF is what gives a secret to derive a key from.
 */

import { fromBase64Url, toArrayBuffer, toBase64Url } from "@weftwallet/core";
import { ui } from "./messages";

const NO_PRF =
  "This passkey can't unlock Weft. It needs to support the WebAuthn PRF extension, which most phone and laptop passkeys and recent security keys do, and some password managers don't yet.";

function random(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

type PrfResults = { enabled?: boolean; results?: { first?: ArrayBuffer } };

function prfOf(credential: PublicKeyCredential): PrfResults | undefined {
  return (credential.getClientExtensionResults() as { prf?: PrfResults }).prf;
}

/** WebAuthn errors come back as DOMExceptions with browser wording; say what happened instead. */
function explain(error: unknown): Error {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return new Error("The passkey request was cancelled or timed out. Try again.");
  }
  if (error instanceof DOMException && error.name === "InvalidStateError") {
    return new Error("That passkey is already set up for Weft.");
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function evaluate(credentialIds: { id: string; salt: Uint8Array }[]) {
  const evalByCredential = Object.fromEntries(credentialIds.map((c) => [c.id, { first: toArrayBuffer(c.salt) }]));
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: toArrayBuffer(random(32)),
      allowCredentials: credentialIds.map((c) => ({ type: "public-key", id: toArrayBuffer(fromBase64Url(c.id)) })),
      userVerification: "required",
      timeout: 120_000,
      extensions: { prf: { evalByCredential } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error("No passkey was used. Try again, or unlock with your password.");
  const first = prfOf(assertion)?.results?.first;
  if (!first) throw new Error(NO_PRF);
  return { credentialId: assertion.id, prfOutput: new Uint8Array(first) };
}

/** Asks for one of the wallet's passkeys and unlocks with it. */
export async function unlockWithPasskey(): Promise<void> {
  const passkeys = (await ui("passkeyRequest")).map((p) => ({ id: p.id, salt: new Uint8Array(p.salt) }));
  if (passkeys.length === 0) throw new Error("No passkey is set up for Weft.");
  try {
    const { credentialId, prfOutput } = await evaluate(passkeys);
    await ui("passkeyUnlock", { credentialId, prfOutput: Array.from(prfOutput) });
  } catch (error) {
    throw explain(error);
  }
}

/** Creates a passkey for Weft and seals the vault key with it. Weft must be unlocked. */
export async function addPasskey(name: string): Promise<void> {
  const salt = random(32);
  try {
    const credential = (await navigator.credentials.create({
      publicKey: {
        rp: { name: "Weft" },
        user: { id: toArrayBuffer(random(16)), name: "weft", displayName: name || "Weft Wallet" },
        challenge: toArrayBuffer(random(32)),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        timeout: 120_000,
        extensions: { prf: { eval: { first: toArrayBuffer(salt) } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!credential) throw new Error("No passkey was created.");
    const prf = prfOf(credential);
    if (prf?.enabled === false) throw new Error(NO_PRF);
    const id = toBase64Url(new Uint8Array(credential.rawId));
    // Some authenticators only report PRF at creation; others return the value too.
    const prfOutput = prf?.results?.first ? new Uint8Array(prf.results.first) : (await evaluate([{ id, salt }])).prfOutput;
    await ui("passkeyAdd", { credentialId: id, name, salt: Array.from(salt), prfOutput: Array.from(prfOutput) });
  } catch (error) {
    throw explain(error);
  }
}
