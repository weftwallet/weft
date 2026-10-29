import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { SignInError } from "@weftwallet/core";
import { Auth, SESSION_COOKIE, type Viewer } from "./auth.ts";
import type { ExplorerDb, TransactionRow } from "./db.ts";
import type { ChannelStatus } from "./indexer.ts";
import * as pages from "./pages.ts";
import { channelLevel, contractLevel, viewTransaction, type Policy } from "./policy.ts";
import type { CheckpointSigner, CrossCheck } from "./checkpoints.ts";
import { requesterIsMember, verifyExplorerRequest } from "./checkpoints.ts";
import { checkReceipt, elections } from "./elections.ts";

export interface ServerOptions {
  name: string;
  /** The organisation running this explorer, e.g. Org1MSP. */
  mspId?: string;
  /** Indexed channels (public and members). */
  channels: string[];
  policy: Policy;
  db: ExplorerDb;
  status: () => ChannelStatus[];
  auth?: Auth;
  /** This explorer's public origin, e.g. https://explorer.org1.example. Sign-in messages must name it. */
  publicUrl?: string;
  /** Signs this explorer's checkpoints for other organisations to compare. */
  signer?: CheckpointSigner;
  /** The other organisations' explorers, polled for their checkpoints. */
  crossCheck?: CrossCheck;
  /** The network page that block pages link to. */
  networkPage?: string;
  logger?: boolean;
}

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
  "explorer.css": { type: "text/css; charset=utf-8", body: () => asset("explorer.css") },
  "mark.svg": { type: "image/svg+xml", body: () => readFileSync(require.resolve("@weftwallet/brand/logo/products/explorer-small.svg")) },
  // The explorer's loader, and Weft's, for signing in: it's Weft that signs.
  "loader.svg": { type: "image/svg+xml", body: () => readFileSync(require.resolve("@weftwallet/brand/logo/loaders/explorer.svg")) },
  "loader-weft.svg": { type: "image/svg+xml", body: () => readFileSync(require.resolve("@weftwallet/brand/logo/loaders/weft.svg")) },
  "fonts/sans-400.woff2": { type: "font/woff2", body: () => font("@fontsource/atkinson-hyperlegible-next", "atkinson-hyperlegible-next-latin-400-normal.woff2") },
  "fonts/sans-500.woff2": { type: "font/woff2", body: () => font("@fontsource/atkinson-hyperlegible-next", "atkinson-hyperlegible-next-latin-500-normal.woff2") },
  "fonts/sans-600.woff2": { type: "font/woff2", body: () => font("@fontsource/atkinson-hyperlegible-next", "atkinson-hyperlegible-next-latin-600-normal.woff2") },
  "fonts/mono-400.woff2": { type: "font/woff2", body: () => font("@fontsource/atkinson-hyperlegible-mono", "atkinson-hyperlegible-mono-latin-400-normal.woff2") },
  "fonts/mono-500.woff2": { type: "font/woff2", body: () => font("@fontsource/atkinson-hyperlegible-mono", "atkinson-hyperlegible-mono-latin-500-normal.woff2") },
};

const PAGE = 20;
/** Most headers one request returns. */
const HEADERS = 1000;

function int(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const { db, channels, policy } = options;
  const auth = options.auth ?? new Auth();
  const app = Fastify({ logger: options.logger ?? false });
  // Requests are logged only when something goes wrong: the pages poll, and
  // other explorers check in every few seconds.
  app.addHook("onRoute", (route) => {
    route.logLevel = "warn";
  });
  const statusOf = (channel: string) => options.status().find((s) => s.channel === channel);
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
      elections: (channel) => {
        const contract = policy.channels[channel]?.elections;
        return !!contract && visible.includes(channel) && canSeeContract(channel, contract);
      },
    };
    return { viewer, memberOf, visible, canSee, canSeeContract, view, site };
  }

  const send = (reply: FastifyReply, body: string, code = 200) =>
    reply.code(code).header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store").send(body);
  const notFound = (reply: FastifyReply, site: pages.Site, what: string) => send(reply, pages.notFoundPage(site, what), 404);

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
      reply.header("content-security-policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'");
    }
  });

  app.get<{ Params: { "*": string } }>("/assets/*", async (request, reply) => {
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
      const message = error instanceof SignInError ? error.message : "That sign-in couldn't be checked.";
      return reply.code(401).send({ error: message });
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
      const message = error instanceof SignInError ? error.message : "That sign-in couldn't be checked.";
      return reply.code(401).send({ error: message });
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
    if (!s.viewer) return reply.redirect("/", 303);
    const txs = s.viewer.name ? db.transactions(s.visible, { mspId: s.viewer.mspId, creatorName: s.viewer.name, limit: 50 }).map(s.view) : [];
    return send(reply, pages.mePage(s.site, s.viewer, txs));
  });

  app.get<{ Params: { channel: string }; Querystring: { before?: string } }>("/channels/:channel", async (request, reply) => {
    const s = scope(request);
    const { channel } = request.params;
    if (!s.canSee(channel)) return notFound(reply, s.site, "That channel isn't published here, or only its members can see it.");
    const [summary] = db.channels([channel]);
    const blocks = db.blocks(channel, { before: int(request.query.before), limit: PAGE });
    return send(reply, pages.channelPage(s.site, summary!, statusOf(channel), blocks, db.contracts(channel, s.memberOf(channel))));
  });

  app.get<{ Params: { channel: string; number: string } }>("/channels/:channel/blocks/:number", async (request, reply) => {
    const s = scope(request);
    const { channel } = request.params;
    const number = int(request.params.number);
    const found = s.canSee(channel) && number !== undefined ? db.block(channel, number) : null;
    if (!found) return notFound(reply, s.site, "That block isn't here. It may not be indexed yet.");
    const hasNext = db.block(channel, number! + 1) !== null;
    return send(reply, pages.blockPage(s.site, found.block, found.transactions.map(s.view), hasNext));
  });

  app.get<{ Params: { channel: string; txId: string } }>("/channels/:channel/transactions/:txId", async (request, reply) => {
    const s = scope(request);
    const { channel, txId } = request.params;
    const tx = s.canSee(channel) ? db.transaction(channel, txId) : null;
    if (!tx) return notFound(reply, s.site, "No published transaction has that ID.");
    return send(reply, pages.transactionPage(s.site, s.view(tx)));
  });

  app.get<{ Params: { channel: string; name: string }; Querystring: { before?: string } }>(
    "/channels/:channel/contracts/:name",
    async (request, reply) => {
      const s = scope(request);
      const { channel, name } = request.params;
      if (!s.canSee(channel) || !s.canSeeContract(channel, name)) return notFound(reply, s.site, "No published transactions call that contract.");
      const before = int(request.query.before);
      const txs = db.transactions(s.visible, { channel, chaincode: name, before, limit: 50 }).map(s.view);
      if (txs.length === 0 && before === undefined) return notFound(reply, s.site, "No published transactions call that contract.");
      return send(reply, pages.contractPage(s.site, channel, name, txs, before));
    },
  );

  app.get<{ Querystring: { q?: string } }>("/search", async (request, reply) => {
    const s = scope(request);
    const query = (request.query.q ?? "").trim();
    const results = { blocks: [] as ReturnType<typeof db.blocks>, txs: [] as TransactionRow[], contracts: [] as { channel: string; chaincode: string }[] };
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
    const data = electionData(request, request.params.channel);
    if (!data) return notFound(reply, scope(request).site, "This channel has no published elections.");
    return send(reply, pages.electionsPage(data.s.site, request.params.channel, data.list));
  });

  app.get<{ Params: { channel: string; id: string }; Querystring: { tx?: string; commitment?: string } }>(
    "/channels/:channel/elections/:id",
    async (request, reply) => {
      const { channel, id } = request.params;
      const data = electionData(request, channel);
      const election = data?.list.find((e) => e.id === id);
      if (!data || !election) return notFound(reply, scope(request).site, "No published election has that ID.");
      const txId = (request.query.tx ?? "").trim().toLowerCase();
      const receipt = txId
        ? { txId, commitment: request.query.commitment ?? "", result: checkReceipt(id, (() => { const t = db.transaction(channel, txId); return t ? data.s.view(t) : null; })()) }
        : null;
      return send(reply, pages.electionPage(data.s.site, channel, election, receipt));
    },
  );

  app.get<{ Params: { channel: string } }>("/api/v1/channels/:channel/elections", async (request, reply) => {
    const data = electionData(request, request.params.channel);
    return data ? data.list : reply.code(404).send({ error: "not found" });
  });

  app.get<{ Params: { channel: string; id: string; txId: string } }>(
    "/api/v1/channels/:channel/elections/:id/receipts/:txId",
    async (request, reply) => {
      const { channel, id, txId } = request.params;
      const data = electionData(request, channel);
      if (!data || !data.list.some((e) => e.id === id)) return reply.code(404).send({ error: "not found" });
      const tx = db.transaction(channel, txId.toLowerCase());
      return checkReceipt(id, tx ? data.s.view(tx) : null);
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
    if (!options.signer || !scope(request).canSee(channel)) return reply.code(404).send({ error: "not found" });
    const top = db.nextBlock(channel) - 1;
    const hash = top >= 0 ? db.blockHash(channel, top) : null;
    if (hash === null) return reply.code(404).send({ error: "no blocks indexed yet" });
    return reply.header("cache-control", "no-store").send(options.signer.sign(channel, top, hash));
  });

  app.get<{ Params: { channel: string } }>("/api/v1/channels/:channel/organisations", async (request, reply) => {
    if (!scope(request).canSee(request.params.channel)) return reply.code(404).send({ error: "not found" });
    return options.crossCheck?.peersFor(request.params.channel) ?? [];
  });

  // For checking the chain elsewhere: headers alone, so anyone can recompute
  // each block's hash and its link to the one before.
  app.get<{ Params: { channel: string }; Querystring: { from?: string; to?: string } }>(
    "/api/v1/channels/:channel/headers",
    async (request, reply) => {
      if (!scope(request).canSee(request.params.channel)) return reply.code(404).send({ error: "not found" });
      const from = int(request.query.from) ?? 0;
      const to = Math.min(int(request.query.to) ?? from + HEADERS - 1, from + HEADERS - 1);
      return db.headers(request.params.channel, from, to);
    },
  );

  // The members' CAs from the channel configuration, for checking whose
  // certificate signed a checkpoint.
  app.get<{ Params: { channel: string } }>("/api/v1/channels/:channel/members", async (request, reply) => {
    if (!scope(request).canSee(request.params.channel)) return reply.code(404).send({ error: "not found" });
    return db.members(request.params.channel).map(({ mspId, rootCerts, intermediateCerts, crls }) => ({ mspId, rootCerts, intermediateCerts, crls: crls ?? [] }));
  });

  app.get<{ Params: { channel: string }; Querystring: { before?: string; limit?: string } }>(
    "/api/v1/channels/:channel/blocks",
    async (request, reply) => {
      if (!scope(request).canSee(request.params.channel)) return reply.code(404).send({ error: "not found" });
      const limit = Math.min(int(request.query.limit) ?? PAGE, 100);
      return db.blocks(request.params.channel, { before: int(request.query.before), limit });
    },
  );

  app.get<{ Params: { channel: string; number: string } }>("/api/v1/channels/:channel/blocks/:number", async (request, reply) => {
    const s = scope(request);
    const number = int(request.params.number);
    const found = s.canSee(request.params.channel) && number !== undefined ? db.block(request.params.channel, number) : null;
    return found ? { block: found.block, transactions: found.transactions.map(s.view) } : reply.code(404).send({ error: "not found" });
  });

  app.get<{ Params: { channel: string }; Querystring: { contract?: string; org?: string; before?: string; limit?: string } }>(
    "/api/v1/channels/:channel/transactions",
    async (request, reply) => {
      const s = scope(request);
      const { channel } = request.params;
      if (!s.canSee(channel)) return reply.code(404).send({ error: "not found" });
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
    return tx ? s.view(tx) : reply.code(404).send({ error: "not found" });
  });

  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith("/api/") ? reply.code(404).send({ error: "not found" }) : notFound(reply, scope(request).site, "There's no page here."),
  );

  return app;
}

export type { Viewer };
