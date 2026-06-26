#!/usr/bin/env node
import { ethers } from "ethers";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startHttpServer } from "./http.js";
import { evmToBech32, saveKeystore } from "./chain.js";

// Generate a fresh random wallet. We derive through the SAME path resolution
// getWallet() uses (SAI_DERIVATION_PATH, default m/44'/60'/0'/0/0) so the
// address shown here is exactly the one the server will load.
//
// Two modes, with very different output:
//   --save  -> persist the mnemonic to a 0600 keystore the server auto-loads,
//              and print ONLY the public addresses + funding instructions. The
//              secret is NEVER written to stdout, so this form is safe for an AI
//              agent to run on the user's behalf: nothing sensitive reaches the
//              tool output / MCP / LLM channel. The keystore file is the backup.
//   (none)  -> print the secret for the user to paste into their MCP config's
//              env block. The secret IS on stdout, so this form is meant to be
//              run by a human in their own terminal, NOT by an assistant.
function keygen(save: boolean): void {
  const derivationPath = process.env.SAI_DERIVATION_PATH ?? "m/44'/60'/0'/0/0";
  const phrase = ethers.Wallet.createRandom().mnemonic!.phrase;
  const wallet = ethers.HDNodeWallet.fromPhrase(phrase, undefined, derivationPath);
  const bech32Address = evmToBech32(wallet.address, "nibi");

  if (save) {
    const savedPath = saveKeystore({ mnemonic: phrase, derivationPath });
    // NOTE: do NOT interpolate `phrase` or `wallet.privateKey` into this block.
    // Keeping the secret out of stdout is the whole point of --save.
    console.log(`sai-mcp: generated a new wallet and saved it to a local keystore (derivation path ${derivationPath})

Keystore: ${savedPath} (chmod 600)
The server loads it automatically whenever neither SAI_MNEMONIC nor
SAI_PRIVATE_KEY is set, so no MCP config edit is needed.

Fund this address (same 20 bytes, two encodings):

  EVM:    ${wallet.address}
  Nibiru: ${bech32Address}

The mnemonic is deliberately NOT printed here - it lives only in the keystore
file. To back it up, open that file yourself in a private terminal and copy it
somewhere safe; never have an assistant print it.

This wallet is EMPTY. Send USDC (collateral) to the EVM address above, then
confirm it landed with sai_get_wallet_info BEFORE placing a trade.

Trading on Sai is gasless: the chain sponsors gas for trades through the Sai
contract, so you do NOT need NIBI to open, close, or manage positions. You only
need NIBI later if you want to withdraw funds OUT of this wallet (a plain USDC
or NIBI transfer pays normal gas). Alternatively, export this wallet's keys
(open the keystore file above in a private terminal) into a wallet that pays
gas for you.`);
    return;
  }

  // No --save: the secret is printed below. Written to stdout (not the stderr
  // used for server logs) because this IS the command's output, meant to be
  // copied by a human.
  console.log(`sai-mcp: generated a new wallet (derivation path ${derivationPath})

Set ONE of these in your MCP config's env block. Run this yourself in a terminal;
the secret is printed below, so do NOT have an assistant run this form - use
\`sai-mcp keygen --save\` for agent-driven setup (it writes a keystore without
printing the secret):

  SAI_MNEMONIC="${phrase}"

  SAI_PRIVATE_KEY="${wallet.privateKey}"

Addresses (same 20 bytes, two encodings):

  EVM:    ${wallet.address}
  Nibiru: ${bech32Address}

This wallet is empty. Fund the address above with USDC (collateral) and confirm
with sai_get_wallet_info before trading. Trading on Sai is gasless, so you do
not need NIBI to trade; you only need NIBI to withdraw funds out later (or
export these keys into a wallet that pays gas).
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
    keygen(process.argv.includes("--save"));
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
