#!/usr/bin/env node
import { ethers } from "ethers";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startHttpServer } from "./http.js";
import { evmToBech32 } from "./chain.js";

// Generate a fresh random wallet and print its mnemonic, private key, and
// addresses so the user can paste one into their MCP config's env block. This
// runs locally and never touches the MCP/LLM channel - the secret stays in the
// user's terminal. We derive through the SAME path resolution getWallet() uses
// (SAI_DERIVATION_PATH, default m/44'/60'/0'/0/0) so the address shown here is
// exactly the one the server will load from the printed mnemonic.
function keygen(): void {
  const derivationPath = process.env.SAI_DERIVATION_PATH ?? "m/44'/60'/0'/0/0";
  const phrase = ethers.Wallet.createRandom().mnemonic!.phrase;
  const wallet = ethers.HDNodeWallet.fromPhrase(phrase, undefined, derivationPath);
  const bech32Address = evmToBech32(wallet.address, "nibi");

  // Written to stdout (not the stderr used for server logs): this IS the
  // command's output, meant to be read and copied.
  console.log(`sai-mcp: generated a new wallet (derivation path ${derivationPath})

Set ONE of these in your MCP config's env block:

  SAI_MNEMONIC="${phrase}"

  SAI_PRIVATE_KEY="${wallet.privateKey}"

Addresses (same 20 bytes, two encodings):

  EVM:    ${wallet.address}
  Nibiru: ${bech32Address}

This wallet is empty. Fund the address above with NIBI (for gas) and USDC
(collateral) before trading, and confirm with sai_get_wallet_info.
Back up the mnemonic now - this output is the only copy.`);
}

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
  if (process.argv[2] === "keygen") {
    keygen();
    return;
  }
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
