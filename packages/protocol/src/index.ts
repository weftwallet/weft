/**
 * @weftwallet/protocol
 *
 * The contract between a dApp and the Weft wallet. The extension injects an
 * object implementing `WeftProvider` at `window.weft`. Everything that crosses
 * that boundary is described here, so the extension, the SDK and the docs agree.
 */

export const PROVIDER_VERSION = "0.1.0";

/* ------------------------------------------------------------------ */
/* Identities and networks                                             */
/* ------------------------------------------------------------------ */

/** Public details of an identity. Never includes key material. */
export interface IdentitySummary {
  /** Stable local ID for this identity in the wallet. */
  id: string;
  /** The certificate's common name, e.g. "appUser". */
  name: string;
  /** Membership service provider ID, e.g. "Org1MSP". */
  mspId: string;
  /** NodeOU role taken from the certificate's OU, e.g. "client" or "admin". */
  role: string | null;
  /** Fabric CA attributes embedded in the certificate (hf.* and custom). */
  attributes: Record<string, string>;
  /** Subject DN of the issuing CA. */
  issuer: string;
  /** ISO 8601 timestamp. */
  notAfter: string;
  /** SHA-256 fingerprint of the certificate, colon-separated hex. */
  fingerprint: string;
  /** PEM-encoded X.509 certificate. Public, safe to share. */
  certificate: string;
}

export interface NetworkSummary {
  /** Stable local ID, usually derived from the org invite. */
  id: string;
  /** Display name, e.g. "Acme Supply Network". */
  name: string;
  mspId: string;
  channels: string[];
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

/** A call to a smart contract (chaincode) function. */
export interface ContractCall {
  /** Channel name, e.g. "mychannel". */
  channel: string;
  /** Chaincode name, e.g. "basic". */
  chaincode: string;
  /**
   * Optional contract name inside the chaincode, for chaincode built with
   * the Fabric contract API that exposes more than one contract.
   */
  contract?: string;
  /** Function name, e.g. "TransferAsset". */
  fn: string;
  /** String arguments, in order. */
  args?: string[];
  /** Transient data (private data inputs). Never written to the ledger. */
  transient?: Record<string, string>;
  /** Restrict endorsement to these MSP IDs. */
  endorsingOrganizations?: string[];
}

export interface EvaluateResult {
  /** UTF-8 decoded result, if the bytes are valid UTF-8. */
  text: string | null;
  /** Base64 of the raw result bytes. */
  base64: string;
}

/** Params for weft_addNetwork: where the organisation's invite lives. */
export interface AddNetworkParams {
  /** HTTPS URL of the invite JSON, a weft:// link, or a join-page link. */
  url: string;
}

export interface AddNetworkResult {
  /** True once the user has enrolled and the network is in their wallet. */
  added: true;
}

export interface SubmitResult extends EvaluateResult {
  transactionId: string;
  blockNumber: string;
  /** Fabric validation code name, e.g. "VALID". */
  status: string;
}

/** Every method the provider accepts, with its params and result types. */
export interface WeftMethods {
  weft_connect: { params: undefined; result: IdentitySummary };
  weft_identity: { params: undefined; result: IdentitySummary | null };
  weft_networks: { params: undefined; result: NetworkSummary[] };
  weft_evaluate: { params: ContractCall; result: EvaluateResult };
  weft_submit: { params: ContractCall; result: SubmitResult };
  weft_addNetwork: { params: AddNetworkParams; result: AddNetworkResult };
  /** Disconnects this site. It must call weft_connect again to use the wallet. */
  weft_disconnect: { params: undefined; result: null };
}

export type WeftMethod = keyof WeftMethods;

export type RequestArgs<M extends WeftMethod = WeftMethod> = WeftMethods[M]["params"] extends undefined
  ? { method: M; params?: undefined }
  : { method: M; params: WeftMethods[M]["params"] };

export const METHODS: readonly WeftMethod[] = [
  "weft_connect",
  "weft_identity",
  "weft_networks",
  "weft_evaluate",
  "weft_submit",
  "weft_addNetwork",
  "weft_disconnect",
] as const;

/** Methods that always show the user an approval screen. */
export const APPROVAL_METHODS: ReadonlySet<WeftMethod> = new Set([
  "weft_connect",
  "weft_evaluate",
  "weft_submit",
  "weft_addNetwork",
]);

export function isWeftMethod(value: unknown): value is WeftMethod {
  return typeof value === "string" && (METHODS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

/** Why a site was disconnected. */
export type DisconnectReason =
  /** The user disconnected the site in Weft. */
  | "user"
  /** The site called weft_disconnect (possibly from another tab). */
  | "site"
  /** The user removed their last identity. */
  | "no-identity"
  /**
   * Weft was updated or reloaded while this page was open. The page must
   * reload to use Weft again.
   */
  | "wallet-updated";

export interface WeftEvents {
  /** The user switched, renewed or removed the active identity. Sent to connected sites. */
  identityChanged: IdentitySummary | null;
  /** The user picked a different channel or identity. Sent to connected sites. */
  networkChanged: { networkId: string; channel: string };
  /** The site is no longer connected; calls fail until it connects again. */
  disconnect: { reason: DisconnectReason };
}

export type WeftEvent = keyof WeftEvents;

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

export interface WeftProvider {
  readonly isWeft: true;
  readonly version: string;
  request<M extends WeftMethod>(args: RequestArgs<M>): Promise<WeftMethods[M]["result"]>;
  on<E extends WeftEvent>(event: E, listener: (payload: WeftEvents[E]) => void): void;
  off<E extends WeftEvent>(event: E, listener: (payload: WeftEvents[E]) => void): void;
}

declare global {
  interface Window {
    weft?: WeftProvider;
  }
  interface WindowEventMap {
    /** Fired on `window` once the provider has been injected. */
    "weft#initialized": Event;
  }
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export const ErrorCode = {
  /** The user rejected the request. */
  UserRejected: 4001,
  /** The site has not been connected, or the connection was revoked. */
  Unauthorized: 4100,
  /** The method is not supported by this wallet. */
  UnsupportedMethod: 4200,
  /** The wallet is locked or has no identity. */
  NoIdentity: 4300,
  /** The active identity's certificate has expired. */
  CertificateExpired: 4301,
  /** The params were malformed. */
  InvalidParams: -32602,
  /** This site already has a request waiting for the user. Wait for it before sending another. */
  RequestPending: -32002,
  /** The network rejected the transaction. `data` carries the Fabric detail. */
  TransactionFailed: 5001,
  /** The relay or network could not be reached. */
  NetworkUnavailable: 5002,
  /** Something went wrong inside the wallet. */
  Internal: -32603,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface WeftErrorShape {
  code: ErrorCodeValue;
  message: string;
  data?: unknown;
}

export class WeftError extends Error implements WeftErrorShape {
  readonly code: ErrorCodeValue;
  readonly data?: unknown;

  constructor(code: ErrorCodeValue, message: string, data?: unknown) {
    super(message);
    this.name = "WeftError";
    this.code = code;
    this.data = data;
  }

  toJSON(): WeftErrorShape {
    return { code: this.code, message: this.message, data: this.data };
  }

  static from(shape: WeftErrorShape): WeftError {
    return new WeftError(shape.code, shape.message, shape.data);
  }
}

export function isWeftErrorShape(value: unknown): value is WeftErrorShape {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as WeftErrorShape).code === "number" &&
    typeof (value as WeftErrorShape).message === "string"
  );
}

/* ------------------------------------------------------------------ */
/* Window messaging between the page and the extension                 */
/* ------------------------------------------------------------------ */

/** Tag on every `postMessage` so the bridge ignores unrelated traffic. */
export const MESSAGE_TARGET = {
  toWallet: "weft:to-wallet",
  toPage: "weft:to-page",
} as const;

export interface PageToWalletMessage {
  target: typeof MESSAGE_TARGET.toWallet;
  id: string;
  method: WeftMethod;
  params?: unknown;
}

export type WalletToPageMessage =
  | { target: typeof MESSAGE_TARGET.toPage; kind: "response"; id: string; result: unknown }
  | { target: typeof MESSAGE_TARGET.toPage; kind: "response"; id: string; error: WeftErrorShape }
  | { target: typeof MESSAGE_TARGET.toPage; kind: "event"; event: WeftEvent; payload: unknown };

/* ------------------------------------------------------------------ */
/* Org invites                                                         */
/* ------------------------------------------------------------------ */

/**
 * What an organisation publishes so users can join its network in one step.
 * Served as JSON over HTTPS; shared as `weft://invite?u=<url>` or a QR code.
 */
export interface OrgInvite {
  /** Schema version. */
  weft: 1;
  /** Display name for the network. */
  network: string;
  /** Display name for the organisation. */
  organization: string;
  mspId: string;
  /** Base URL of the organisation's Fabric CA, e.g. "https://ca.org1.example.com:7054". */
  caUrl: string;
  /** CA name when the server hosts more than one CA. */
  caName?: string;
  /** Base URL of the organisation's Weft relay. */
  relayUrl: string;
  channels: string[];
  /** Optional enrollment ID pre-filled for the user. */
  enrollmentId?: string;
}

/* ------------------------------------------------------------------ */
/* Relay HTTP API (wallet <-> relay). See docs/adr/0001.               */
/* All byte fields are base64.                                         */
/* ------------------------------------------------------------------ */

export interface RelaySigner {
  mspId: string;
  /** PEM certificate of the identity that will sign. */
  certificate: string;
}

export interface RelayProposalRequest {
  signer: RelaySigner;
  call: ContractCall;
}

export interface RelayProposalResponse {
  /** Serialized proposal, round-tripped to the next step unchanged. */
  proposal: string;
  transactionId: string;
}

export interface RelaySignedProposal {
  signer: RelaySigner;
  proposal: string;
  /** DER-encoded ECDSA signature over the inner proposal bytes. */
  signature: string;
}

export interface RelayEvaluateResponse {
  result: string;
}

export interface RelayEndorseResponse {
  /** Serialized prepared transaction, to be signed and submitted. */
  transaction: string;
  transactionId: string;
  result: string;
}

export interface RelaySignedTransaction {
  signer: RelaySigner;
  transaction: string;
  signature: string;
}

export interface RelaySubmitResponse {
  /** Serialized commit-status request, to be signed and sent to /v1/commits/status. */
  commit: string;
}

export interface RelaySignedCommit {
  signer: RelaySigner;
  commit: string;
  signature: string;
}

export interface RelayCommitStatusResponse {
  transactionId: string;
  blockNumber: string;
  /** Validation code name, e.g. "VALID" or "MVCC_READ_CONFLICT". */
  status: string;
  successful: boolean;
}

export interface RelayErrorResponse {
  error: {
    /** Machine-readable kind, e.g. "endorse", "submit", "bad_request". */
    kind: string;
    message: string;
    /** gRPC status details from peers, when the network returned them. */
    details?: { mspId?: string; address?: string; message: string }[];
  };
}

export const RELAY_PATHS = {
  health: "/v1/health",
  proposals: "/v1/proposals",
  evaluate: "/v1/proposals/evaluate",
  endorse: "/v1/proposals/endorse",
  submit: "/v1/transactions/submit",
  commitStatus: "/v1/commits/status",
} as const;
