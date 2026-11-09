/**
 * @weftwallet/sdk: call Weft from a web app.
 *
 *   const weft = await getWeft();
 *   const me = await weft.connect();
 *   const assets = weft.contract({ channel: "mychannel", chaincode: "basic" });
 *   await assets.submit("TransferAsset", "asset6", "Christopher");
 */

import {
  ANNOUNCE_PROVIDER_EVENT,
  ErrorCode,
  RECEIPT_HANDOFF,
  REQUEST_PROVIDER_EVENT,
  WeftError,
  isWeftErrorShape,
  type AddNetworkResult,
  type BallotReceipt,
  type BallotReceiptRequest,
  type CastBallotParams,
  type CastBallotResult,
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
  type WeftProviderDetail,
  type WeftProviderInfo,
} from "@weftwallet/protocol";

export * from "@weftwallet/protocol";

export class WeftNotInstalledError extends Error {
  constructor() {
    super("The Weft Wallet extension is not installed in this browser.");
    this.name = "WeftNotInstalledError";
  }
}

/** How long detectProviders listens for announcements, and detectProvider for the preferred wallet once another is found. */
export const ANNOUNCE_WAIT_MS = 500;

/** Whether an announcement's detail has the shape of a WeftProviderDetail. */
function isDetail(value: unknown): value is WeftProviderDetail {
  const d = value as Partial<WeftProviderDetail> | null;
  return typeof d?.info?.uuid === "string" && typeof d.info.rdns === "string" && d.provider?.isWeft === true;
}

/**
 * Listens for announcements, asks every Weft to announce itself, and calls
 * `found` once for each wallet (by info.uuid). Returns a function that stops
 * listening.
 */
function listenForProviders(found: (detail: WeftProviderDetail) => void): () => void {
  const seen = new Set<string>();
  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isDetail(detail) || seen.has(detail.info.uuid)) return;
    seen.add(detail.info.uuid);
    found(detail);
  };
  window.addEventListener(ANNOUNCE_PROVIDER_EVENT, onAnnounce);
  window.dispatchEvent(new Event(REQUEST_PROVIDER_EVENT));
  return () => window.removeEventListener(ANNOUNCE_PROVIDER_EVENT, onAnnounce);
}

export interface DetectProvidersOptions {
  /** How long to listen for announcements, in milliseconds. 500 by default. */
  waitMs?: number;
}

/**
 * Every Weft in this browser that announces itself (docs/adr/0010): asks
 * them with weft:requestProvider, listens for `waitMs`, and resolves with
 * one { info, provider } per wallet, in the order they answered. With Weft
 * and Weft Experimental both installed, that is two. Resolves with an empty
 * list when none answers.
 *
 * `info` is what each announcer says about itself. Any script on the page
 * can announce a provider named "Weft", so treat it as you treat
 * window.weft: the page's own content, not proof of which extension it is.
 */
export function detectProviders(options: DetectProvidersOptions = {}): Promise<WeftProviderDetail[]> {
  if (typeof window === "undefined") return Promise.resolve([]);
  const found: WeftProviderDetail[] = [];
  const stop = listenForProviders((detail) => found.push(detail));
  return new Promise((resolve) =>
    setTimeout(() => {
      stop();
      resolve(found);
    }, options.waitMs ?? ANNOUNCE_WAIT_MS),
  );
}

export interface DetectProviderOptions {
  /** How long to wait for any Weft, in milliseconds. 3000 by default. */
  timeoutMs?: number;
  /**
   * The wallet to prefer, by its rdns, for example WEFT_EXPERIMENTAL_RDNS.
   * When it doesn't announce itself, detectProvider resolves with
   * window.weft, or another announced Weft, as it would without one.
   */
  rdns?: string;
}

/** The provider detectProvider found, with its announcement when it had one. */
async function findProvider(options: DetectProviderOptions): Promise<{ provider: WeftProvider; info?: WeftProviderInfo }> {
  if (typeof window === "undefined") throw new WeftNotInstalledError();
  const timeoutMs = options.timeoutMs ?? 3000;
  const { rdns } = options;

  if (!rdns) {
    const provider = await waitForWindowWeft(timeoutMs);
    // Each Weft announces itself as soon as it is asked, so this one's
    // announcement, if it made one, has already arrived when stop() runs.
    let info: WeftProviderInfo | undefined;
    const stop = listenForProviders((detail) => {
      if (detail.provider === provider) info = detail.info;
    });
    stop();
    return { provider, info };
  }

  return new Promise((resolve, reject) => {
    const announced: WeftProviderDetail[] = [];
    let done = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let stop = () => {};
    const finish = (result: { provider: WeftProvider; info?: WeftProviderInfo } | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      stop();
      window.removeEventListener("weft#initialized", someWeft);
      if (result) resolve(result);
      else reject(new WeftNotInstalledError());
    };
    // The preferred wallet didn't answer: window.weft, or else the first that did.
    const fallback = () => {
      const weft = window.weft?.isWeft ? window.weft : null;
      if (weft) finish({ provider: weft, info: announced.find((d) => d.provider === weft)?.info });
      else finish(announced[0] ?? null);
    };
    // Once any Weft is here, the preferred one has ANNOUNCE_WAIT_MS more to answer.
    const someWeft = () => {
      if (!done && grace === undefined) grace = setTimeout(fallback, ANNOUNCE_WAIT_MS);
    };
    window.addEventListener("weft#initialized", someWeft);
    const timer = setTimeout(fallback, timeoutMs);
    // Wallets answer the request at once, so finish can run before stop is set.
    stop = listenForProviders((detail) => {
      if (detail.info.rdns === rdns) return finish(detail);
      announced.push(detail);
      someWeft();
    });
    if (done) stop();
    else if (window.weft?.isWeft) someWeft();
  });
}

/** window.weft, waiting up to `timeoutMs` for weft#initialized. */
function waitForWindowWeft(timeoutMs: number): Promise<WeftProvider> {
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

/**
 * Resolves with the injected provider, window.weft, waiting up to
 * `timeoutMs` (3000 by default) for it to appear. Rejects with
 * WeftNotInstalledError if it never does.
 *
 * With `{ rdns }`, it prefers that wallet: it resolves with that wallet's
 * provider as soon as it announces itself. When it doesn't announce itself
 * within half a second of another Weft being found, it resolves with
 * window.weft instead.
 */
export function detectProvider(options?: number | DetectProviderOptions): Promise<WeftProvider> {
  const resolved = typeof options === "number" ? { timeoutMs: options } : (options ?? {});
  return findProvider(resolved).then((found) => found.provider);
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
  /**
   * Which wallet this is, from its announcement (docs/adr/0010), when the
   * client was built from one: `new WeftClient(detail.provider, detail.info)`
   * or getWeft(). What the announcer claims, as detectProviders says.
   */
  readonly info?: WeftProviderInfo;

  constructor(provider: WeftProvider, info?: WeftProviderInfo) {
    this.provider = provider;
    if (info) this.info = info;
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

  /**
   * Experimental: asks the voter to cast a ballot in a private election
   * (docs/adr/0007). Only Weft Experimental offers it: check
   * supports("castBallot") first, since normal Weft fails with 4200. The
   * voter chooses in Weft's window, and the result has the transaction and a
   * version 2 receipt, never the choice. Doesn't require connect().
   */
  async castBallot(params: CastBallotParams): Promise<CastBallotResult> {
    return this.provider.request({ method: "weft_castBallot", params }).catch(rethrow);
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

/**
 * Finds the wallet and returns a client for it, as detectProvider finds it.
 * The client has `info` when the wallet announced itself.
 */
export async function getWeft(options: DetectProviderOptions = {}): Promise<WeftClient> {
  const found = await findProvider(options);
  return new WeftClient(found.provider, found.info);
}
