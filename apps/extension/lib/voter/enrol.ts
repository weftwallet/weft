/**
 * Weft Experimental only (docs/adr/0008): getting a voter credential from a
 * voter invite, in the popup.
 *
 * The order is what the docs give, so nothing secret is sent before a check
 * that can fail:
 *
 *   1. the store has no credential for this election (the caller checks it
 *      from the popup's state, before asking for host access, which the
 *      browser allows only straight after the press);
 *   2. host access to the voters' CA and the election's relay;
 *   3. GET /api/v1/cainfo, and SHA-256 of its issuer key compared with the
 *      invite's issuerKeyHash;
 *   4. the idemix module started in a dedicated worker of this page, with the
 *      issuer key loaded, and the key that seals the credential derived;
 *   5. the nonce, then the credential request, each POST with the enrolment
 *      ID and secret, which the CA counts as the one enrolment;
 *   6. the credential checked against the issuer key and its attributes;
 *   7. the secrets sealed and the record saved, and the worker terminated.
 *
 * It never asks for an X.509 certificate and never uses token
 * authorisation. Pure apart from what is passed in, so the order and every
 * failure are tested without a browser.
 */
import type { IdemixApi, VoterCredentialSecret } from "@weftwallet/idemix";
import type { VoterInvite } from "@weftwallet/protocol";
import type { SealedText, VoterCredentialRecord, VoterCredentialView } from "./types";

/** What enrolment needs from the page. */
export interface EnrolDeps {
  fetch: typeof fetch;
  /** Starts the module in a worker of this page. terminate ends the worker. */
  startModule(): Promise<IdemixApi & { terminate(): void }>;
  /** The key the record's secrets are sealed under. Throws while Weft is locked. */
  voterKey(): Promise<CryptoKey>;
  seal(key: CryptoKey, id: string, secret: VoterCredentialSecret): Promise<{ secret: SealedText; enrollmentId: SealedText }>;
  /** Saves the record in the background worker, which checks again that it is the only one for its election. */
  save(record: VoterCredentialRecord): Promise<VoterCredentialView>;
  newId(): string;
  now(): number;
  /** Each step as it starts, for the line above the button. */
  onStep?(step: EnrolStep): void;
  /** How long Weft waits for the CA. */
  timeoutMs?: number;
}

export type EnrolStep = "key" | "module" | "credential" | "check";

/** The line above Get a voter credential while each step runs. */
export const STEP_LINES: Record<EnrolStep, string> = {
  key: "Checking the voters' CA's issuer key against the invite.",
  module: "Starting the voting module. It takes about half a second.",
  credential: "Asking the voters' CA for a credential.",
  check: "Checking the credential and sealing it under your vault key.",
};

/**
 * Why enrolment stopped. `spent`: the CA may have counted the voter's one
 * enrolment, so trying again may not help. `pending`: the credential is
 * sealed but couldn't be saved; save it again with saveAgain.
 */
export class EnrolError extends Error {
  override name = "EnrolError";
  constructor(
    readonly reason: "already" | "unreachable" | "keymismatch" | "module" | "locked" | "refused" | "second" | "badcred" | "save",
    message: string,
    readonly detail?: string,
    readonly pending?: VoterCredentialRecord,
  ) {
    super(message);
  }
}

const shortHex = (v: string) => (v.length <= 17 ? v : `${v.slice(0, 8)}…${v.slice(-8)}`);
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Fabric CA's answer shape. */
interface CaAnswer<T> {
  success?: boolean;
  result?: T;
  errors?: { code?: number; message?: string }[];
}

/** The message Weft shows when it already holds a credential for the election. */
export function alreadyHeld(electionId: string, addedAt: number): EnrolError {
  const added = new Date(addedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  return new EnrolError(
    "already",
    `Weft already holds a voter credential for ${electionId}. It keeps one per election, and nothing was sent to the voters' CA.`,
    `The credential was added on ${added}. Remove it first only if you mean to enrol again, and the CA accepts each enrolment once.`,
  );
}

/**
 * Steps 3 to 7. The caller has done steps 1 and 2. Returns the saved
 * credential's view, or throws EnrolError.
 */
export async function enrol(
  invite: VoterInvite,
  inviteUrl: string,
  enrollmentId: string,
  secret: string,
  deps: EnrolDeps,
): Promise<VoterCredentialView> {
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const caHost = hostOf(invite.caUrl);
  const caName = invite.caName ? `?ca=${encodeURIComponent(invite.caName)}` : "";
  const infoUrl = `${invite.caUrl}/api/v1/cainfo${caName}`;
  const credentialUrl = `${invite.caUrl}/api/v1/idemix/credential`;
  const unreachable = (url: string, method: string, error: unknown) =>
    new EnrolError(
      "unreachable",
      `Weft couldn't reach the voters' CA at ${caHost}, so nothing was enrolled. Check that it's running, then press Get a voter credential again.`,
      error instanceof Error && error.name === "TimeoutError" ? `${method} ${url}: no answer within ${timeoutMs / 1000} seconds.` : `${method} ${url}: ${String(error)}`,
    );

  // 3. The issuer key, before anything secret is sent.
  deps.onStep?.("key");
  let info: CaAnswer<{ IssuerPublicKey?: string; IssuerRevocationPublicKey?: string; CAName?: string }>;
  try {
    const response = await deps.fetch(infoUrl, { signal: AbortSignal.timeout(timeoutMs) });
    info = (await response.json()) as typeof info;
  } catch (error) {
    throw unreachable(infoUrl, "GET", error);
  }
  const issuerPublicKey = info.result?.IssuerPublicKey;
  if (!info.success || !issuerPublicKey) {
    throw new EnrolError(
      "unreachable",
      `The voters' CA at ${caHost} didn't send its issuer key, so nothing was enrolled. Ask the election's organisers to check the CA.`,
      `GET ${infoUrl} answered without an IssuerPublicKey${info.errors?.[0]?.message ? `: ${info.errors[0].message}` : ""}.`,
    );
  }
  let served: string;
  try {
    served = await sha256Hex(fromBase64(issuerPublicKey));
  } catch {
    served = "an issuer key that isn't base64";
  }
  if (served !== invite.issuerKeyHash) {
    throw new EnrolError(
      "keymismatch",
      "The voters' CA has a different issuer key from the invite's. Ask the election's organisers. Weft asked the CA only for its public details, and enrolled nothing.",
      `The invite names issuer key ${shortHex(invite.issuerKeyHash)}. ${invite.caName ?? "The CA"} at ${caHost} serves ${shortHex(served)}.`,
    );
  }

  // 4. The module, and the sealing key, before the secret is sent.
  deps.onStep?.("module");
  let module: IdemixApi & { terminate(): void };
  try {
    module = await deps.startModule();
  } catch (error) {
    throw moduleError(error);
  }
  try {
    try {
      const loaded = await module.loadIssuerKey(issuerPublicKey);
      if (loaded.issuerKeyHash !== invite.issuerKeyHash) throw new Error(`The module read the issuer key's hash as ${loaded.issuerKeyHash}.`);
    } catch (error) {
      throw moduleError(error);
    }
    let key: CryptoKey;
    try {
      key = await deps.voterKey();
    } catch (error) {
      throw new EnrolError("locked", "Weft locked before it could enrol, so nothing was sent to the voters' CA. Unlock Weft and press Get a voter credential again.", error instanceof Error ? error.message : String(error));
    }

    // 5. The nonce, then the request. From here the CA may count the enrolment.
    deps.onStep?.("credential");
    const authorization = `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${enrollmentId}:${secret}`)))}`;
    const post = async <T>(body: unknown): Promise<{ status: number; answer: CaAnswer<T> }> => {
      let response: Response;
      try {
        response = await deps.fetch(credentialUrl, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw unreachable(credentialUrl, "POST", error);
      }
      const answer = (await response.json().catch(() => ({}))) as CaAnswer<T>;
      return { status: response.status, answer };
    };
    const caname = invite.caName ? { caname: invite.caName } : {};
    const first = await post<{ Nonce?: string }>({ ...caname });
    if (!first.answer.success || !first.answer.result?.Nonce) {
      const e = first.answer.errors?.[0];
      const said = `POST ${credentialUrl} answered ${first.status}.${e ? ` Code ${e.code ?? "none"}: ${e.message ?? "no message"}.` : ""}`;
      if (first.status === 401 || e?.code === 20) {
        throw new EnrolError(
          "second",
          "The voters' CA refused this enrolment ID and secret. It accepts each one once, so if you enrolled before, in this browser or another, that credential is the only one. If you didn't, ask the election's organisers.",
          said,
        );
      }
      throw new EnrolError("refused", `The voters' CA at ${caHost} refused to start the enrolment, so Weft saved nothing. Ask the election's organisers what it said.`, said);
    }
    const request = await module.credentialRequest(first.answer.result.Nonce).catch((error: unknown) => {
      throw new EnrolError(
        "module",
        "Weft Experimental's voting module failed before Weft sent the credential request, so the voters' CA issued nothing. Reload Weft Experimental from the browser's extensions page and try again.",
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
    });
    const second = await post<{ Credential?: string; CRI?: string; Attrs?: { OU?: string; Role?: number; EnrollmentID?: string } }>({ request: request.request, ...caname });
    const issued = second.answer.result;
    if (!second.answer.success || !issued?.Credential) {
      const e = second.answer.errors?.[0];
      throw new EnrolError(
        "refused",
        "The voters' CA refused the credential request, so Weft saved nothing. It may have counted your one enrolment, so ask the election's organisers before you try again.",
        `POST ${credentialUrl} answered ${second.status}.${e ? ` Code ${e.code ?? "none"}: ${e.message ?? "no message"}.` : ""}`,
      );
    }

    // 6. The credential, against the issuer key and the attributes it must carry.
    deps.onStep?.("check");
    const attrs = issued.Attrs ?? {};
    const credential: VoterCredentialSecret = {
      secretKey: request.secretKey,
      credential: issued.Credential,
      cri: issued.CRI ?? "",
      ou: attrs.OU ?? "",
      role: attrs.Role ?? 0,
      enrollmentId: attrs.EnrollmentID ?? "",
    };
    const bad = (why: string) =>
      new EnrolError(
        "badcred",
        "The voters' CA sent a credential that doesn't check out against its own issuer key, so Weft didn't save it. The CA has counted your one enrolment, so ask the organisers to register you again.",
        `${why} Attributes: OU ${credential.ou || "none"}, role ${credential.role}, enrolment ID ${credential.enrollmentId || "none"}.`,
      );
    try {
      await module.checkCredential(credential);
    } catch (error) {
      throw bad(`The credential's signature doesn't verify under ${invite.caName ?? "the CA"}'s issuer key: ${error instanceof Error ? error.message : String(error)}.`);
    }
    if (credential.ou !== invite.affiliation) throw bad(`Its affiliation isn't ${invite.affiliation}, the one the invite names.`);
    if (credential.role !== 1) throw bad("Its role isn't member.");
    if (credential.enrollmentId !== enrollmentId) throw bad(`Its enrolment ID isn't ${enrollmentId}.`);

    // 7. Sealed, then saved.
    const id = deps.newId();
    const record: VoterCredentialRecord = {
      id,
      invite,
      inviteUrl,
      issuerPublicKey,
      revocationPublicKey: info.result?.IssuerRevocationPublicKey ?? null,
      affiliation: credential.ou,
      role: "member",
      title: null,
      sealed: await deps.seal(key, id, credential),
      createdAt: deps.now(),
    };
    return await saveRecord(record, deps);
  } finally {
    module.terminate();
  }
}

/** Saves a sealed record, as the last step or again after the browser refused it. */
export async function saveRecord(record: VoterCredentialRecord, deps: Pick<EnrolDeps, "save">): Promise<VoterCredentialView> {
  try {
    return await deps.save(record);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Weft already holds")) throw new EnrolError("already", message);
    throw new EnrolError(
      "save",
      "Weft couldn't save the voter credential. The voters' CA has counted your enrolment, so keep this popup open and press Save the credential.",
      message,
      record,
    );
  }
}

function moduleError(error: unknown): EnrolError {
  if (error instanceof EnrolError) return error;
  return new EnrolError(
    "module",
    "Weft Experimental couldn't start its voting module, so nothing was sent to the voters' CA. Reload Weft Experimental from the browser's extensions page and try again.",
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  );
}
