import { randomBytes } from "node:crypto";
import cors from "@fastify/cors";
import { GatewayError, StatusCode } from "@hyperledger/fabric-gateway";
import {
  RELAY_PATHS,
  type ContractCall,
  type RelayCommitStatusResponse,
  type RelayEndorseResponse,
  type RelayErrorResponse,
  type RelayEvaluateResponse,
  type RelayProposalRequest,
  type RelayProposalResponse,
  type RelaySignedCommit,
  type RelaySignedProposal,
  type RelaySignedTransaction,
  type RelaySigner,
  type RelaySubmitResponse,
} from "@weftwallet/protocol";
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { RelayConfig } from "./config.ts";
import type { GatewayPool, Lease } from "./gateways.ts";
import { INVITE_PATH } from "./invite.ts";
import { VOTER_INVITE_ROUTE, lateVoterInvite } from "./voter-invites.ts";

const STATUS_NAMES = new Map<number, string>(Object.entries(StatusCode).map(([name, code]) => [code as number, name]));

class BadRequest extends Error {}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function bytes(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0) throw new BadRequest(`The "${field}" field must be base64.`);
  return new Uint8Array(Buffer.from(value, "base64"));
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new BadRequest(`The "${field}" field is required.`);
  return value;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Reads the request's signer: an X.509 identity, or, on a relay started with
 * WEFT_EXPERIMENTAL=1, a one-off idemix identity from one of the voter MSPs
 * in WEFT_IDEMIX_MSP_IDS (docs/adr/0008). `x509` is called as soon as the
 * request is known to carry no idemix identity, so its request may be logged.
 * No message here repeats an idemix identity.
 */
function parseSigner(
  value: unknown,
  config: Pick<RelayConfig, "allowedMspIds" | "experimental" | "idemixMspIds">,
  x509: () => void = () => {},
): RelaySigner {
  const s = (value ?? {}) as Record<string, unknown>;
  const mspId = str(s.mspId, "signer.mspId");
  if (s.idemixIdentity !== undefined) {
    if (s.certificate !== undefined) throw new BadRequest('The signer has both "certificate" and "idemixIdentity". Give one.');
    if (!config.experimental) {
      throw new BadRequest("This relay doesn't accept idemix signers. A relay accepts them only when it's started with WEFT_EXPERIMENTAL=1, for Weft Experimental.");
    }
    if (!config.idemixMspIds.includes(mspId)) throw new BadRequest(`This relay doesn't accept idemix signers from ${mspId}.`);
    const identity = s.idemixIdentity;
    if (typeof identity !== "string" || identity.length === 0 || !BASE64.test(identity)) {
      throw new BadRequest('The "signer.idemixIdentity" field must be base64.');
    }
    return { mspId, idemixIdentity: identity };
  }
  x509();
  const signer = { mspId, certificate: str(s.certificate, "signer.certificate") };
  if (!signer.certificate.includes("BEGIN CERTIFICATE")) throw new BadRequest('The "signer.certificate" field must be PEM.');
  if (config.idemixMspIds.includes(mspId)) {
    throw new BadRequest(`This relay accepts only idemix signers from ${mspId}, the voter organisation of an election with voter credentials.`);
  }
  if (config.allowedMspIds && !config.allowedMspIds.includes(signer.mspId)) {
    throw new BadRequest(`This relay does not serve ${signer.mspId}.`);
  }
  return signer;
}

function parseCall(value: unknown): ContractCall {
  const c = (value ?? {}) as Partial<ContractCall>;
  const args = c.args ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    throw new BadRequest('The "call.args" field must be a list of strings.');
  }
  return {
    channel: str(c.channel, "call.channel"),
    chaincode: str(c.chaincode, "call.chaincode"),
    ...(c.contract ? { contract: str(c.contract, "call.contract") } : {}),
    fn: str(c.fn, "call.fn"),
    args,
    ...(c.transient ? { transient: c.transient } : {}),
    ...(c.endorsingOrganizations ? { endorsingOrganizations: c.endorsingOrganizations } : {}),
  };
}

function errorBody(kind: string, error: unknown): RelayErrorResponse {
  if (error instanceof GatewayError) {
    return {
      error: {
        kind,
        message: error.message,
        details: error.details.map((d) => ({ mspId: d.mspId, address: d.address, message: d.message })),
      },
    };
  }
  return { error: { kind, message: error instanceof Error ? error.message : String(error) } };
}

/**
 * Experimental (docs/adr/0008): the relay's request logging on a relay that
 * accepts idemix signers. The election's relay must keep no request logs for
 * voters' requests, and Fastify logs every request at info with its network
 * address before it has read the body, so before it can know who signed.
 *
 * On such a relay this controller writes no "incoming request" line at all.
 * Every request starts quiet, except a GET, which carries no signer; a POST
 * becomes loggable only once parseSigner has read its signer as an X.509 one.
 * A quiet request gets no log line of any kind from Fastify (completed,
 * errored, not found) or from this file's error handler: no network address,
 * no URL, no body and no identity. A loggable request gets one line when it
 * completes, with what Fastify's two lines would have held.
 */
class QuietLog extends LogController {
  private readonly quiet: WeakSet<FastifyRequest>;

  constructor(quiet: WeakSet<FastifyRequest>) {
    super();
    this.quiet = quiet;
  }

  override isLogDisabled(request: FastifyRequest): boolean {
    return this.quiet.has(request);
  }

  override incomingRequest(): void {}

  override requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply): void {
    if (this.isLogDisabled(request)) return;
    if (error) reply.log.error({ req: request, res: reply, err: error, responseTime: reply.elapsedTime }, "request errored");
    else reply.log.info({ req: request, res: reply, responseTime: reply.elapsedTime }, "request completed");
  }
}

export interface ServerOptions {
  /** Where the log goes, for tests. Standard output by default. */
  logStream?: { write(line: string): void };
}

export function buildServer(config: RelayConfig, pool: GatewayPool, options: ServerOptions = {}): FastifyInstance {
  const acceptsIdemix = config.experimental && config.idemixMspIds.length > 0;
  const quiet = new WeakSet<FastifyRequest>();
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info", ...(options.logStream ? { stream: options.logStream } : {}) },
    bodyLimit: 1024 * 1024,
    // A random request ID, not Fastify's counter, which would show how many unlogged requests came between two logged ones.
    ...(acceptsIdemix ? { logController: new QuietLog(quiet), genReqId: () => randomBytes(8).toString("hex") } : {}),
  });
  if (acceptsIdemix) {
    app.addHook("onRequest", async (request) => {
      if (request.method !== "GET") quiet.add(request);
    });
  }
  /** The request's signer; the request may be logged once it is known to be X.509. */
  const signerOf = (request: FastifyRequest<{ Body: { signer?: unknown } | undefined }>) =>
    parseSigner(request.body?.signer, config, () => quiet.delete(request));
  /** Runs `use` with a Gateway for the signer, and releases it when the request is done. */
  async function withGateway<T>(signer: RelaySigner, use: (lease: Lease) => Promise<T> | T): Promise<T> {
    const lease = pool.acquire(signer);
    try {
      return await use(lease);
    } finally {
      lease.release();
    }
  }

  void app.register(cors, {
    origin: config.allowedOrigins === "*" ? true : config.allowedOrigins,
    methods: ["GET", "POST"],
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof BadRequest) {
      return reply.status(400).send(errorBody("bad_request", error));
    }
    const kind = request.url.replace(/^\/v1\//, "").replace(/\//g, "_");
    if (!quiet.has(request)) request.log.warn({ err: error }, "request failed");
    const status = error instanceof GatewayError ? 502 : 500;
    return reply.status(status).send(errorBody(kind, error));
  });

  app.get(RELAY_PATHS.health, async () => ({ ok: true, peer: config.peerEndpoint }));

  // The organisation's invite. Public by design: it holds URLs and names, never secrets.
  app.get(INVITE_PATH, async (_request, reply) => {
    if (!config.invite) {
      return reply.status(404).send({ error: { kind: "not_found", message: "This relay does not publish an invite." } });
    }
    return reply.header("cache-control", "public, max-age=300").send(config.invite);
  });

  // Experimental (docs/adr/0008): the voter invites, one per election with voter credentials.
  app.get<{ Params: { file: string } }>(VOTER_INVITE_ROUTE, async (request, reply) => {
    const id = request.params.file.replace(/\.json$/, "");
    let invite = request.params.file.endsWith(".json") ? config.voterInvites.get(id) : undefined;
    if (!invite && request.params.file.endsWith(".json") && config.experimental) {
      try {
        invite = lateVoterInvite(config.voterInviteDir, id, config.voterInvites, config.idemixMspIds) ?? undefined;
        if (invite) request.log.info(`Voter invite for ${id}: read from WEFT_VOTER_INVITES, added after the relay started.`);
      } catch (error) {
        request.log.warn(`The voter invite for ${id} in WEFT_VOTER_INVITES fails its check, so the relay doesn't serve it: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!invite) {
      return reply.status(404).send({ error: { kind: "not_found", message: `This relay publishes no voter invite for ${id}.` } });
    }
    return reply.header("cache-control", "public, max-age=300").send(invite);
  });

  app.post<{ Body: RelayProposalRequest }>(RELAY_PATHS.proposals, async (request): Promise<RelayProposalResponse> => {
    const signer = signerOf(request);
    const call = parseCall(request.body?.call);
    return withGateway(signer, ({ gateway }) => {
      const contract = gateway.getNetwork(call.channel).getContract(call.chaincode, call.contract);
      const proposal = contract.newProposal(call.fn, {
        arguments: call.args ?? [],
        ...(call.transient ? { transientData: call.transient } : {}),
        ...(call.endorsingOrganizations ? { endorsingOrganizations: call.endorsingOrganizations } : {}),
      });
      return { proposal: b64(proposal.getBytes()), transactionId: proposal.getTransactionId() };
    });
  });

  app.post<{ Body: RelaySignedProposal }>(RELAY_PATHS.evaluate, async (request): Promise<RelayEvaluateResponse> => {
    const signer = signerOf(request);
    const proposalBytes = bytes(request.body.proposal, "proposal");
    const signature = bytes(request.body.signature, "signature");
    return withGateway(signer, async ({ gateway }) => ({ result: b64(await gateway.newSignedProposal(proposalBytes, signature).evaluate()) }));
  });

  app.post<{ Body: RelaySignedProposal }>(RELAY_PATHS.endorse, async (request): Promise<RelayEndorseResponse> => {
    const signer = signerOf(request);
    const proposalBytes = bytes(request.body.proposal, "proposal");
    const signature = bytes(request.body.signature, "signature");
    return withGateway(signer, async ({ gateway }) => {
      const transaction = await gateway.newSignedProposal(proposalBytes, signature).endorse();
      return {
        transaction: b64(transaction.getBytes()),
        transactionId: transaction.getTransactionId(),
        result: b64(transaction.getResult()),
      };
    });
  });

  app.post<{ Body: RelaySignedTransaction }>(RELAY_PATHS.submit, async (request): Promise<RelaySubmitResponse> => {
    const signer = signerOf(request);
    const transactionBytes = bytes(request.body.transaction, "transaction");
    const signature = bytes(request.body.signature, "signature");
    return withGateway(signer, async ({ gateway }) => {
      const commit = await gateway.newSignedTransaction(transactionBytes, signature).submit();
      return { commit: b64(commit.getBytes()) };
    });
  });

  app.post<{ Body: RelaySignedCommit }>(
    RELAY_PATHS.commitStatus,
    async (request): Promise<RelayCommitStatusResponse> => {
      const signer = signerOf(request);
      const commitBytes = bytes(request.body.commit, "commit");
      const signature = bytes(request.body.signature, "signature");
      return withGateway(signer, async ({ gateway }) => {
        const status = await gateway.newSignedCommit(commitBytes, signature).getStatus();
        return {
          transactionId: status.transactionId,
          blockNumber: status.blockNumber.toString(),
          status: STATUS_NAMES.get(status.code) ?? String(status.code),
          successful: status.successful,
        };
      });
    },
  );

  return app;
}
