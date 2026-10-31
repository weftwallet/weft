/**
 * A minimal Fabric CA client: enrol and re-enrol over the CA's REST API.
 * Runs in the extension's background worker, which has host permission for
 * the CA, so CORS on the CA does not matter.
 */

import { fromBase64, toBase64, utf8 } from "./bytes.ts";
import { createCsr } from "./certificate.ts";
import { signForFabric, type KeyPair } from "./signing.ts";

export interface FabricCaResult {
  /** PEM certificate issued for the CSR. */
  certificate: string;
  /** PEM chain of the issuing CA, when the server returns it. */
  caChain: string | null;
  caName: string | null;
}

/**
 * A CA request that failed. The message says what happened in plain words;
 * `detail` keeps what the CA itself said, for "Details".
 */
export class FabricCaError extends Error {
  readonly status: number;
  readonly errors: { code: number; message: string }[];
  readonly detail: string;

  constructor(status: number, errors: { code: number; message: string }[], message?: string) {
    const raw = errors.map((e) => (e.code ? `${e.code}: ${e.message}` : e.message)).join("; ");
    super(message ?? explainCaErrors(status, errors));
    this.name = "FabricCaError";
    this.status = status;
    this.errors = errors;
    this.detail = raw || `HTTP ${status}`;
  }
}

/** Fabric CA's messages are written for its operators; these are for the person enrolling. */
function explainCaErrors(status: number, errors: { code: number; message: string }[]): string {
  const text = errors.map((e) => e.message).join(" ").toLowerCase();
  if (errors.some((e) => e.code === 20) || status === 401 || text.includes("authentication failure")) {
    return "The CA didn't accept that enrolment ID and secret. Check them with your administrator. A secret usually works only once.";
  }
  if (text.includes("max") && text.includes("enroll")) {
    return "This enrolment ID has been used as many times as the CA allows. Ask your administrator for a new secret.";
  }
  if (text.includes("revoked")) {
    return "The CA has revoked this identity. Ask your administrator.";
  }
  if (text.includes("not found") || text.includes("not registered") || text.includes("unknown identity")) {
    return "The CA doesn't know this enrolment ID. Check it with your administrator.";
  }
  if (text.includes("ca") && text.includes("does not exist")) {
    return "The CA server doesn't host a CA with that name. Check the CA name in the network's settings.";
  }
  return "The CA refused the request. If it keeps happening, show the details to your administrator.";
}

/** How long Weft waits for the CA before saying it didn't answer. */
const CA_TIMEOUT_MS = 15_000;

interface CaResponse {
  success: boolean;
  result?: { Cert?: string; ServerInfo?: { CAName?: string; CAChain?: string } };
  errors?: { code: number; message: string }[];
}

const decoder = new TextDecoder();

export interface FabricCaClientOptions {
  /** for example "https://ca.org1.example.com:7054" */
  url: string;
  /** Needed when one server hosts several CAs. */
  caName?: string;
  fetch?: typeof fetch;
}

export class FabricCaClient {
  private readonly url: string;
  private readonly caName: string | undefined;
  private readonly fetch: typeof fetch;

  constructor(options: FabricCaClientOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.caName = options.caName;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Enrols with an enrollment ID and secret issued by the organisation's
   * registrar. Generates the CSR from the given key pair; the private key
   * never leaves this process.
   */
  async enroll(enrollmentId: string, secret: string, keys: KeyPair): Promise<FabricCaResult> {
    const body = this.body(await createCsr(keys, enrollmentId));
    const auth = `Basic ${btoa(`${enrollmentId}:${secret}`)}`;
    return this.post("/api/v1/enroll", body, auth);
  }

  /**
   * Re-enrols an existing identity to get a fresh certificate, authenticated
   * with a token signed by the current key. `newKeys` may be the same pair
   * (renew) or a new one (rotate).
   */
  async reenroll(
    current: { certificate: string; privateKey: CryptoKey },
    newKeys: KeyPair,
    commonName: string,
  ): Promise<FabricCaResult> {
    const path = "/api/v1/reenroll";
    const body = this.body(await createCsr(newKeys, commonName));
    const token = await createAuthToken({ ...current, method: "POST", path, body });
    return this.post(path, body, token);
  }

  private body(csr: string): Record<string, string> {
    return this.caName ? { certificate_request: csr, caname: this.caName } : { certificate_request: csr };
  }

  private async post(path: string, body: unknown, authorization: string): Promise<FabricCaResult> {
    let response: Response;
    try {
      response = await this.fetch(`${this.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CA_TIMEOUT_MS),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "TimeoutError") {
        throw new FabricCaError(
          0,
          [{ code: 0, message: `No answer from ${this.url}${path} within ${CA_TIMEOUT_MS / 1000} seconds.` }],
          `The CA at ${this.url} didn't answer within ${CA_TIMEOUT_MS / 1000} seconds. Check it's running, then try again.`,
        );
      }
      // Browsers report TLS and connection failures only as "Failed to fetch".
      throw new FabricCaError(
        0,
        [{ code: 0, message: `${this.url}${path}: ${String(cause)}` }],
        `Couldn't reach the CA at ${this.url}. Check it's running, and that its HTTPS certificate is one this ` +
          "computer trusts: browsers refuse self-signed CA certificates.",
      );
    }
    let json: CaResponse;
    try {
      json = (await response.json()) as CaResponse;
    } catch {
      throw new FabricCaError(
        response.status,
        [{ code: 0, message: `${this.url}${path} returned HTTP ${response.status} without a Fabric CA answer.` }],
        `The address ${this.url} answered, but not with a Fabric CA response. Check the CA address in the network's settings.`,
      );
    }
    if (!response.ok || !json.success || !json.result?.Cert) {
      throw new FabricCaError(response.status, json.errors ?? []);
    }
    const chain = json.result.ServerInfo?.CAChain;
    return {
      certificate: decoder.decode(fromBase64(json.result.Cert)),
      caChain: chain ? decoder.decode(fromBase64(chain)) : null,
      caName: json.result.ServerInfo?.CAName ?? null,
    };
  }
}

/**
 * Builds a Fabric CA token: base64(cert) "." base64(signature), where the
 * signature covers METHOD.b64(path).b64(body).b64(cert). Matches
 * fabric-ca-client's generateAuthToken.
 */
export async function createAuthToken(input: {
  certificate: string;
  privateKey: CryptoKey;
  method: string;
  path: string;
  body: unknown;
}): Promise<string> {
  const cert = toBase64(utf8(input.certificate));
  const body = input.body === undefined ? "" : toBase64(utf8(JSON.stringify(input.body)));
  const message = `${input.method}.${toBase64(utf8(input.path))}.${body}.${cert}`;
  const signature = await signForFabric(input.privateKey, utf8(message));
  return `${cert}.${toBase64(signature)}`;
}
