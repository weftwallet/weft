/**
 * @weftwallet/sdk: call Weft from a web app.
 *
 *   const weft = await getWeft();
 *   const me = await weft.connect();
 *   const assets = weft.contract({ channel: "mychannel", chaincode: "basic" });
 *   await assets.submit("TransferAsset", "asset6", "Christopher");
 */

import {
  ErrorCode,
  RECEIPT_HANDOFF,
  WeftError,
  isWeftErrorShape,
  type AddNetworkResult,
  type BallotReceipt,
  type BallotReceiptRequest,
  type ContractCall,
  type EvaluateResult,
  type ExperimentalFeature,
  type IdentitySummary,
  type NetworkSummary,
  type ReceiptHandoff,
  type SignInResult,
  type SubmitParams,
  type SubmitResult,
  type WeftEvent,
  type WeftEvents,
  type WeftFeature,
  type WeftProvider,
} from "@weftwallet/protocol";

export * from "@weftwallet/protocol";

export class WeftNotInstalledError extends Error {
  constructor() {
    super("The Weft Wallet extension is not installed in this browser.");
    this.name = "WeftNotInstalledError";
  }
}

/**
 * Resolves with the injected provider, waiting up to `timeoutMs` for it to
 * appear. Rejects with WeftNotInstalledError if it never does.
 */
export function detectProvider(timeoutMs = 3000): Promise<WeftProvider> {
  if (typeof window === "undefined") return Promise.reject(new WeftNotInstalledError());
  if (window.weft?.isWeft) return Promise.resolve(window.weft);
  return new Promise((resolve, reject) => {
    const onReady = () => {
      clearTimeout(timer);
      if (window.weft?.isWeft) resolve(window.weft);
      else reject(new WeftNotInstalledError());
    };
    const timer = setTimeout(() => {
      window.removeEventListener("weft#initialized", onReady);
      reject(new WeftNotInstalledError());
    }, timeoutMs);
    window.addEventListener("weft#initialized", onReady, { once: true });
  });
}

function rethrow(error: unknown): never {
  if (error instanceof WeftError) throw error;
  if (isWeftErrorShape(error)) throw WeftError.from(error);
  throw new WeftError(ErrorCode.Internal, error instanceof Error ? error.message : String(error));
}

export interface ContractRef {
  channel: string;
  chaincode: string;
  /** Contract name inside the chaincode, when it exposes several. */
  contract?: string;
}

export interface CallOptions {
  transient?: Record<string, string>;
  endorsingOrganizations?: string[];
  /** A ballot receipt for Weft to make and offer to keep (submit only). See SubmitParams. */
  receipt?: BallotReceiptRequest;
}

/** A typed, ergonomic wrapper around the raw provider. */
export class WeftClient {
  readonly provider: WeftProvider;

  constructor(provider: WeftProvider) {
    this.provider = provider;
  }

  /** Asks the user to connect this site. Resolves with their active identity. */
  async connect(): Promise<IdentitySummary> {
    return this.provider.request({ method: "weft_connect" }).catch(rethrow);
  }

  /** The connected identity, or null if this site is not connected. */
  async identity(): Promise<IdentitySummary | null> {
    return this.provider.request({ method: "weft_identity" }).catch(rethrow);
  }

  /** Disconnects this site. Every tab of this site gets a `disconnect` event. */
  async disconnect(): Promise<void> {
    await this.provider.request({ method: "weft_disconnect" }).catch(rethrow);
  }

  async networks(): Promise<NetworkSummary[]> {
    return this.provider.request({ method: "weft_networks" }).catch(rethrow);
  }

  /** Read-only query. The user approves it; nothing is written to the ledger. */
  async evaluate(call: ContractCall): Promise<EvaluateResult> {
    return this.provider.request({ method: "weft_evaluate", params: call }).catch(rethrow);
  }

  /**
   * Ledger write. The user approves it; resolves once committed as VALID.
   * With `receipt`, Weft checks it against the call, offers the voter to keep
   * it, and returns the finished receipt as `result.receipt`.
   */
  async submit(call: SubmitParams): Promise<SubmitResult> {
    return this.provider.request({ method: "weft_submit", params: call }).catch(rethrow);
  }

  /**
   * Whether this Weft offers a feature, for example "receipts". The
   * ExperimentalFeature names, such as "castBallot", are listed only by
   * Weft Experimental (docs/adr/0009).
   */
  supports(feature: WeftFeature | ExperimentalFeature | (string & {})): boolean {
    return this.provider.features?.includes(feature) ?? false;
  }

  /**
   * Asks the user to join a network from your organisation's invite, for example from
   * an admin portal's "Set up Weft" button. Weft shows the invite, then the user
   * enrols with their enrollment ID and secret. Doesn't require connect().
   */
  async addNetwork(inviteUrl: string): Promise<AddNetworkResult> {
    return this.provider.request({ method: "weft_addNetwork", params: { url: inviteUrl } }).catch(rethrow);
  }

  /**
   * Asks the user to prove they hold their active identity, for signing in to
   * your site. Get a fresh nonce from your server, then send the result back
   * for it to verify (verifySignIn and parseSignInMessage in @weftwallet/core).
   * Requires connect().
   */
  async signIn(nonce: string, statement?: string): Promise<SignInResult> {
    return this.provider
      .request({ method: "weft_signIn", params: statement ? { nonce, statement } : { nonce } })
      .catch(rethrow);
  }

  /** Binds a channel and chaincode so calls read like function calls. */
  contract(ref: ContractRef) {
    const build = (fn: string, args: string[], options: CallOptions = {}): ContractCall => ({ ...ref, fn, args, ...options });
    return {
      evaluate: (fn: string, ...args: string[]) => this.evaluate(build(fn, args)),
      submit: (fn: string, ...args: string[]) => this.submit(build(fn, args)),
      /** Like evaluate/submit, with transient data or endorser selection. */
      evaluateWith: (fn: string, args: string[], options: CallOptions) => this.evaluate(build(fn, args, options)),
      submitWith: (fn: string, args: string[], options: CallOptions) => this.submit(build(fn, args, options)),
      /** Evaluates and parses the result as JSON. */
      evaluateJson: async <T = unknown>(fn: string, ...args: string[]): Promise<T> => {
        const result = await this.evaluate(build(fn, args));
        if (result.text === null) throw new WeftError(ErrorCode.Internal, "The result is not text.");
        return JSON.parse(result.text) as T;
      },
    };
  }

  on<E extends WeftEvent>(event: E, listener: (payload: WeftEvents[E]) => void): () => void {
    this.provider.on(event, listener);
    return () => this.provider.off(event, listener);
  }
}

/**
 * Opens the explorer's election page to check a ballot receipt, and gives the
 * page the choice and salt once it asks, by postMessage to that window at the
 * explorer's origin. The address carries only the transaction ID and the
 * commitment, so the browser's history never records the choice or salt.
 *
 * Call it from a click. The explorer accepts the choice and salt only from
 * origins its operator lists (WEFT_EXPLORER_RECEIPT_ORIGINS); from any other
 * page the voter enters them on the page. Returns the window, or null when
 * the browser blocked it.
 */
export function checkReceiptInExplorer(explorerUrl: string, receipt: BallotReceipt): Window | null {
  const page = new URL(
    `${explorerUrl.replace(/\/+$/, "")}/channels/${encodeURIComponent(receipt.channel)}/elections/${encodeURIComponent(receipt.electionId)}`,
  );
  page.search = new URLSearchParams({ tx: receipt.txId, commitment: receipt.commitment }).toString();
  page.hash = "receipt";
  // Not noopener: the page asks its opener for the choice and salt.
  const win = window.open(page.toString(), "_blank");
  if (!win) return null;
  const onMessage = (e: MessageEvent) => {
    if (e.source !== win || e.origin !== page.origin) return;
    const data = e.data as { type?: unknown; version?: unknown } | null;
    if (data?.type !== RECEIPT_HANDOFF.ready || data.version !== 1) return;
    const handoff: ReceiptHandoff = {
      type: RECEIPT_HANDOFF.receipt,
      version: 1,
      electionId: receipt.electionId,
      txId: receipt.txId,
      option: receipt.option,
      salt: receipt.salt,
    };
    win.postMessage(handoff, page.origin);
  };
  window.addEventListener("message", onMessage);
  // Stop listening once the page has gone.
  const watch = setInterval(() => {
    if (!win.closed) return;
    clearInterval(watch);
    window.removeEventListener("message", onMessage);
  }, 1000);
  return win;
}

/** Finds the wallet and returns a client for it. */
export async function getWeft(options: { timeoutMs?: number } = {}): Promise<WeftClient> {
  return new WeftClient(await detectProvider(options.timeoutMs));
}
