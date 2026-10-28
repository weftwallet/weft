/**
 * Sign-in with Weft (docs/adr/0004, phase 2).
 *
 * 1. The page asks for a nonce, then calls weft_signIn with it.
 * 2. The wallet signs a message it writes itself: origin, MSP ID, nonce, times.
 * 3. The server checks the message, the signature, and that the certificate
 *    chains to the root certificates of that MSP in a channel's configuration,
 *    then sets a session cookie.
 *
 * A signed-in viewer is a member of every indexed channel whose configuration
 * lists their MSP, and sees that channel's `members` level.
 *
 * The network page signs in once for every organisation's explorer. Its
 * sign-in names the network page's origin and a nonce the page chose, so each
 * explorer accepts a nonce once, and only for a short-lived message. It gets
 * a bearer token back, not a cookie, since it calls from another origin.
 */

import { createHmac, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { SignInError, fromBase64, parseSignInMessage, verifySignIn } from "@weftwallet/core";
import type { ChannelMember } from "./decode.ts";

export interface Viewer {
  mspId: string;
  name: string | null;
  /** Session expiry, ms since the epoch. */
  expires: number;
}

export const SESSION_COOKIE = "weft_session";
const SESSION_MS = 8 * 60 * 60_000;
/** The network page's session at each explorer. */
const NETWORK_SESSION_MS = 60 * 60_000;
/** Longest a page-chosen nonce's message may be valid for. */
const CHOSEN_NONCE_MS = 15 * 60_000;
const NONCE_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 60_000;

const b64url = (b: Buffer) => b.toString("base64url");

/** Whether `certificatePem` chains to one of the member's root certificates, and every link is in date. */
export function chainsTo(certificatePem: string, member: ChannelMember, now = Date.now()): boolean {
  let current: X509Certificate;
  try {
    current = new X509Certificate(certificatePem);
  } catch {
    return false;
  }
  const inDate = (c: X509Certificate) => Date.parse(c.validFrom) <= now && now <= Date.parse(c.validTo);
  const roots = member.rootCerts.map((p) => new X509Certificate(p));
  const pool = [...member.intermediateCerts.map((p) => new X509Certificate(p)), ...roots];
  for (let depth = 0; depth < 6; depth++) {
    if (!inDate(current)) return false;
    const issuer = pool.find((c) => current.checkIssued(c) && current.verify(c.publicKey));
    if (!issuer) return false;
    if (roots.some((r) => r.raw.equals(issuer.raw))) return inDate(issuer);
    current = issuer;
  }
  return false;
}

export class Auth {
  private readonly secret: Buffer;
  private readonly nonces = new Map<string, number>();
  /** Page-chosen nonces already used, until their message expires. */
  private readonly used = new Map<string, number>();

  constructor(secret?: string) {
    this.secret = secret ? Buffer.from(secret, "utf8") : randomBytes(32);
  }

  nonce(): string {
    const now = Date.now();
    if (this.nonces.size > 10_000) {
      for (const [n, expires] of this.nonces) if (expires < now) this.nonces.delete(n);
    }
    const nonce = b64url(randomBytes(24));
    this.nonces.set(nonce, now + NONCE_MS);
    return nonce;
  }

  /**
   * Checks a weft_signIn result. `membersOf(mspId)` gives that MSP's entries
   * from the channels' configurations. Throws SignInError with a reason.
   */
  async verify(
    body: { message?: unknown; signature?: unknown; certificate?: unknown },
    expectedOrigin: string,
    membersOf: (mspId: string) => ChannelMember[],
    now = Date.now(),
    nonces: "issued" | "chosen" = "issued",
  ): Promise<Viewer> {
    if (typeof body.message !== "string" || typeof body.signature !== "string" || typeof body.certificate !== "string") {
      throw new SignInError("Send message, signature and certificate.");
    }
    const fields = parseSignInMessage(body.message);
    if (fields.origin !== expectedOrigin) throw new SignInError("This sign-in was made for another site.");
    if (nonces === "issued") {
      const issued = this.nonces.get(fields.nonce);
      if (issued === undefined || issued < now) throw new SignInError("This sign-in has expired or was already used. Try again.");
      this.nonces.delete(fields.nonce); // one use, whatever happens next
    } else {
      if (fields.expiresAt.getTime() - fields.issuedAt.getTime() > CHOSEN_NONCE_MS) {
        throw new SignInError("This sign-in is valid for too long. Try again.");
      }
      for (const [n, until] of this.used) if (until < now) this.used.delete(n);
      if (this.used.has(fields.nonce)) throw new SignInError("This sign-in was already used. Try again.");
      this.used.set(fields.nonce, fields.expiresAt.getTime() + CLOCK_SKEW_MS);
    }
    if (fields.issuedAt.getTime() > now + CLOCK_SKEW_MS || fields.expiresAt.getTime() < now - CLOCK_SKEW_MS) {
      throw new SignInError("This sign-in has expired. Try again.");
    }
    let signature: Uint8Array;
    try {
      signature = fromBase64(body.signature);
    } catch {
      throw new SignInError("The signature isn't valid base64.");
    }
    if (!(await verifySignIn(body.message, signature, body.certificate))) {
      throw new SignInError("The signature doesn't match the certificate.");
    }
    const entries = membersOf(fields.mspId);
    if (entries.length === 0) throw new SignInError(`${fields.mspId} isn't a member of any channel published here.`);
    if (!entries.some((m) => chainsTo(body.certificate as string, m, now))) {
      throw new SignInError(`This certificate wasn't issued by ${fields.mspId}'s CA, or it has expired.`);
    }
    const subject = new X509Certificate(body.certificate).subject;
    const name = /(?:^|\n)CN=([^\n]+)/.exec(subject)?.[1] ?? null;
    return { mspId: fields.mspId, name, expires: now + (nonces === "chosen" ? NETWORK_SESSION_MS : SESSION_MS) };
  }

  /** A bearer token, for the network page. The same signed form as the cookie. */
  token(viewer: Viewer): string {
    return this.cookie(viewer);
  }

  /** The viewer from an "Authorization: Bearer" header, if it's valid. */
  readBearer(authorization: string | undefined, now = Date.now()): Viewer | null {
    const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? "")?.[1];
    return token ? this.read(`${SESSION_COOKIE}=${token}`, now) : null;
  }

  cookie(viewer: Viewer): string {
    const payload = b64url(Buffer.from(JSON.stringify(viewer)));
    const mac = b64url(createHmac("sha256", this.secret).update(payload).digest());
    return `${payload}.${mac}`;
  }

  read(cookieHeader: string | undefined, now = Date.now()): Viewer | null {
    const raw = cookieHeader
      ?.split(/;\s*/)
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    if (!raw) return null;
    const [payload, mac] = raw.split(".");
    if (!payload || !mac) return null;
    const expected = createHmac("sha256", this.secret).update(payload).digest();
    const given = Buffer.from(mac, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const viewer = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Viewer;
      return viewer.expires > now ? viewer : null;
    } catch {
      return null;
    }
  }
}
