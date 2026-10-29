import type { OrgInvite } from "@weftwallet/protocol";

export class InviteError extends Error {
  /** What went wrong underneath, for "Details". */
  readonly detail: string | undefined;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "InviteError";
    this.detail = detail;
  }
}

/**
 * Turns whatever the user pasted or scanned into the HTTPS URL of an invite.
 * Accepts `weft://invite?u=<url>`, `https://…/?weft-invite=<url>`, or a bare
 * HTTPS URL.
 */
export function resolveInviteUrl(input: string): string {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new InviteError("That doesn't look like an invite link.");
  }
  if (url.protocol === "weft:") {
    const target = url.searchParams.get("u");
    if (!target) throw new InviteError("The invite link is missing its address.");
    return requireHttps(target);
  }
  const embedded = url.searchParams.get("weft-invite");
  if (embedded) return requireHttps(embedded);
  return requireHttps(text);
}

function requireHttps(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InviteError("The invite address is not a valid URL.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new InviteError("Invites must be served over HTTPS.");
  }
  return url.toString();
}

function isUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Validates an invite document and returns it typed, or throws InviteError. */
export function parseInvite(json: unknown): OrgInvite {
  if (typeof json !== "object" || json === null) throw new InviteError("The invite is not a JSON object.");
  const o = json as Record<string, unknown>;
  const problems: string[] = [];
  if (o.weft !== 1) problems.push('"weft" must be 1');
  for (const key of ["network", "organization", "mspId"] as const) {
    if (typeof o[key] !== "string" || !(o[key] as string).trim()) problems.push(`"${key}" is required`);
  }
  if (!isUrl(o.caUrl)) problems.push('"caUrl" must be a URL');
  if (!isUrl(o.relayUrl)) problems.push('"relayUrl" must be a URL');
  if (!Array.isArray(o.channels) || o.channels.length === 0 || !o.channels.every((c) => typeof c === "string")) {
    problems.push('"channels" must be a non-empty list of names');
  }
  if (o.caName !== undefined && typeof o.caName !== "string") problems.push('"caName" must be a string');
  if (o.enrollmentId !== undefined && typeof o.enrollmentId !== "string") {
    problems.push('"enrollmentId" must be a string');
  }
  if (o.explorerUrl !== undefined && !isUrl(o.explorerUrl)) problems.push('"explorerUrl" must be a URL');
  if (problems.length) throw new InviteError(`This invite is not valid: ${problems.join(", ")}.`);
  return {
    weft: 1,
    network: o.network as string,
    organization: o.organization as string,
    mspId: o.mspId as string,
    caUrl: (o.caUrl as string).replace(/\/+$/, ""),
    ...(o.caName ? { caName: o.caName as string } : {}),
    relayUrl: (o.relayUrl as string).replace(/\/+$/, ""),
    channels: o.channels as string[],
    ...(o.enrollmentId ? { enrollmentId: o.enrollmentId as string } : {}),
    ...(o.explorerUrl ? { explorerUrl: (o.explorerUrl as string).replace(/\/+$/, "") } : {}),
  };
}

export async function fetchInvite(input: string, fetchImpl: typeof fetch = fetch): Promise<OrgInvite> {
  const url = resolveInviteUrl(input);
  const host = new URL(url).host;
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(INVITE_TIMEOUT_MS) });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "TimeoutError") {
      throw new InviteError(
        `The invite server at ${host} didn't answer within ${INVITE_TIMEOUT_MS / 1000} seconds. Try again, or ask your administrator to check it's running.`,
        `No answer from ${url}.`,
      );
    }
    throw new InviteError(
      `Couldn't load the invite from ${host}. Check the link, or ask your administrator to check the invite server is running.`,
      `${url}: ${String(cause)}`,
    );
  }
  if (!response.ok) {
    throw new InviteError(
      response.status === 404 || response.status === 410
        ? "This invite link no longer works. Ask your administrator for a new one."
        : `The invite server at ${host} returned an error. Try again shortly.`,
      `${url} returned HTTP ${response.status}.`,
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new InviteError("This link doesn't lead to a Weft invite. Check you copied the whole link.", `${url} didn't return JSON.`);
  }
  try {
    return parseInvite(json);
  } catch (error) {
    if (!(error instanceof InviteError)) throw error;
    throw new InviteError("This invite has mistakes in it, so Weft can't use it. Ask your administrator for a new one.", error.message);
  }
}

/** How long Weft waits for an invite server. */
const INVITE_TIMEOUT_MS = 15_000;
