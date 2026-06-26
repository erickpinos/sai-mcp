import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bech32 } from "bech32";
import { ethers } from "ethers";
import type { Network } from "./client.js";

export type ChainCfg = {
  evmRpc: string;
  cosmosRest: string;
  evmInterface: string;
  usdcEvm: string;
  usdcBankDenom: string;
  usdcTokenIndex: number;
  explorerTx: (hash: string) => string;
};

export const CHAINS: Record<Network, ChainCfg> = {
  mainnet: {
    evmRpc: "https://evm-rpc.nibiru.fi",
    cosmosRest: "https://lcd.nibiru.fi",
    evmInterface: "0x9F48A925Dda8528b3A5c2A6717Df0F03c8b167c0",
    usdcEvm: "0x0829F361A05D993d5CEb035cA6DF3446b060970b",
    usdcBankDenom: "erc20/0x0829F361A05D993d5CEb035cA6DF3446b060970b",
    usdcTokenIndex: 1,
    explorerTx: (h) => `https://nibiscan.io/tx/${h}`,
  },
  testnet: {
    evmRpc: "https://evm-rpc.testnet-2.nibiru.fi",
    cosmosRest: "https://lcd.testnet-2.nibiru.fi",
    evmInterface: "0xC89Cd9fB1f2A77fAdCa62cCc4df21698cFFFaac9",
    usdcEvm: "0xAb68f1D1d91854383fd4Df9016E3040D03e8191a",
    usdcBankDenom: "tf/nibi1pc2mmwcqhvzn9vsm0umpu40yzl6gfy6nucwn7g/usdc",
    usdcTokenIndex: 3,
    explorerTx: (h) => `https://testnet.nibiscan.io/tx/${h}`,
  },
};

// USDC uses 6 decimals on both bank and erc20 sides (Nibiru funtoken).
export const USDC_DECIMALS = 6;
export const NIBI_DECIMALS = 6;

// Nibiru's minimum EVM gas price, in 18-decimal wei. The node's `eth_gasPrice`
// (and ethers' feeData.gasPrice) report 0, but the chain still enforces this
// floor when deducting gas from the sender on broadcast — so a tx signed at
// gasPrice 0 reverts with INSUFFICIENT_FUNDS unless the wallet holds NIBI to
// cover gasLimit * this. Gas sponsorship (gasPrice 0 actually accepted) is
// SPECIFIC to PerpVaultEvmInterface calls (open/close/update trade); plain
// transfers like sai_send are ordinary txs that pay this. Used to floor the
// effective gas price so dry-run funding checks and broadcasts are realistic.
export const MIN_GAS_PRICE_WEI = 1_000_000_000_000n; // 1e12 wei (~0.000001 NIBI/gas)

export function evmToBech32(evmAddr: string, hrp = "nibi"): string {
  const bytes = ethers.getBytes(evmAddr);
  return bech32.encode(hrp, bech32.toWords(bytes));
}

// Validate (and checksum-normalize) an EVM hex address, throwing a clear error
// on malformed input. Shared by the trader and vault address resolvers so a bad
// 0x fails loudly instead of querying a garbage address that silently returns
// nothing.
export function normalizeEvmAddress(addr: string): string {
  try {
    return ethers.getAddress(addr.trim());
  } catch {
    throw new Error(
      `"${addr}" looks like an EVM address but is not a valid 20-byte 0x hex address.`,
    );
  }
}

// Accept either a Nibiru bech32 address (nibi1...) or an EVM hex address
// (0x...) for any trader/depositor/referrer filter, returning the bech32 form
// the keeper indexes by. The keeper only matches on bech32, so a raw 0x address
// would silently return nothing; converting up front makes 0x "just work". A
// wallet's 0x and bech32 are the same 20 bytes, so this conversion is exact.
export function normalizeTraderAddress(addr: string): string {
  const trimmed = addr.trim();
  if (/^0x/i.test(trimmed)) {
    return evmToBech32(normalizeEvmAddress(trimmed), "nibi");
  }
  return trimmed;
}

// Decode a Nibiru bech32 address (nibi1...) back to a checksummed 0x EVM
// address. The inverse of evmToBech32: a wallet's bech32 and 0x forms are the
// same 20 bytes, so this is exact. Used by send/transfer flows that must hand an
// EVM-form recipient to an ERC20 transfer() or a native value send.
export function bech32ToEvm(addr: string): string {
  let words: number[];
  try {
    ({ words } = bech32.decode(addr.trim()));
  } catch {
    throw new Error(`"${addr}" is not a valid bech32 address.`);
  }
  const bytes = Uint8Array.from(bech32.fromWords(words));
  if (bytes.length !== 20) {
    throw new Error(
      `bech32 address "${addr}" decodes to ${bytes.length} bytes, expected a 20-byte account address.`,
    );
  }
  return ethers.getAddress(ethers.hexlify(bytes));
}

// Resolve a recipient given in either form to a checksummed 0x EVM address, the
// form an on-chain transfer needs. Throws loudly on anything that is neither a
// 0x hex address nor a nibi1 bech32 address, so a typo fails before broadcast
// instead of burning gas sending to a garbage destination.
export function normalizeRecipientToEvm(addr: string): string {
  const trimmed = addr.trim();
  if (/^0x/i.test(trimmed)) {
    return normalizeEvmAddress(trimmed);
  }
  if (/^nibi1/i.test(trimmed)) {
    return bech32ToEvm(trimmed);
  }
  throw new Error(
    `"${addr}" is not a recognized address. Expected an EVM 0x... address or a Nibiru nibi1... bech32 address.`,
  );
}

// ----- signer setup -----
export type ResolvedWallet = {
  wallet: ethers.HDNodeWallet | ethers.Wallet;
  provider: ethers.JsonRpcProvider;
  evmAddress: string;
  bech32Address: string;
  cfg: ChainCfg;
};

function normalizeMnemonic(raw: string): string {
  // Collapse any whitespace run (spaces, tabs, newlines, NBSPs from copy-paste)
  // into a single space and trim. ethers' fromPhrase requires exactly single
  // spaces between words.
  return raw.replace(/\s+/g, " ").trim();
}

function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("0x") || trimmed.startsWith("0X")
    ? trimmed
    : `0x${trimmed}`;
}

// ----- local keystore -----
// A keystore lets `keygen --save` persist a generated wallet to a 0600 file the
// server reads at startup, so the user never has to paste a secret into their
// MCP config's env block. The secret is written by the local CLI and read by
// the local server process; it never crosses the MCP/LLM channel. Env vars
// (SAI_MNEMONIC / SAI_PRIVATE_KEY) always win, so the keystore is a fallback
// consulted only when neither is set.
export type Keystore = {
  mnemonic?: string;
  privateKey?: string;
  derivationPath?: string;
};

export function keystorePath(): string {
  return (
    process.env.SAI_KEYSTORE ??
    path.join(os.homedir(), ".sai-mcp", "wallet.json")
  );
}

// Read the keystore if it exists. Returns null when there's no file so the
// caller falls through to the "No signer configured" error. Warns (rather than
// throws) on loose POSIX permissions so a sloppy chmod is visible without
// bricking an otherwise-working setup.
function loadKeystore(): Keystore | null {
  const p = keystorePath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch {
    return null;
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    console.error(
      `sai-mcp: keystore ${p} is group/world-accessible; run 'chmod 600 ${p}'.`,
    );
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Keystore;
  } catch (e) {
    throw new Error(
      `sai-mcp keystore at ${p} is not valid JSON (${(e as Error).message}).`,
    );
  }
}

// Write a keystore with owner-only permissions, creating ~/.sai-mcp if needed.
// chmod is reapplied after write because writeFileSync's mode only takes effect
// when the file is created, so a re-save would otherwise leave stale perms.
export function saveKeystore(ks: Keystore): string {
  const p = keystorePath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, `${JSON.stringify(ks, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return p;
}

// Build a signer from one secret (private key OR mnemonic). Shared by the env
// and keystore paths; the *Label args name the source in error messages so a
// bad value points at SAI_PRIVATE_KEY vs the keystore file, etc.
function buildWallet(
  secret: { privateKey?: string; mnemonic?: string },
  derivationPath: string,
  provider: ethers.JsonRpcProvider,
  pkLabel: string,
  mnemonicLabel: string,
): ethers.HDNodeWallet | ethers.Wallet {
  if (secret.privateKey) {
    const pk = normalizePrivateKey(secret.privateKey);
    try {
      return new ethers.Wallet(pk, provider);
    } catch (e) {
      throw new Error(
        `${pkLabel} is not a valid private key (${(e as Error).message}). Expected a 32-byte hex string, optionally 0x-prefixed.`,
      );
    }
  }
  const phrase = normalizeMnemonic(secret.mnemonic!);
  try {
    return ethers.HDNodeWallet.fromPhrase(
      phrase,
      undefined,
      derivationPath,
    ).connect(provider);
  } catch (e) {
    throw new Error(
      `${mnemonicLabel} is not a valid BIP-39 mnemonic (${(e as Error).message}). Expected a 12 or 24 word seed phrase.`,
    );
  }
}

export function getWallet(network: Network = "mainnet"): ResolvedWallet {
  const cfg = CHAINS[network];
  const provider = new ethers.JsonRpcProvider(cfg.evmRpc);

  const rawMnemonic = process.env.SAI_MNEMONIC;
  const rawPrivateKey = process.env.SAI_PRIVATE_KEY;
  const derivationPath = process.env.SAI_DERIVATION_PATH ?? "m/44'/60'/0'/0/0";

  if (rawMnemonic && rawPrivateKey) {
    throw new Error(
      "Both SAI_MNEMONIC and SAI_PRIVATE_KEY are set. Unset one to disambiguate which signer to use.",
    );
  }

  let wallet: ethers.HDNodeWallet | ethers.Wallet;
  if (rawPrivateKey) {
    wallet = buildWallet(
      { privateKey: rawPrivateKey },
      derivationPath,
      provider,
      "SAI_PRIVATE_KEY",
      "SAI_MNEMONIC",
    );
  } else if (rawMnemonic) {
    wallet = buildWallet(
      { mnemonic: rawMnemonic },
      derivationPath,
      provider,
      "SAI_PRIVATE_KEY",
      "SAI_MNEMONIC",
    );
  } else {
    // No env signer: fall back to a local keystore (written by `keygen --save`).
    const ks = loadKeystore();
    if (ks?.mnemonic && ks?.privateKey) {
      throw new Error(
        `Keystore at ${keystorePath()} has both "mnemonic" and "privateKey"; keep only one.`,
      );
    }
    if (!ks || (!ks.mnemonic && !ks.privateKey)) {
      throw new Error(
        "No signer configured. New wallet (recommended): run `sai-mcp keygen --save`, which writes a 0600 keystore the server auto-loads (no restart) and prints no secret, so it is safe to run even inside an AI session. Existing wallet: create the keystore file yourself in your own terminal at ~/.sai-mcp/wallet.json (override with SAI_KEYSTORE) containing {\"mnemonic\":\"<your 12/24 words>\"} or {\"privateKey\":\"0x...\"}, then `chmod 600` it; the server picks it up live. Hosted deployments can instead set SAI_MNEMONIC or SAI_PRIVATE_KEY in the server environment.",
      );
    }
    const label = `keystore at ${keystorePath()}`;
    wallet = buildWallet(
      { privateKey: ks.privateKey, mnemonic: ks.mnemonic },
      ks.derivationPath ?? derivationPath,
      provider,
      `${label} "privateKey"`,
      `${label} "mnemonic"`,
    );
  }

  return {
    wallet,
    provider,
    evmAddress: wallet.address,
    bech32Address: evmToBech32(wallet.address, "nibi"),
    cfg,
  };
}

export async function fetchBankBalance(
  rest: string,
  bech32Addr: string,
  denom: string,
): Promise<bigint> {
  const url = `${rest}/cosmos/bank/v1beta1/balances/${bech32Addr}/by_denom?denom=${encodeURIComponent(denom)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`bank balance ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { balance?: { amount?: string } };
  return BigInt(json.balance?.amount ?? "0");
}

export const PERP_VAULT_EVM_ABI = [
  "function openTrade(bytes wasmMsgExecute, uint256 collateralIndex, uint256 tradeAmount, uint256 useERC20Amount)",
  // close_trade (also cancels a pending limit/stop order) and update_tp are both
  // dispatched through executeSimpleFunctions with a wasm message payload.
  "function executeSimpleFunctions(bytes wasmMsgExecute)",
  // Leverage changes settle a collateral delta, so they have a dedicated method
  // rather than going through executeSimpleFunctions.
  "function updateLeverage(uint256 tradeIndex, uint256 newLeverage, uint256 collateralIndex, uint256 collateralAmount, uint256 useErc20Amount)",
];

export const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
];
