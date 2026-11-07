import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { SignInError } from "@weftwallet/core";
import { Auth, SESSION_COOKIE, UnreadableSignIn, type Viewer } from "./auth.ts";
import type { ExplorerDb, TransactionRow } from "./db.ts";
import type { ChannelStatus } from "./indexer.ts";
import * as pages from "./pages.ts";
import { channelLevel, contractLevel, viewTransaction, type Policy } from "./policy.ts";
import type { CheckpointSigner, CrossCheck } from "./checkpoints.ts";
import { requesterIsMember, verifyExplorerRequest } from "./checkpoints.ts";
import { checkReceipt, elections } from "./elections.ts";
import { PUBLIC_PRODUCTS, receiptOrigins, type ProductAddresses } from "./config.ts";
import { electionList, electionView, publishedBallot } from "./private-elections.ts";
import * as privatePages from "./private-pages.ts";

export interface ServerOptions {
  name: string;
  /** The organisation running this explorer, for example Org1MSP. */
  mspId?: string;
  /** Indexed channels (public and members). */
  channels: string[];
  policy: Policy;
  db: ExplorerDb;
  status: () => ChannelStatus[];
  auth?: Auth;
  /** This explorer's public origin, for example https://explorer.org1.example. Sign-in messages must name it. */
  publicUrl?: string;
  /** Signs this explorer's checkpoints for other organisations to compare. */
  signer?: CheckpointSigner;
  /** The other organisations' explorers, polled for their checkpoints. */
  crossCheck?: CrossCheck;
  /** The network page that block pages link to. */
  networkPage?: string;
  /** Where the other Weft products are. Defaults to products.json's public addresses. */
  products?: ProductAddresses;
  /** Who may hand an election page a receipt's choice and salt. Defaults to Weft Playground where the products are. */
  receiptOrigins?: string[];
  /**
   * WEFT_EXPERIMENTAL=1 (docs/adr/0009): private election pages and their
   * API for channels whose policy names privateElections, and the full
   * check's worker. Off by default, and then none of it is served.
   */
  experimental?: boolean;
  logger?: boolean;
}

/** The full check's Web Worker, bundled by scripts/build-worker.mjs. */
export const FULL_CHECK_WORKER = join(dirname(fileURLToPath(import.meta.url)), "../dist/worker/full-check.js");

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function asset(path: string) {
  return readFileSync(join(here, "../assets", path));
}

function font(pkg: string, file: string) {
  return readFileSync(join(dirname(require.resolve(`${pkg}/package.json`)), "files", file));
}

const ASSETS: Record<string, { type: string; body: () => Buffer }> = {
  "tokens.css": { type: "text/css; charset=utf-8", body: () => readFileSync(require.resolve("@weftwallet/brand/tokens.css")) },
  // The motion and the header every Weft product shares, served after the tokens.
  "motion.css": { type: "text/css; charset=utf-8", body: () => readFileSync(require.resolve("@weftwallet/ui/motion.css")) },
  "header.css": { type: "text/css; charset=utf-8", body: () => readFileSync(require.resolve("@weftwallet/ui/header.css")) },
  // Every Weft select's chevron and open list, with the two icons it masks.
  "select.css": { type: "text/css; charset=utf-8", body: () => readFileSync(require.resolve("@weftwallet/ui/select.css")) },
  "icons/chevron.svg": { type: "image/svg+xml", body: () => readFileSync(require.resolve("@weftwallet/ui/icons/chevron.svg")) },
  "icons/check.svg": { type: "image/svg+xml", body: () => readFileSync(require.resolve("@weftwallet/ui/icons/check.svg")) },
  // The buttons and the system page every Weft product shares, then the
  // explorer's own rules, which may refine them: one file, so the page's
  // head is unchanged.
  "explorer.css": {
    type: "text/css; charset=utf-8",
    body: () => Buffer.concat([readFileSync(require.resolve("@weftwallet/ui/buttons.css")), readFileSync(require.resolve("@weftwallet/ui/system-page.css")), asset("explorer.css")]),
  },
  // The field error's icon, a mask: a file, since the CSP refuses data: images.
  "alert.svg": { type: "image/svg+xml", body: () => asset("alert.svg") },
  "mark.svg": { type: "image/svg+xml", body: () => readFileSync(require.resolve("@weftwallet/brand/logo/products/explorer-small.svg")) },
  // The explorer's loader, and Weft's, for signing in: it's Weft that signs.
  "loader.svg": { type: "image/svg+xml", body: () => readFileSync(require.resolve("@weftwallet/brand/logo/loaders/explorer-small.svg")) },
  "loader-weft.svg": { type: "image/svg+xml", body: () => readFileSync(require.resolve("@weftwallet/brand/logo/loaders/weft-small.svg")) },
  "fonts/sans-400.woff2": { type: "font/woff2", body: () => font("@fontsource/atkinson-hyperlegible-next", "atkinson-hyperlegible-next-latin-400-normal.woff2") },
  "fonts/sans-500.woff2": { type: "font/woff2", body: () => font("@fontsource/atkinson-hyperlegible-next", "atkinson-hyperlegible-next-latin-500-normal.woff2") },
  "fonts/sans-600.woff2": { type: "font/woff2", body: () => font("@fontsource/atkinson-hyperlegible-next", "atkinson-hyperlegible-next-latin-600-normal.woff2") },
  "fonts/mono-400.woff2": { type: "font/woff2", body: () => font("@fontsource/atkinson-hyperlegible-mono", "atkinson-hyperlegible-mono-latin-400-normal.woff2") },
  "fonts/mono-500.woff2": { type: "font/woff2", body: () => font("@fontsource/atkinson-hyperlegible-mono", "atkinson-hyperlegible-mono-latin-500-normal.woff2") },
};

const PAGE = 20;
/** Ballots on one page of a private election's table, and at most in one API answer. */
const BALLOT_PAGE = 50;
const BALLOT_API_PAGE = 1000;
const CONTRACT_PAGE = 50;
/** Most headers one request returns. */
const HEADERS = 1000;

function int(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const { db, channels, policy } = options;
  const experimental = options.experimental === true;
  const auth = options.auth ?? new Auth();
  // Errors the router finds before any route runs (a malformed address) go
  // to the same handler as the routes' own, set below.
  let onError: (error: { statusCode?: number; message?: string }, request: FastifyRequest, reply: FastifyReply) => unknown = () => undefined;
  const app = Fastify({ logger: options.logger ?? false, frameworkErrors: (error, request, reply) => onError(error, request, reply) });
  // Requests are logged only when something goes wrong: the pages poll, and
  // other explorers check in every few seconds.
  app.addHook("onRoute", (route) => {
    route.logLevel = "warn";
  });
  const statusOf = (channel: string) => options.status().find((s) => s.channel === channel);
  const trustedOpeners = options.receiptOrigins ?? receiptOrigins(options.products ?? PUBLIC_PRODUCTS, undefined);
  // Sign-in only matters when something is published to members.
  const membersLevelExists = channels.some(
    (c) => channelLevel(policy, c) === "members" || Object.values(policy.channels[c]?.contracts ?? {}).includes("members"),
  );

  /** Everything that depends on who's asking. */
  function scope(request: FastifyRequest) {
    const viewer = auth.read(request.headers.cookie) ?? auth.readBearer(request.headers.authorization);
    // Another organisation's explorer, comparing ledgers: it signs each request.
    const requester = request.url.startsWith("/api/") ? verifyExplorerRequest(request.headers, request.url) : null;
    const memberOf = (channel: string) =>
      (!!viewer && db.members(channel).some((m) => m.mspId === viewer.mspId)) ||
      (!!requester && requesterIsMember(requester, db.members(channel)));
    const visible = channels.filter((c) => channelLevel(policy, c) === "public" || memberOf(c));
    const canSee = (channel: string) => visible.includes(channel);
    const canSeeContract = (channel: string, name: string) => {
      const level = contractLevel(policy, channel, name);
      return level === "public" || (level === "members" && memberOf(channel));
    };
    const view = (tx: TransactionRow) => viewTransaction(tx, memberOf(tx.channel));
    const site: pages.Site = {
      name: options.name,
      channels: visible,
      viewer,
      signIn: membersLevelExists,
      peers: (channel) => options.crossCheck?.peersFor(channel) ?? [],
      ...(options.networkPage ? { networkPage: options.networkPage } : {}),
      products: options.products ?? PUBLIC_PRODUCTS,
      receiptOrigins: trustedOpeners,
      elections: (channel) => {
        const contract = policy.channels[channel]?.elections;
        return (!!contract && visible.includes(channel) && canSeeContract(channel, contract)) || canSeePrivate(channel);
      },
      ...(experimental ? { privateElections: canSeePrivate } : {}),
    };
    /** Private elections, only with WEFT_EXPERIMENTAL=1 and a channel that names privateElections. */
    function canSeePrivate(channel: string): boolean {
      const contract = policy.channels[channel]?.privateElections;
      return experimental && !!contract && visible.includes(channel) && canSeeContract(channel, contract);
    }
    return { viewer, memberOf, visible, canSee, canSeeContract, canSeePrivate, view, site };
  }

  const send = (reply: FastifyReply, body: string, code = 200) =>
    reply.code(code).header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store").send(body);
  const notFound = (reply: FastifyReply, site: pages.Site, page: pages.NotFound) => send(reply, pages.notFoundPage(site, page), 404);
  /** The address that was asked for, as the person typed it: host and path. */
  const asked = (request: FastifyRequest) => {
    let path = request.url;
    try {
      path = decodeURI(path);
    } catch {
      /* keep it encoded */
    }
    return { label: "Address", value: `${request.host}${path}` };
  };
  /** How far this explorer has read a channel, for a block or transaction it doesn't have. */
  const indexedUpTo = (channel: string) => {
    const [summary] = db.channels([channel]);
    return summary && summary.height > 0 ? ` ${options.name}'s explorer has indexed ${channel} up to block #${summary.height - 1}.` : "";
  };
  const MEMBERS = "If your organisation is a member, sign in with Weft to see it.";
  /** Why a sign-in failed, for the person, with any technical reason apart. */
  const signInFailure = (error: unknown) =>
    error instanceof UnreadableSignIn
      ? { error: error.message, detail: error.detail }
      : error instanceof SignInError
        ? { error: error.message }
        : { error: "This explorer couldn't check that sign-in. Try again.", detail: (error as Error)?.message ?? String(error) };

  app.addHook("onSend", async (request, reply) => {
    // Public data can be read by anyone, including other organisations'
    // explorers. Cookies aren't sent cross-origin, so members-level data isn't.
    if (request.url.startsWith("/api/")) {
      reply.header("access-control-allow-origin", "*");
      // What a signed-in reader gets differs from what anyone else gets.
      if (request.headers.authorization || request.headers["x-weft-signature"]) reply.header("cache-control", "no-store").header("vary", "authorization");
    }
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    if (!request.url.startsWith("/api/") && !request.url.startsWith("/assets/")) {
      // The private elections' full check runs in workers from /assets/full-check.js.
      reply.header(
        "content-security-policy",
        `default-src 'self'; script-src 'unsafe-inline'; style-src 'self'; img-src 'self'; font-src 'self'; ${experimental ? "worker-src 'self'; " : ""}frame-ancestors 'none'`,
      );
    }
  });

  app.get<{ Params: { "*": string } }>("/assets/*", async (request, reply) => {
    if (experimental && request.params["*"] === "full-check.js") {
      let body: Buffer;
      try {
        body = readFileSync(FULL_CHECK_WORKER);
      } catch {
        return reply.code(404).send();
      }
      return reply.header("content-type", "text/javascript; charset=utf-8").header("cache-control", "no-cache").send(body);
    }
    const entry = ASSETS[request.params["*"]];
    if (!entry) return reply.code(404).send();
    return reply.header("content-type", entry.type).header("cache-control", "public, max-age=86400").send(entry.body());
  });

  /* Sign-in ---------------------------------------------------------- */

  const originOf = (request: FastifyRequest) => options.publicUrl ?? `${request.protocol}://${request.host}`;

  app.get("/auth/nonce", async (_request, reply) => reply.header("cache-control", "no-store").send({ nonce: auth.nonce() }));

  app.post<{ Body: { message?: unknown; signature?: unknown; certificate?: unknown } }>("/auth/verify", async (request, reply) => {
    try {
      const membersOf = (mspId: string) => channels.flatMap((c) => db.members(c).filter((m) => m.mspId === mspId));
      const viewer = await auth.verify(request.body ?? {}, originOf(request), membersOf);
      const secure = originOf(request).startsWith("https:") ? "; Secure" : "";
      reply.header(
        "set-cookie",
        `${SESSION_COOKIE}=${auth.cookie(viewer)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((viewer.expires - Date.now()) / 1000)}${secure}`,
      );
      return { mspId: viewer.mspId, name: viewer.name };
    } catch (error) {
      return reply.code(401).send(signInFailure(error));
    }
  });

  /*
   * The network page signs in to every organisation's explorer at once, from
   * its own origin. Only the network page this explorer names is accepted.
   */
  const networkOrigin = options.networkPage ? new URL(options.networkPage).origin : null;

  app.options("/auth/network", async (request, reply) => {
    if (!networkOrigin) return reply.code(404).send();
    return reply
      .header("access-control-allow-origin", networkOrigin)
      .header("access-control-allow-methods", "POST")
      .header("access-control-allow-headers", "content-type")
      .header("access-control-max-age", "600")
      .code(204)
      .send();
  });

  app.post<{ Body: { message?: unknown; signature?: unknown; certificate?: unknown } }>("/auth/network", async (request, reply) => {
    if (!networkOrigin) return reply.code(404).send({ error: "This explorer doesn't accept network page sign-ins." });
    reply.header("access-control-allow-origin", networkOrigin).header("cache-control", "no-store");
    try {
      const membersOf = (mspId: string) => channels.flatMap((c) => db.members(c).filter((m) => m.mspId === mspId));
      const viewer = await auth.verify(request.body ?? {}, networkOrigin, membersOf, Date.now(), "chosen");
      return { token: auth.token(viewer), expires: viewer.expires, mspId: viewer.mspId, name: viewer.name };
    } catch (error) {
      return reply.code(401).send(signInFailure(error));
    }
  });

  // The public API can be read with a bearer token from the network page.
  app.options("/api/*", async (_request, reply) =>
    reply
      .header("access-control-allow-origin", "*")
      .header("access-control-allow-methods", "GET")
      .header("access-control-allow-headers", "authorization")
      .header("access-control-max-age", "600")
      .code(204)
      .send(),
  );

  // The sign-out button is a plain form post; it has no fields worth reading.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, _body, done) => done(null, {}));

  app.post("/auth/sign-out", async (_request, reply) =>
    reply.header("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`).redirect("/", 303),
  );

  /* Pages ------------------------------------------------------------ */

  app.get("/", async (request, reply) => {
    const s = scope(request);
    const latest = s.visible.flatMap((c) => db.blocks(c, { limit: 8 })).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)).slice(0, 8);
    const txs = db.transactions(s.visible, { limit: 8 }).map(s.view);
    return send(reply, pages.homePage(s.site, db.channels(s.visible), options.status(), latest, txs));
  });

  app.get("/me", async (request, reply) => {
    const s = scope(request);
    if (!s.viewer) return send(reply, pages.signedOutMePage(s.site));
    const txs = s.viewer.name ? db.transactions(s.visible, { mspId: s.viewer.mspId, creatorName: s.viewer.name, limit: 50 }).map(s.view) : [];
    return send(reply, pages.mePage(s.site, s.viewer, txs));
  });

  app.get<{ Params: { channel: string }; Querystring: { before?: string } }>("/channels/:channel", async (request, reply) => {
    const s = scope(request);
    const { channel } = request.params;
    if (!s.canSee(channel)) {
      return notFound(reply, s.site, {
        title: "Channel not found",
        heading: "That channel isn't published here",
        lead: ["It may be published to its members only."],
        asked: asked(request),
        signIn: MEMBERS,
      });
    }
    const [summary] = db.channels([channel]);
    const before = int(request.query.before);
    const blocks = db.blocks(channel, { before, limit: PAGE });
    return send(
      reply,
      pages.channelPage(s.site, summary!, statusOf(channel), blocks, db.contracts(channel, s.memberOf(channel)), { ...(before !== undefined ? { before } : {}), size: PAGE }),
    );
  });

  app.get<{ Params: { channel: string; number: string } }>("/channels/:channel/blocks/:number", async (request, reply) => {
    const s = scope(request);
    const { channel } = request.params;
    const number = int(request.params.number);
    if (number === undefined) {
      throw Object.assign(new Error(`A block number is a whole number, and "${request.params.number}" isn't one.`), { statusCode: 400 });
    }
    const found = s.canSee(channel) ? db.block(channel, number) : null;
    if (!found) {
      return notFound(reply, s.site, {
        title: "Block not found",
        heading: "That block isn't here",
        lead: [`It may not be indexed yet.${s.canSee(channel) ? indexedUpTo(channel) : ""}`],
        asked: asked(request),
        ...(s.canSee(channel) ? {} : { signIn: MEMBERS }),
      });
    }
    const hasNext = db.block(channel, number! + 1) !== null;
    return send(reply, pages.blockPage(s.site, found.block, found.transactions.map(s.view), hasNext));
  });

  app.get<{ Params: { channel: string; txId: string } }>("/channels/:channel/transactions/:txId", async (request, reply) => {
    const s = scope(request);
    const { channel, txId } = request.params;
    const tx = s.canSee(channel) ? db.transaction(channel, txId) : null;
    if (!tx) {
      return notFound(reply, s.site, {
        title: "Transaction not found",
        heading: "No published transaction has that ID",
        lead: [`It may be in a block this explorer hasn't indexed yet.${s.canSee(channel) ? indexedUpTo(channel) : ""}`],
        asked: { label: "Transaction", value: pages.cut(txId) },
        signIn: `If your organisation is a member of ${channel}, sign in with Weft to see its members-only transactions.`,
      });
    }
    return send(reply, pages.transactionPage(s.site, s.view(tx)));
  });

  app.get<{ Params: { channel: string; name: string }; Querystring: { before?: string } }>(
    "/channels/:channel/contracts/:name",
    async (request, reply) => {
      const s = scope(request);
      const { channel, name } = request.params;
      const missing = () =>
        notFound(reply, s.site, { title: "Contract not found", heading: "No published transactions call that contract", asked: asked(request), signIn: MEMBERS });
      if (!s.canSee(channel) || !s.canSeeContract(channel, name)) return missing();
      const before = int(request.query.before);
      const txs = db.transactions(s.visible, { channel, chaincode: name, before, limit: CONTRACT_PAGE }).map(s.view);
      if (txs.length === 0 && before === undefined) return missing();
      const url = `/channels/${encodeURIComponent(channel)}/contracts/${encodeURIComponent(name)}`;
      // The page after this one, going newer: it starts where this one ends.
      let newer: string | null = null;
      if (before !== undefined) {
        const ahead = db.transactions(s.visible, { channel, chaincode: name, after: before, limit: CONTRACT_PAGE + 1 });
        newer = ahead.length <= CONTRACT_PAGE ? url : `${url}?before=${ahead[CONTRACT_PAGE - 1]!.blockNumber + 1}`;
      }
      const oldest = txs.at(-1)?.blockNumber;
      const older = txs.length === CONTRACT_PAGE && oldest !== undefined && oldest > 0 ? `${url}?before=${oldest}` : null;
      return send(reply, pages.contractPage(s.site, channel, name, txs, { ...(before !== undefined ? { before } : {}), newer, older }));
    },
  );

  app.get<{ Querystring: { q?: string } }>("/search", async (request, reply) => {
    const s = scope(request);
    const query = (request.query.q ?? "").trim();
    const results: pages.SearchResults = { blocks: [], txs: [], contracts: [] };
    if (query) {
      const number = int(query.replace(/^#/, ""));
      if (number !== undefined) {
        for (const c of s.visible) {
          const found = db.block(c, number);
          if (found) results.blocks.push(found.block);
        }
      }
      if (/^[0-9a-f]{6,64}$/i.test(query)) results.txs = db.findTransactions(s.visible, query.toLowerCase()).map(s.view);
      for (const c of s.visible) {
        for (const contract of db.contracts(c, s.memberOf(c))) {
          if (contract.chaincode.toLowerCase().includes(query.toLowerCase())) results.contracts.push({ channel: c, chaincode: contract.chaincode });
        }
      }
      // One exact hit: go straight there.
      const total = results.blocks.length + results.txs.length + results.contracts.length;
      if (total === 1) {
        if (results.blocks[0]) return reply.redirect(`/channels/${encodeURIComponent(results.blocks[0].channel)}/blocks/${results.blocks[0].number}`);
        if (results.txs[0] && results.txs[0].txId === query.toLowerCase())
          return reply.redirect(`/channels/${encodeURIComponent(results.txs[0].channel)}/transactions/${results.txs[0].txId}`);
        if (results.contracts[0] && results.contracts[0].chaincode.toLowerCase() === query.toLowerCase())
          return reply.redirect(`/channels/${encodeURIComponent(results.contracts[0].channel)}/contracts/${encodeURIComponent(results.contracts[0].chaincode)}`);
      }
      // Nothing: say why, when the query shows it.
      if (total === 0) {
        if (number !== undefined) {
          const newest = Math.max(-1, ...db.channels(s.visible).map((c) => c.height - 1));
          results.hint = newest < 0 ? "No blocks are indexed yet." : `No channel has a block #${number} yet. The newest is #${newest}.`;
        } else if (/^[0-9a-f]{1,5}$/i.test(query)) {
          results.hint = "To find a transaction, enter at least its first 6 characters.";
        }
      }
    }
    return send(reply, pages.searchPage(s.site, query, results));
  });

  /* Elections (phase 4) ------------------------------------------------ */

  /** The channel's election rows, when this viewer may see the ballot contract. */
  function electionData(request: FastifyRequest, channel: string) {
    const s = scope(request);
    const contract = policy.channels[channel]?.elections;
    if (!contract || !s.canSee(channel) || !s.canSeeContract(channel, contract)) return null;
    return { s, list: elections(db.contractRows(channel, contract).map(s.view)) };
  }

  app.get<{ Params: { channel: string } }>("/channels/:channel/elections", async (request, reply) => {
    const { channel } = request.params;
    const s = scope(request);
    if (s.canSeePrivate(channel)) {
      const main = electionData(request, channel);
      const ballotContract = main ? pages.electionsList(channel, main.list) : undefined;
      return send(reply, privatePages.privateElectionsPage(s.site, channel, electionList(db, policy, channel), ballotContract));
    }
    const data = electionData(request, channel);
    if (!data) {
      return notFound(reply, scope(request).site, { title: "Elections not found", heading: "This channel has no published elections", asked: asked(request), signIn: MEMBERS });
    }
    return send(reply, pages.electionsPage(data.s.site, request.params.channel, data.list));
  });

  app.get<{ Params: { channel: string; id: string }; Querystring: { tx?: string; commitment?: string; tracking?: string; before?: string } }>(
    "/channels/:channel/elections/:id",
    async (request, reply) => {
      const { channel, id } = request.params;
      const s = scope(request);
      const privateView = s.canSeePrivate(channel) ? electionView(db, policy, channel, id) : null;
      if (privateView) return send(reply, privateElectionPage(s.site, privateView, request.query));
      const data = electionData(request, channel);
      const election = data?.list.find((e) => e.id === id);
      if (!data || !election) {
        return notFound(reply, scope(request).site, { title: "Election not found", heading: "No published election has that ID", asked: asked(request), signIn: MEMBERS });
      }
      const txId = (request.query.tx ?? "").trim().toLowerCase();
      const receipt = txId
        ? { txId, commitment: request.query.commitment ?? "", result: checkReceipt(id, (() => { const t = db.transaction(channel, txId); return t ? data.s.view(t) : null; })()) }
        : null;
      return send(reply, pages.electionPage(data.s.site, channel, election, receipt));
    },
  );

  app.get<{ Params: { channel: string } }>("/api/v1/channels/:channel/elections", async (request, reply) => {
    const data = electionData(request, request.params.channel);
    return data ? data.list : reply.code(404).send({ error: "Nothing was found at this address." });
  });

  app.get<{ Params: { channel: string; id: string; txId: string } }>(
    "/api/v1/channels/:channel/elections/:id/receipts/:txId",
    async (request, reply) => {
      const { channel, id, txId } = request.params;
      const data = electionData(request, channel);
      if (!data || !data.list.some((e) => e.id === id)) return reply.code(404).send({ error: "Nothing was found at this address." });
      const tx = db.transaction(channel, txId.toLowerCase());
      return checkReceipt(id, tx ? data.s.view(tx) : null);
    },
  );

  /* Private elections (docs/adr/0007), with WEFT_EXPERIMENTAL=1 --------- */

  /** A private election's page: ?tracking= checks a tracking code and shows its ballot's page of the table; ?before= pages the table. */
  function privateElectionPage(site: pages.Site, view: NonNullable<ReturnType<typeof electionView>>, query: { tracking?: string; before?: string }): string {
    const { channel, id } = view;
    let tracking: privatePages.TrackingLookup | null = null;
    if (query.tracking !== undefined) {
      const code = query.tracking.trim();
      const error = code === "" ? "Enter the tracking code from your receipt." : /^[0-9a-f]{64}$/i.test(code) ? "" : "A tracking code is 64 characters, 0 to 9 and a to f.";
      tracking = { code, error, ballot: error ? null : db.privateBallot(channel, id, code.toLowerCase()) };
    }
    const position = /^(\d+)\.(\d+)$/.exec(query.before ?? "");
    let before: [number, number] | undefined = position ? [Number(position[1]), Number(position[2])] : undefined;
    // The ballot a tracking code found is on the page shown, marked as the voter's.
    const found = tracking?.ballot;
    if (!before && found && db.privateBallotsNewer(channel, id, found) >= BALLOT_PAGE) before = [found.block, found.index + 1];
    const rows = db.privateBallotPage(channel, id, { ...(before ? { before } : {}), limit: BALLOT_PAGE + 1 });
    const shown = rows.slice(0, BALLOT_PAGE);
    const url = privatePages.privateElectionUrl(channel, id);
    const at = (b: { block: number; index: number }) => `${url}?before=${b.block}.${b.index}#ballots`;
    let newer: string | null = null;
    if (before && shown[0]) {
      const ahead = db.privateBallotPage(channel, id, { after: [shown[0].block, shown[0].index], limit: BALLOT_PAGE + 1 });
      newer = ahead.length === 0 ? null : ahead.length <= BALLOT_PAGE ? `${url}#ballots` : at(ahead[BALLOT_PAGE]!);
    }
    const older = rows.length > BALLOT_PAGE ? at(shown.at(-1)!) : null;
    return privatePages.privateElectionPage(site, view, { rows: shown, newer, older }, tracking);
  }

  const nothing = (reply: FastifyReply) => reply.code(404).send({ error: "Nothing was found at this address." });

  app.get<{ Params: { channel: string } }>("/api/v1/channels/:channel/private-elections", async (request, reply) => {
    const { channel } = request.params;
    return scope(request).canSeePrivate(channel) ? electionList(db, policy, channel) : nothing(reply);
  });

  app.get<{ Params: { channel: string; id: string } }>("/api/v1/channels/:channel/private-elections/:id", async (request, reply) => {
    const { channel, id } = request.params;
    const view = scope(request).canSeePrivate(channel) ? electionView(db, policy, channel, id) : null;
    return view ?? nothing(reply);
  });

  // Every ballot, in ledger order, a page at a time: what the browser's full check reads.
  app.get<{ Params: { channel: string; id: string }; Querystring: { offset?: string; limit?: string } }>(
    "/api/v1/channels/:channel/private-elections/:id/ballots",
    async (request, reply) => {
      const { channel, id } = request.params;
      if (!scope(request).canSeePrivate(channel) || !db.privateElection(channel, id)) return nothing(reply);
      const offset = int(request.query.offset) ?? 0;
      const limit = Math.min(int(request.query.limit) ?? BALLOT_API_PAGE, BALLOT_API_PAGE);
      const { total } = db.privateBallotCount(channel, id);
      return { total, offset, ballots: db.privateBallots(channel, id, { offset, limit }).map((b, i) => publishedBallot(b, offset + i)) };
    },
  );

  // A tracking code, or a ballot's transaction ID, as the page's check finds it.
  app.get<{ Params: { channel: string; id: string; code: string } }>(
    "/api/v1/channels/:channel/private-elections/:id/tracking/:code",
    async (request, reply) => {
      const { channel, id, code } = request.params;
      const view = scope(request).canSeePrivate(channel) ? electionView(db, policy, channel, id) : null;
      if (!view) return nothing(reply);
      const b = /^[0-9a-f]{64}$/i.test(code) ? db.privateBallot(channel, id, code.toLowerCase()) : null;
      if (!b) return { found: false };
      return { found: true, inTotals: view.totals !== null, counted: view.tally !== null, ballot: publishedBallot(b, -1) };
    },
  );

  /* API: the same view as the pages, for whoever is asking ------------ */

  app.get("/api/v1/status", async (request) => {
    const s = scope(request);
    return {
      name: options.name,
      mspId: options.mspId ?? null,
      viewer: s.viewer ? { mspId: s.viewer.mspId, name: s.viewer.name } : null,
      channels: db.channels(s.visible).map((c) => {
        const st = statusOf(c.channel);
        const cp = policy.channels[c.channel]!;
        // What this explorer publishes, without naming hidden contracts.
        const publishes = {
          values: cp.values,
          submitter: cp.submitter,
          privateData: cp.privateData,
          membersOnly: Object.entries(cp.contracts).filter(([, l]) => l === "members").map(([name]) => name),
          elections: s.site.elections(c.channel),
          // Experimental: private elections, whose ballots' voter tags are published even when submitters aren't.
          ...(s.canSeePrivate(c.channel) ? { privateElections: true, voterTags: true } : {}),
        };
        return { ...c, level: channelLevel(policy, c.channel), publishes, peerHeight: st?.peerHeight ?? null, state: st?.state ?? "starting" };
      }),
    };
  });

  /*
   * Cross-checking (phase 3). The checkpoint is signed by this explorer's
   * identity and covers every block up to it, through the hash chain. A
   * members-only channel's checkpoint is for its members: signed-in people,
   * or other member organisations' explorers, which sign their requests.
   */
  app.get<{ Params: { channel: string } }>("/api/v1/channels/:channel/checkpoint", async (request, reply) => {
    const { channel } = request.params;
    if (!options.signer || !scope(request).canSee(channel)) return reply.code(404).send({ error: "Nothing was found at this address." });
    const top = db.nextBlock(channel) - 1;
    const hash = top >= 0 ? db.blockHash(channel, top) : null;
    if (hash === null) return reply.code(404).send({ error: "No blocks are indexed yet." });
    return reply.header("cache-control", "no-store").send(options.signer.sign(channel, top, hash));
  });

  app.get<{ Params: { channel: string } }>("/api/v1/channels/:channel/organisations", async (request, reply) => {
    if (!scope(request).canSee(request.params.channel)) return reply.code(404).send({ error: "Nothing was found at this address." });
    return options.crossCheck?.peersFor(request.params.channel) ?? [];
  });

  // For checking the chain elsewhere: headers alone, so anyone can recompute
  // each block's hash and its link to the one before.
  app.get<{ Params: { channel: string }; Querystring: { from?: string; to?: string } }>(
    "/api/v1/channels/:channel/headers",
    async (request, reply) => {
      if (!scope(request).canSee(request.params.channel)) return reply.code(404).send({ error: "Nothing was found at this address." });
      const from = int(request.query.from) ?? 0;
      const to = Math.min(int(request.query.to) ?? from + HEADERS - 1, from + HEADERS - 1);
      return db.headers(request.params.channel, from, to);
    },
  );

  // The members' CAs from the channel configuration, for checking whose
  // certificate signed a checkpoint.
  app.get<{ Params: { channel: string } }>("/api/v1/channels/:channel/members", async (request, reply) => {
    if (!scope(request).canSee(request.params.channel)) return reply.code(404).send({ error: "Nothing was found at this address." });
    return db.members(request.params.channel).map(({ mspId, rootCerts, intermediateCerts, crls }) => ({ mspId, rootCerts, intermediateCerts, crls: crls ?? [] }));
  });

  app.get<{ Params: { channel: string }; Querystring: { before?: string; limit?: string } }>(
    "/api/v1/channels/:channel/blocks",
    async (request, reply) => {
      if (!scope(request).canSee(request.params.channel)) return reply.code(404).send({ error: "Nothing was found at this address." });
      const limit = Math.min(int(request.query.limit) ?? PAGE, 100);
      return db.blocks(request.params.channel, { before: int(request.query.before), limit });
    },
  );

  app.get<{ Params: { channel: string; number: string } }>("/api/v1/channels/:channel/blocks/:number", async (request, reply) => {
    const s = scope(request);
    const number = int(request.params.number);
    const found = s.canSee(request.params.channel) && number !== undefined ? db.block(request.params.channel, number) : null;
    return found ? { block: found.block, transactions: found.transactions.map(s.view) } : reply.code(404).send({ error: "Nothing was found at this address." });
  });

  app.get<{ Params: { channel: string }; Querystring: { contract?: string; org?: string; before?: string; limit?: string } }>(
    "/api/v1/channels/:channel/transactions",
    async (request, reply) => {
      const s = scope(request);
      const { channel } = request.params;
      if (!s.canSee(channel)) return reply.code(404).send({ error: "Nothing was found at this address." });
      const q = request.query;
      if (q.contract && !s.canSeeContract(channel, q.contract)) return [];
      return db
        .transactions(s.visible, {
          channel,
          chaincode: q.contract,
          mspId: q.org,
          // Filtering by organisation mustn't reveal who submitted members-only transactions.
          publicOnly: !!q.org && !s.memberOf(channel),
          before: int(q.before),
          limit: Math.min(int(q.limit) ?? PAGE, 100),
        })
        .map(s.view);
    },
  );

  app.get<{ Params: { channel: string; txId: string } }>("/api/v1/channels/:channel/transactions/:txId", async (request, reply) => {
    const s = scope(request);
    const tx = s.canSee(request.params.channel) ? db.transaction(request.params.channel, request.params.txId) : null;
    return tx ? s.view(tx) : reply.code(404).send({ error: "Nothing was found at this address." });
  });

  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith("/api/")
      ? reply.code(404).send({ error: "Nothing was found at this address." })
      : notFound(reply, scope(request).site, {
          title: "Page not found",
          heading: "There's no page at this address",
          lead: ["The address may be mistyped, or the page may have moved."],
          asked: asked(request),
          search: true,
        }),
  );

  // Pages get a page when something goes wrong; the API gets JSON.
  onError = (error, request, reply) => {
    const code = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    // A peer that didn't answer says which and how; any other fault stays inside.
    const message = code === 503 ? (error.message ?? "Service unavailable") : code >= 500 ? "Internal error" : (error.message ?? "Bad request");
    if (code >= 500) request.log.error(error);
    if (request.url.startsWith("/api/") || request.url.startsWith("/auth/")) return reply.code(code).send({ error: message });
    let site: pages.Site;
    try {
      site = scope(request).site;
    } catch {
      site = { name: options.name, channels: [], viewer: null, signIn: false, peers: () => [], elections: () => false, products: options.products ?? PUBLIC_PRODUCTS, receiptOrigins: [] };
    }
    return send(reply, pages.errorPage(site, code, message, { method: request.method, path: request.url, address: asked(request).value, at: Date.now() }), code);
  };
  app.setErrorHandler((error: { statusCode?: number; message?: string }, request, reply) => onError(error, request, reply));

  return app;
}

export type { Viewer };
