import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { ExplorerDb } from "./db.ts";
import type { ChannelStatus } from "./indexer.ts";
import * as pages from "./pages.ts";

export interface ServerOptions {
  name: string;
  channels: string[];
  db: ExplorerDb;
  status: () => ChannelStatus[];
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
  "explorer.css": { type: "text/css; charset=utf-8", body: () => asset("explorer.css") },
  "mark.svg": { type: "image/svg+xml", body: () => asset("mark.svg") },
  "fonts/sans-400.woff2": { type: "font/woff2", body: () => font("@fontsource/ibm-plex-sans", "ibm-plex-sans-latin-400-normal.woff2") },
  "fonts/sans-500.woff2": { type: "font/woff2", body: () => font("@fontsource/ibm-plex-sans", "ibm-plex-sans-latin-500-normal.woff2") },
  "fonts/sans-600.woff2": { type: "font/woff2", body: () => font("@fontsource/ibm-plex-sans", "ibm-plex-sans-latin-600-normal.woff2") },
  "fonts/mono-400.woff2": { type: "font/woff2", body: () => font("@fontsource/ibm-plex-mono", "ibm-plex-mono-latin-400-normal.woff2") },
};

const PAGE = 20;

function int(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const { db, channels } = options;
  const site: pages.Site = { name: options.name, channels };
  const app = Fastify({ logger: options.logger ?? false });
  const published = (channel: string) => channels.includes(channel);
  const statusOf = (channel: string) => options.status().find((s) => s.channel === channel);

  const send = (reply: FastifyReply, body: string, code = 200) =>
    reply.code(code).header("content-type", "text/html; charset=utf-8").header("cache-control", "no-cache").send(body);
  const notFound = (reply: FastifyReply, what: string) => send(reply, pages.notFoundPage(site, what), 404);

  // Published data is public by definition, so other sites and other
  // organisations' explorers may read the API.
  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/api/")) reply.header("access-control-allow-origin", "*");
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

  /* Pages ------------------------------------------------------------ */

  app.get("/", async (_request, reply) => {
    const latest = channels.flatMap((c) => db.blocks(c, { limit: 8 })).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)).slice(0, 8);
    return send(reply, pages.homePage(site, db.channels(channels), options.status(), latest, db.transactions(channels, { limit: 8 })));
  });

  app.get<{ Params: { channel: string }; Querystring: { before?: string } }>("/channels/:channel", async (request, reply) => {
    const { channel } = request.params;
    if (!published(channel)) return notFound(reply, "That channel isn't published here.");
    const [summary] = db.channels([channel]);
    const blocks = db.blocks(channel, { before: int(request.query.before), limit: PAGE });
    return send(reply, pages.channelPage(site, summary!, statusOf(channel), blocks, db.contracts(channel)));
  });

  app.get<{ Params: { channel: string; number: string } }>("/channels/:channel/blocks/:number", async (request, reply) => {
    const { channel } = request.params;
    const number = int(request.params.number);
    const found = published(channel) && number !== undefined ? db.block(channel, number) : null;
    if (!found) return notFound(reply, "That block isn't here. It may not be indexed yet.");
    const hasNext = db.block(channel, number! + 1) !== null;
    return send(reply, pages.blockPage(site, found.block, found.transactions, hasNext));
  });

  app.get<{ Params: { channel: string; txId: string } }>("/channels/:channel/transactions/:txId", async (request, reply) => {
    const { channel, txId } = request.params;
    const tx = published(channel) ? db.transaction(channel, txId) : null;
    if (!tx) return notFound(reply, "No published transaction has that ID.");
    return send(reply, pages.transactionPage(site, tx));
  });

  app.get<{ Params: { channel: string; name: string }; Querystring: { before?: string } }>(
    "/channels/:channel/contracts/:name",
    async (request, reply) => {
      const { channel, name } = request.params;
      if (!published(channel)) return notFound(reply, "That channel isn't published here.");
      const before = int(request.query.before);
      const txs = db.transactions(channels, { channel, chaincode: name, before, limit: 50 });
      if (txs.length === 0 && before === undefined) return notFound(reply, "No published transactions call that contract.");
      return send(reply, pages.contractPage(site, channel, name, txs, before));
    },
  );

  app.get<{ Querystring: { q?: string } }>("/search", async (request, reply) => {
    const query = (request.query.q ?? "").trim();
    const results = { blocks: [] as ReturnType<typeof db.blocks>, txs: [] as ReturnType<typeof db.transactions>, contracts: [] as { channel: string; chaincode: string }[] };
    if (query) {
      const number = int(query.replace(/^#/, ""));
      if (number !== undefined) {
        for (const c of channels) {
          const found = db.block(c, number);
          if (found) results.blocks.push(found.block);
        }
      }
      if (/^[0-9a-f]{6,64}$/i.test(query)) results.txs = db.findTransactions(channels, query.toLowerCase());
      for (const c of channels) {
        for (const contract of db.contracts(c)) {
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
    return send(reply, pages.searchPage(site, query, results));
  });

  /* API -------------------------------------------------------------- */

  app.get("/api/v1/status", async () => ({
    name: options.name,
    channels: db.channels(channels).map((c) => {
      const s = statusOf(c.channel);
      return { ...c, peerHeight: s?.peerHeight ?? null, state: s?.state ?? "starting" };
    }),
  }));

  app.get<{ Params: { channel: string }; Querystring: { before?: string; limit?: string } }>(
    "/api/v1/channels/:channel/blocks",
    async (request, reply) => {
      if (!published(request.params.channel)) return reply.code(404).send({ error: "not published" });
      const limit = Math.min(int(request.query.limit) ?? PAGE, 100);
      return db.blocks(request.params.channel, { before: int(request.query.before), limit });
    },
  );

  app.get<{ Params: { channel: string; number: string } }>("/api/v1/channels/:channel/blocks/:number", async (request, reply) => {
    const number = int(request.params.number);
    const found = published(request.params.channel) && number !== undefined ? db.block(request.params.channel, number) : null;
    return found ?? reply.code(404).send({ error: "not found" });
  });

  app.get<{ Params: { channel: string }; Querystring: { contract?: string; org?: string; before?: string; limit?: string } }>(
    "/api/v1/channels/:channel/transactions",
    async (request, reply) => {
      const { channel } = request.params;
      if (!published(channel)) return reply.code(404).send({ error: "not published" });
      const q = request.query;
      return db.transactions(channels, {
        channel,
        chaincode: q.contract,
        mspId: q.org,
        before: int(q.before),
        limit: Math.min(int(q.limit) ?? PAGE, 100),
      });
    },
  );

  app.get<{ Params: { channel: string; txId: string } }>("/api/v1/channels/:channel/transactions/:txId", async (request, reply) => {
    const tx = published(request.params.channel) ? db.transaction(request.params.channel, request.params.txId) : null;
    return tx ?? reply.code(404).send({ error: "not found" });
  });

  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith("/api/") ? reply.code(404).send({ error: "not found" }) : notFound(reply, "There's no page here."),
  );

  return app;
}
