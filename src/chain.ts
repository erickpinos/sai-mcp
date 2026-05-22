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

export function evmToBech32(evmAddr: string, hrp = "nibi"): string {
  const bytes = ethers.getBytes(evmAddr);
  return bech32.encode(hrp, bech32.toWords(bytes));
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
    const pk = normalizePrivateKey(rawPrivateKey);
    try {
      wallet = new ethers.Wallet(pk, provider);
    } catch (e) {
      throw new Error(
        `SAI_PRIVATE_KEY is not a valid private key (${(e as Error).message}). Expected a 32-byte hex string, optionally 0x-prefixed.`,
      );
    }
  } else if (rawMnemonic) {
    const phrase = normalizeMnemonic(rawMnemonic);
    try {
      wallet = ethers.HDNodeWallet.fromPhrase(
        phrase,
        undefined,
        derivationPath,
      ).connect(provider);
    } catch (e) {
      throw new Error(
        `SAI_MNEMONIC is not a valid BIP-39 mnemonic (${(e as Error).message}). Expected a 12 or 24 word seed phrase.`,
      );
    }
  } else {
    throw new Error(
      "No signer configured. Set SAI_MNEMONIC (12/24-word seed) or SAI_PRIVATE_KEY in the MCP server's environment.",
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
];

export const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
