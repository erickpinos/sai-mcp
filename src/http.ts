// Optional Streamable HTTP transport for sai-mcp.
//
// stdio is the default (see index.ts). When SAI_HTTP_PORT is set (or --http is
// passed on the command line) the server runs over HTTP instead, using the MCP
// Streamable HTTP transport with STATEFUL sessions: one McpServer plus one
// StreamableHTTPServerTransport per Mcp-Session-Id, created on the initialize
// request and torn down on DELETE / transport close.
//
// Security model: the write tools sign with the configured wallet's key, so an
// open HTTP port lets anyone trade with that wallet. Mitigations here:
//   - bind to 127.0.0.1 by default (override via SAI_HTTP_HOST),
//   - DNS-rebinding protection (allowedHosts = 127.0.0.1:PORT / localhost:PORT),
//   - optional bearer-token auth (SAI_HTTP_TOKEN), enforced on every request
//     whenever a signer is configured. If a signer is present but no token is
//     set, we print a loud startup warning that write tools are unauthenticated.

import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server.js";

// Cap the buffered request body to avoid a trivial memory-exhaustion vector on
// an exposed (or no-signer read-only) port.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// Ceiling on concurrent live sessions. Each session holds a McpServer + a
// transport, so without a cap a client that never sends DELETE could grow the
// map without bound. A legitimate client uses one session.
const MAX_SESSIONS = 128;

class PayloadTooLargeError extends Error {}

// Node lowercases incoming header names; a non-duplicated header is a string,
// but the type is string | string[] | undefined, so normalize to the first value.
function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function writeJsonError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  extraHeaders?: Record<string, string>,
): void {
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
  res.writeHead(status, { "Content-Type": "application/json", ...(extraHeaders ?? {}) });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      // Stop buffering (the memory cap is the point) but do NOT destroy the
      // socket: the caller still needs to send a 413 on it. It drains the rest.
      throw new PayloadTooLargeError();
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Start the MCP server over Streamable HTTP on host:port. Resolves once the
 * listener is bound; the returned process keeps running to serve requests.
 */
export function startHttpServer(port: number, host: string): Promise<void> {
  // A signer is what makes the write tools live; without one the server is
  // read-only and bearer auth is not enforced.
  const signerConfigured = !!(process.env.SAI_MNEMONIC || process.env.SAI_PRIVATE_KEY);
  const httpToken = process.env.SAI_HTTP_TOKEN;
  const authRequired = signerConfigured && !!httpToken;

  if (signerConfigured && !httpToken) {
    // Loud, multi-line warning: a signer is loaded but the HTTP port has no
    // auth, so anyone who can reach it can sign trades with this wallet.
    console.error("");
    console.error("========================================================================");
    console.error("  WARNING: sai-mcp is serving WRITE TOOLS over HTTP WITHOUT authentication.");
    console.error(`  A signer is configured and the port (${host}:${port}) accepts requests`);
    console.error("  with no bearer token, so anyone who can reach it can sign and broadcast");
    console.error("  trades with this wallet.");
    console.error("");
    console.error("  Fix one of:");
    console.error("    - set SAI_HTTP_TOKEN=<secret> and send Authorization: Bearer <secret>, or");
    console.error("    - unset SAI_MNEMONIC / SAI_PRIVATE_KEY to run read-only over HTTP, or");
    console.error("    - use the default stdio transport (drop SAI_HTTP_PORT / --http).");
    console.error("========================================================================");
    console.error("");
  }

  if (!signerConfigured && httpToken) {
    // A token without a signer is inert: there is nothing to protect (read-only
    // mode), so we serve reads to anyone. Say so rather than letting the
    // operator assume the token is gating access.
    console.error(
      "sai-mcp: SAI_HTTP_TOKEN is set but no signer is configured; the token is not enforced and HTTP reads are unauthenticated (read-only mode).",
    );
  }

  // One transport per live session, keyed by the server-issued Mcp-Session-Id.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // Host values the DNS-rebinding guard accepts. The Host header for a request
  // to 127.0.0.1:PORT is exactly "127.0.0.1:PORT", so it must include the port.
  // For a non-local bind (e.g. SAI_HTTP_HOST=0.0.0.0 behind a proxy) the public
  // host[:port] values can be added via SAI_HTTP_ALLOWED_HOSTS (comma-separated).
  const extraHosts = (process.env.SAI_HTTP_ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const allowedHosts = Array.from(
    new Set([
      `${host}:${port}`,
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      ...extraHosts,
    ]),
  );

  // Constant-time bearer check: plain === short-circuits on the first differing
  // char and on length, leaking match timing. timingSafeEqual avoids that, which
  // matters when the port is fronted by a proxy and the bearer is the only
  // credential.
  const expectedAuth = httpToken ? `Bearer ${httpToken}` : undefined;
  function isAuthorized(req: IncomingMessage): boolean {
    if (!authRequired || !expectedAuth) return true;
    const provided = headerValue(req.headers["authorization"]);
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expectedAuth);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Bearer gate first, on every method, when a signer + token are configured.
      if (!isAuthorized(req)) {
        writeJsonError(res, 401, -32001, "Unauthorized: missing or invalid bearer token", {
          "WWW-Authenticate": 'Bearer realm="sai-mcp"',
        });
        return;
      }

      const sessionId = headerValue(req.headers["mcp-session-id"]);

      if (req.method === "POST") {
        let raw: string;
        try {
          raw = await readBody(req);
        } catch (e) {
          if (e instanceof PayloadTooLargeError) {
            // Drain and discard the rest of the oversized upload so the socket
            // closes cleanly with the 413 (rather than resetting the client),
            // while never buffering past the cap.
            req.on("error", () => {});
            req.resume();
            // Connection: close - we rejected a partial upload, so do not return
            // the socket to the keep-alive pool (a reused socket can reset).
            writeJsonError(res, 413, -32000, `Payload too large (max ${MAX_BODY_BYTES} bytes)`, {
              Connection: "close",
            });
            return;
          }
          throw e;
        }
        let body: unknown;
        try {
          body = raw.length ? JSON.parse(raw) : undefined;
        } catch {
          writeJsonError(res, 400, -32700, "Parse error: request body is not valid JSON");
          return;
        }

        // Route to an existing session.
        const existing = sessionId ? transports.get(sessionId) : undefined;
        if (existing) {
          await existing.handleRequest(req, res, body);
          return;
        }

        // A fresh session only starts on an initialize request with no session id.
        if (!sessionId && isInitializeRequest(body)) {
          if (transports.size >= MAX_SESSIONS) {
            writeJsonError(res, 429, -32000, "Too many active sessions; try again later");
            return;
          }
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              transports.set(id, transport);
            },
            enableDnsRebindingProtection: true,
            allowedHosts,
          });
          // DELETE and shutdown both close the transport; drop it from the map.
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
          };
          const server = createServer();
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        writeJsonError(res, 400, -32000, "Bad Request: no valid session ID provided");
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        // GET opens the server->client SSE stream; DELETE terminates the session.
        // Both require a known session id.
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          writeJsonError(res, 400, -32000, "Bad Request: invalid or missing session ID");
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      writeJsonError(res, 405, -32000, "Method not allowed", { Allow: "GET, POST, DELETE" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("sai-mcp http handler error:", message);
      if (!res.headersSent) {
        writeJsonError(res, 500, -32603, "Internal server error");
      } else {
        res.end();
      }
    }
  });

  return new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => {
      console.error(`sai-mcp server running on http://${host}:${port}/ (streamable http)`);
      if (authRequired) {
        console.error("sai-mcp http auth: bearer token required (SAI_HTTP_TOKEN)");
      }
      resolve();
    });
  });
}
