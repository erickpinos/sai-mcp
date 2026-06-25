#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startHttpServer } from "./http.js";

// Resolve the HTTP port from --http [port] or SAI_HTTP_PORT. Returns undefined
// when neither is set, in which case the server runs over stdio (the default).
// When HTTP is requested but the port value is malformed, we warn (naming the
// bad value) and fall back to 3000 rather than silently binding an unexpected
// port.
function resolveHttpPort(): number | undefined {
  const argv = process.argv.slice(2);
  const flagIdx = argv.indexOf("--http");
  let flagPort: number | undefined;
  let httpEnabled = false;
  if (flagIdx !== -1) {
    httpEnabled = true;
    const next = argv[flagIdx + 1];
    if (next && !next.startsWith("-")) {
      if (isValidPort(next)) flagPort = Number(next);
      else console.error(`sai-mcp: ignoring invalid --http port "${next}", using 3000`);
    }
  }
  const envRaw = process.env.SAI_HTTP_PORT;
  let envPort: number | undefined;
  if (envRaw) {
    httpEnabled = true;
    if (isValidPort(envRaw)) envPort = Number(envRaw);
    else console.error(`sai-mcp: ignoring invalid SAI_HTTP_PORT "${envRaw}", using 3000`);
  }
  if (!httpEnabled) return undefined;
  // Explicit --http <port> wins, then SAI_HTTP_PORT, then a default.
  return flagPort ?? envPort ?? 3000;
}

function isValidPort(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  const n = Number(value);
  return n >= 1 && n <= 65535;
}

async function main() {
  const httpPort = resolveHttpPort();
  if (httpPort !== undefined) {
    const host = process.env.SAI_HTTP_HOST || "127.0.0.1";
    await startHttpServer(httpPort, host);
    return;
  }
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("sai-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
