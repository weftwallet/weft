/**
 * @weftwallet/protocol
 *
 * The contract between a dApp and Weft Wallet. The extension injects an
 * object implementing `WeftProvider` at `window.weft`. Everything that crosses
 * that boundary is described here, so the extension, the SDK and the docs agree.
 */

export const PROVIDER_VERSION = "0.1.0";

/**
 * What this Weft can do, beyond the methods every Weft has. A page checks
 * `window.weft.features` for a feature rather than comparing versions.
 * Weft Experimental adds its own entries (ExperimentalFeature).
 */
export const PROVIDER_FEATURES = ["receipts"] as const;
export type WeftFeature = (typeof PROVIDER_FEATURES)[number];

/**
 * Experimental: features only Weft Experimental, the build made with
 * WEFT_EXPERIMENTAL=1, can list in `window.weft.features` (docs/adr/0009).
 * Normal Weft never lists them. No one outside the project has reviewed them,
 * and they may change or be removed without notice.
 *
 * - `"castBallot"`: `weft_castBallot`, a private tally for elections with
 *   X.509 voters (docs/adr/0007).
 * - `"voterCredentials"`: Idemix voter credentials, for anonymous ballots
 *   with `weft_castBallot` (docs/adr/0008).
 *
 * Names only: neither feature is built yet, and the protocol has no method
 * for them.
 */
export type ExperimentalFeature = "castBallot" | "voterCredentials";

/* ------------------------------------------------------------------ */
/* Identities and networks                                             */
/* ------------------------------------------------------------------ */

/** Public details of an identity. Never includes key material. */
export interface IdentitySummary {
  /** Stable local ID for this identity in the wallet. */
  id: string;
  /** The certificate's common name, for example "appUser". */
  name: string;
  /** Membership service provider ID, for example "Org1MSP". */
  mspId: string;
  /** NodeOU role taken from the certificate's OU, for example "client" or "admin". */
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
  /** Stable local ID, usually derived from the invite. */
  id: string;
  /** Display name, for example "Acme Supply Network". */
  name: string;
  mspId: string;
  channels: string[];
  /** True for the network of the identity the site is using now. */
  active: boolean;
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

/** A call to a smart contract (chaincode) function. */
export interface ContractCall {
  /** Channel name, for example "mychannel". */
  channel: string;
  /** Chaincode name, for example "basic". */
  chaincode: string;
  /**
   * Optional contract name inside the chaincode, for chaincode built with
   * the Fabric contract API that exposes more than one contract.
   */
  contract?: string;
  /** Function name, for example "TransferAsset". */
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

/**
 * Params for weft_signIn. The wallet builds the message itself from these and
 * fixed fields; a site can't choose the bytes that get signed.
 */
export interface SignInParams {
  /** 16 to 128 characters of [A-Za-z0-9_-], chosen by the site and used once. */
  nonce: string;
  /** One line shown in the approval window, for example "Sign in to Org1's explorer". */
  statement?: string;
}

export interface SignInResult {
  /** The exact text signed, starting "weft-sign-in:v1". */
  message: string;
  /** Base64 of the DER ECDSA signature over the message's UTF-8 bytes. */
  signature: string;
  /** PEM of the identity's certificate. */
  certificate: string;
  mspId: string;
}

export interface SubmitResult extends EvaluateResult {
  transactionId: string;
  blockNumber: string;
  /** Fabric validation code name, for example "VALID". */
  status: string;
  /**
   * The ballot receipt, when the request had one (see SubmitParams.receipt).
   */
  receipt?: ReceiptResult;
}

/* ------------------------------------------------------------------ */
/* Ballot receipts (docs/adr/0006)                                     */
/* ------------------------------------------------------------------ */

/** The `type` of a ballot receipt, as the explorer's receipt check reads it. */
export const RECEIPT_TYPE = "weft-ballot-receipt";

/**
 * A receipt's `salt` that asks Weft to choose the salt. The private input
 * the ballot is in must have the same placeholder (see BallotReceiptRequest).
 */
export const GENERATE_SALT = "generate";

/**
 * What a voting dApp sends with weft_submit to have Weft make the voter's
 * receipt, and offer to keep it. Exactly these six fields.
 *
 * Weft checks it against the call before any window opens: `channel` is the
 * call's channel, `electionId` is one of the call's arguments, and one
 * private input, read as JSON, has this `option` and `salt`. Failing any
 * check fails the request with -32602 InvalidParams.
 *
 * With `salt: "generate"`, exactly one private input must be a JSON object
 * with this `option` and `"salt": "generate"`. Weft replaces that salt with
 * 16 random bytes as 32 lowercase hex characters before the approval window
 * opens, so the voter approves and signs the value the contract gets, and
 * returns the same salt in the receipt.
 */
export interface BallotReceiptRequest {
  type: typeof RECEIPT_TYPE;
  version: 1;
  /** The call's channel. */
  channel: string;
  /** One of the call's arguments. */
  electionId: string;
  /** 1 to 200 characters, as in the private input. */
  option: string;
  /** 32 to 128 lowercase hex characters, as in the private input, or "generate". */
  salt: string;
}

/**
 * A finished ballot receipt: what the voter keeps, and what the explorer's
 * receipt check reads from a file, a paste or Weft.
 */
export interface BallotReceipt {
  type: typeof RECEIPT_TYPE;
  version: 1;
  channel: string;
  electionId: string;
  txId: string;
  blockNumber: number;
  /** SHA-256 of the election ID, the option and the salt, joined by newlines, as hex. */
  commitment: string;
  option: string;
  salt: string;
}

/**
 * Why Weft didn't keep a receipt: the voter left "Keep the receipt in Weft"
 * off, the browser refused to store it, or the commitment the contract
 * returned isn't SHA-256 of the election ID, option and salt.
 */
export type ReceiptNotKeptReason = "declined" | "storage" | "mismatch";

/** What happened to a ballot receipt. `receipt` is the finished receipt either way. */
export type ReceiptResult =
  | { kept: true; receipt: BallotReceipt }
  | { kept: false; reason: ReceiptNotKeptReason; receipt: BallotReceipt };

/** Params for weft_submit: a contract call, with an optional ballot receipt. */
export interface SubmitParams extends ContractCall {
  receipt?: BallotReceiptRequest;
}

/* ------------------------------------------------------------------ */
/* Checking a receipt in the explorer (docs/adr/0006)                  */
/* ------------------------------------------------------------------ */

/**
 * The messages that hand a receipt's choice and salt to the explorer's
 * election page without putting them in an address. The page that holds the
 * receipt opens the election page with window.open (without noopener), its
 * address carrying only `tx` and `commitment`. The election page posts
 * `ready` to window.opener, with no data; the opener answers with a
 * ReceiptHandoff, posted to the explorer's exact origin. The explorer posts
 * nothing else back.
 */
export const RECEIPT_HANDOFF = {
  ready: "weft-receipt-check:ready",
  receipt: "weft-receipt-check:receipt",
} as const;

export interface ReceiptHandoffReady {
  type: typeof RECEIPT_HANDOFF.ready;
  version: 1;
}

export interface ReceiptHandoff {
  type: typeof RECEIPT_HANDOFF.receipt;
  version: 1;
  /** Must be the election and transaction the page is checking. */
  electionId: string;
  txId: string;
  option: string;
  salt: string;
}

/** Every method the provider accepts, with its params and result types. */
export interface WeftMethods {
  weft_connect: { params: undefined; result: IdentitySummary };
  weft_identity: { params: undefined; result: IdentitySummary | null };
  weft_networks: { params: undefined; result: NetworkSummary[] };
  weft_evaluate: { params: ContractCall; result: EvaluateResult };
  weft_submit: { params: SubmitParams; result: SubmitResult };
  weft_addNetwork: { params: AddNetworkParams; result: AddNetworkResult };
  /** Disconnects this site. It must call weft_connect again to use the wallet. */
  weft_disconnect: { params: undefined; result: null };
  /** Proves to the site that the user holds the active identity. Signs no transaction. */
  weft_signIn: { params: SignInParams; result: SignInResult };
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
  "weft_signIn",
] as const;

/** Methods that always show the user an approval screen. */
export const APPROVAL_METHODS: ReadonlySet<WeftMethod> = new Set([
  "weft_connect",
  "weft_evaluate",
  "weft_submit",
  "weft_addNetwork",
  "weft_signIn",
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
  /**
   * The user switched to an identity this site isn't connected to. Call
   * weft_connect to ask for it.
   */
  | "identity-changed"
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
  /**
   * The certificate of the identity this site uses is close to expiring
   * ("expiring", within 30 days) or has expired. Sent once per state, at most
   * an hour late. After the user renews, identityChanged carries the new one.
   */
  certificateStatus: { identityId: string; state: "expiring" | "expired"; notAfter: string; daysLeft: number };
}

export type WeftEvent = keyof WeftEvents;

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

export interface WeftProvider {
  readonly isWeft: true;
  readonly version: string;
  /**
   * Features this Weft offers, for example "receipts". See PROVIDER_FEATURES,
   * and ExperimentalFeature for the entries only Weft Experimental lists.
   */
  readonly features: readonly string[];
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
/* Invites                                                             */
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
  /** Base URL of the organisation's Fabric CA, for example "https://ca.org1.example.com:7054". */
  caUrl: string;
  /** CA name when the server hosts more than one CA. */
  caName?: string;
  /** Base URL of the organisation's Weft relay. */
  relayUrl: string;
  channels: string[];
  /** Optional enrollment ID pre-filled for the user. */
  enrollmentId?: string;
  /** Base URL of the organisation's explorer, if it runs one. Weft links transactions to it. */
  explorerUrl?: string;
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
  /** Validation code name, for example "VALID" or "MVCC_READ_CONFLICT". */
  status: string;
  successful: boolean;
}

export interface RelayErrorResponse {
  error: {
    /** Machine-readable kind, for example "endorse", "submit", "bad_request". */
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
