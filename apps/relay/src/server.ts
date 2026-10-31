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
import Fastify, { type FastifyInstance } from "fastify";
import type { RelayConfig } from "./config.ts";
import type { GatewayPool } from "./gateways.ts";
import { INVITE_PATH } from "./invite.ts";

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

function parseSigner(value: unknown, allowed: string[] | undefined): RelaySigner {
  const s = (value ?? {}) as Partial<RelaySigner>;
  const signer = { mspId: str(s.mspId, "signer.mspId"), certificate: str(s.certificate, "signer.certificate") };
  if (!signer.certificate.includes("BEGIN CERTIFICATE")) throw new BadRequest('The "signer.certificate" field must be PEM.');
  if (allowed && !allowed.includes(signer.mspId)) {
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

export function buildServer(config: RelayConfig, pool: GatewayPool): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 1024 * 1024 });

  void app.register(cors, {
    origin: config.allowedOrigins === "*" ? true : config.allowedOrigins,
    methods: ["GET", "POST"],
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof BadRequest) {
      return reply.status(400).send(errorBody("bad_request", error));
    }
    const kind = request.url.replace(/^\/v1\//, "").replace(/\//g, "_");
    request.log.warn({ err: error }, "request failed");
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

  app.post<{ Body: RelayProposalRequest }>(RELAY_PATHS.proposals, async (request): Promise<RelayProposalResponse> => {
    const signer = parseSigner(request.body?.signer, config.allowedMspIds);
    const call = parseCall(request.body?.call);
    const contract = pool.get(signer).getNetwork(call.channel).getContract(call.chaincode, call.contract);
    const proposal = contract.newProposal(call.fn, {
      arguments: call.args ?? [],
      ...(call.transient ? { transientData: call.transient } : {}),
      ...(call.endorsingOrganizations ? { endorsingOrganizations: call.endorsingOrganizations } : {}),
    });
    return { proposal: b64(proposal.getBytes()), transactionId: proposal.getTransactionId() };
  });

  app.post<{ Body: RelaySignedProposal }>(RELAY_PATHS.evaluate, async (request): Promise<RelayEvaluateResponse> => {
    const signer = parseSigner(request.body?.signer, config.allowedMspIds);
    const proposal = pool
      .get(signer)
      .newSignedProposal(bytes(request.body.proposal, "proposal"), bytes(request.body.signature, "signature"));
    return { result: b64(await proposal.evaluate()) };
  });

  app.post<{ Body: RelaySignedProposal }>(RELAY_PATHS.endorse, async (request): Promise<RelayEndorseResponse> => {
    const signer = parseSigner(request.body?.signer, config.allowedMspIds);
    const proposal = pool
      .get(signer)
      .newSignedProposal(bytes(request.body.proposal, "proposal"), bytes(request.body.signature, "signature"));
    const transaction = await proposal.endorse();
    return {
      transaction: b64(transaction.getBytes()),
      transactionId: transaction.getTransactionId(),
      result: b64(transaction.getResult()),
    };
  });

  app.post<{ Body: RelaySignedTransaction }>(RELAY_PATHS.submit, async (request): Promise<RelaySubmitResponse> => {
    const signer = parseSigner(request.body?.signer, config.allowedMspIds);
    const transaction = pool
      .get(signer)
      .newSignedTransaction(bytes(request.body.transaction, "transaction"), bytes(request.body.signature, "signature"));
    const commit = await transaction.submit();
    return { commit: b64(commit.getBytes()) };
  });

  app.post<{ Body: RelaySignedCommit }>(
    RELAY_PATHS.commitStatus,
    async (request): Promise<RelayCommitStatusResponse> => {
      const signer = parseSigner(request.body?.signer, config.allowedMspIds);
      const commit = pool
        .get(signer)
        .newSignedCommit(bytes(request.body.commit, "commit"), bytes(request.body.signature, "signature"));
      const status = await commit.getStatus();
      return {
        transactionId: status.transactionId,
        blockNumber: status.blockNumber.toString(),
        status: STATUS_NAMES.get(status.code) ?? String(status.code),
        successful: status.successful,
      };
    },
  );

  return app;
}
