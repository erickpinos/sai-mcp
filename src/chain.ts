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

// ----- bech32 (EVM address -> nibi1...) -----
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= BECH32_GENERATOR[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

function bech32CreateChecksum(hrp: string, data: number[]): number[] {
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = bech32Polymod(values) ^ 1;
  const ret: number[] = [];
  for (let i = 0; i < 6; i++) ret.push((mod >> (5 * (5 - i))) & 31);
  return ret;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new Error("convertBits: invalid value");
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) ret.push((acc << (to - bits)) & maxv);
  return ret;
}

export function evmToBech32(evmAddr: string, hrp = "nibi"): string {
  const bytes = Array.from(ethers.getBytes(evmAddr));
  const words = convertBits(bytes, 8, 5, true);
  const checksum = bech32CreateChecksum(hrp, words);
  return hrp + "1" + [...words, ...checksum].map((d) => BECH32_CHARSET[d]).join("");
}

// ----- signer setup -----
export type ResolvedWallet = {
  wallet: ethers.HDNodeWallet | ethers.Wallet;
  provider: ethers.JsonRpcProvider;
  evmAddress: string;
  bech32Address: string;
  cfg: ChainCfg;
};

export function getWallet(network: Network = "mainnet"): ResolvedWallet {
  const cfg = CHAINS[network];
  const provider = new ethers.JsonRpcProvider(cfg.evmRpc);

  const mnemonic = process.env.SAI_MNEMONIC ?? process.env.MNEMONIC;
  const privateKey = process.env.SAI_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  const derivationPath = process.env.SAI_DERIVATION_PATH ?? "m/44'/60'/0'/0/0";

  let wallet: ethers.HDNodeWallet | ethers.Wallet;
  if (privateKey) {
    wallet = new ethers.Wallet(privateKey, provider);
  } else if (mnemonic) {
    wallet = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, derivationPath).connect(provider);
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
