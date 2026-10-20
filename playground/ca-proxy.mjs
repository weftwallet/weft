#!/usr/bin/env node
/**
 * HTTPS proxy in front of a local Fabric CA.
 *
 * The test network's CA serves TLS with a certificate browsers don't trust, so
 * the Weft extension can't enrol against it directly. This proxy serves a
 * certificate your machine trusts (made with mkcert) and forwards to the CA,
 * verifying it against the CA root certificate (ca-cert.pem, the file
 * fabric-ca-client uses as --tls.certfiles). It also adds CORS headers.
 *
 * For local development only.
 *
 *   node ca-proxy.mjs --listen 7443 --target https://localhost:7054 \
 *     --cert localhost.pem --key localhost-key.pem --upstream-ca ca-cert.pem
 */
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    listen: { type: "string", default: "7443" },
    target: { type: "string", default: "https://localhost:7054" },
    cert: { type: "string" },
    key: { type: "string" },
    "upstream-ca": { type: "string" },
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

function handle(req, res) {
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

server.listen(Number(values.listen), () => {
  const scheme = values.cert ? "https" : "http";
  console.log(`CA proxy ${scheme}://localhost:${values.listen} -> ${target.href}`);
});
