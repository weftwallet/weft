#!/usr/bin/env node
/**
 * Proxy in front of a local Fabric CA.
 *
 * The test network's CA serves HTTPS with a self-signed certificate. Browsers
 * reject it, and accepting it in a tab doesn't help: the Weft extension's
 * background worker still refuses it. This proxy talks HTTPS to the CA,
 * verifying it against the CA root (ca-cert.pem, the file fabric-ca-client
 * uses as --tls.certfiles), and serves plain HTTP on localhost, which
 * browsers allow. It also adds CORS headers.
 *
 * For local development. To serve HTTPS (for example when hosting), pass --cert and
 * --key for a certificate browsers trust.
 *
 *   node ca-proxy.mjs --listen 7080 --target https://localhost:7054 --upstream-ca ca-cert.pem
 *
 * Experimental (docs/adr/0008): with --voters-only, the proxy in front of an
 * election's voters' CA passes two requests and refuses every other:
 * GET /api/v1/cainfo, and POST /api/v1/idemix/credential with basic
 * authorisation. Fabric CA also issues idemix credentials to a token signed
 * with an X.509 enrolment certificate, and doesn't count those against
 * maxenrollments, so a voter who could reach /api/v1/enroll, or send a
 * token, could get more than one credential and vote more than once. The CA's
 * own port stays open for the organisers' registrations.
 *
 *   node ca-proxy.mjs --listen 7081 --target https://localhost:7058 --upstream-ca ca-cert.pem --voters-only
 */
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    listen: { type: "string", default: "7080" },
    target: { type: "string", default: "https://localhost:7054" },
    cert: { type: "string" },
    key: { type: "string" },
    "upstream-ca": { type: "string" },
    "voters-only": { type: "boolean", default: false },
  },
});

const target = new URL(values.target);
const upstreamCa = values["upstream-ca"] ? readFileSync(values["upstream-ca"]) : undefined;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "600",
};

/** The requests a voters' CA proxy passes: method and path, and whether basic authorisation is required. */
const VOTERS_ALLOW = [
  { method: "GET", path: "/api/v1/cainfo", basic: false },
  { method: "POST", path: "/api/v1/idemix/credential", basic: true },
];
const VOTERS_RULE = "this proxy for a voters' CA passes only GET /api/v1/cainfo, and POST /api/v1/idemix/credential with basic authorisation";

/** Why the voters' CA proxy refuses the request, or null when it passes it. A preflight is checked for the request it announces. */
function refusal(req) {
  const path = new URL(req.url ?? "/", "http://proxy").pathname;
  const preflight = req.method === "OPTIONS";
  const method = preflight ? String(req.headers["access-control-request-method"] ?? "").toUpperCase() : req.method;
  const rule = VOTERS_ALLOW.find((r) => r.method === method && r.path === path);
  if (!rule) return `Refused ${method || req.method} ${path}: ${VOTERS_RULE}.`;
  if (rule.basic && !preflight && !/^Basic [A-Za-z0-9+/]+=*$/.test(String(req.headers.authorization ?? ""))) {
    return `Refused ${method} ${path} without basic authorisation: ${VOTERS_RULE}. Send the enrolment ID and secret.`;
  }
  return null;
}

function handle(req, res) {
  if (values["voters-only"]) {
    const refused = refusal(req);
    if (refused) {
      res.writeHead(403, { ...CORS, "content-type": "application/json" });
      // Fabric CA's own error shape, so fabric-ca-client and Weft show the message.
      res.end(JSON.stringify({ success: false, result: null, errors: [{ code: 403, message: refused }], messages: [] }));
      return;
    }
    // Forward the path as checked, not as sent, so no other spelling of a path reaches the CA.
    const url = new URL(req.url ?? "/", "http://proxy");
    req.url = `${url.pathname}${url.search}`;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = send(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: target.host },
      // Verify the chain against the CA's own TLS root, but don't insist the
      // certificate names "localhost": test-network CA certs vary there.
      ...(upstreamCa ? { ca: upstreamCa, checkServerIdentity: () => undefined } : {}),
    },
    (up) => {
      const headers = { ...up.headers, ...CORS };
      res.writeHead(up.statusCode ?? 502, headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    res.writeHead(502, { ...CORS, "content-type": "application/json" });
    res.end(JSON.stringify({ success: false, errors: [{ code: 0, message: `CA unreachable: ${error.message}` }] }));
  });
  req.pipe(upstream);
}

const server =
  values.cert && values.key
    ? createHttpsServer({ cert: readFileSync(values.cert), key: readFileSync(values.key) }, handle)
    : createHttpServer(handle);

server.on("error", (error) => {
  const why = error.code === "EADDRINUSE" ? "the port is in use" : error.message;
  console.error(`The CA proxy couldn't listen on ${values.listen}: ${why}.`);
  process.exit(1);
});

server.listen(Number(values.listen), () => {
  const scheme = values.cert ? "https" : "http";
  const mode = values["voters-only"] ? `, voters only: ${VOTERS_RULE.replace(/^this proxy for a voters' CA passes /, "")}` : "";
  console.log(`CA proxy ${scheme}://localhost:${values.listen} -> ${target.href}${mode}`);
});
