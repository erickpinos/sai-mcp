import { ethers } from "ethers";
import { z } from "zod";
import {
  ERC20_ABI,
  fetchBankBalance,
  getWallet,
  NIBI_DECIMALS,
  USDC_DECIMALS,
} from "../chain.js";
import type { Network } from "../client.js";

const NetworkSchema = z
  .enum(["mainnet", "testnet"])
  .default("mainnet")
  .describe("Network to use. Defaults to mainnet.");

export const getWalletInfoSchema = {
  network: NetworkSchema,
};

export async function getWalletInfo(args: { network: Network }) {
  const { provider, evmAddress, bech32Address, cfg } = getWallet(args.network);

  const [nibiEvmRaw, nibiBankRaw, usdcErc20Raw, usdcBankRaw, nonce] = await Promise.all([
    provider.getBalance(evmAddress),
    fetchBankBalance(cfg.cosmosRest, bech32Address, "unibi"),
    new ethers.Contract(cfg.usdcEvm, ERC20_ABI, provider).balanceOf(evmAddress) as Promise<bigint>,
    fetchBankBalance(cfg.cosmosRest, bech32Address, cfg.usdcBankDenom),
    provider.getTransactionCount(evmAddress),
  ]);

  // EVM native balance is in 18-decimal wei, even though the underlying bank
  // denom (`unibi`) is 6-decimal — the EVM exposes it scaled up.
  const nibiEvmHuman = ethers.formatUnits(nibiEvmRaw, 18);
  const nibiBankHuman = ethers.formatUnits(nibiBankRaw, NIBI_DECIMALS);
  const usdcErc20Human = ethers.formatUnits(usdcErc20Raw, USDC_DECIMALS);
  const usdcBankHuman = ethers.formatUnits(usdcBankRaw, USDC_DECIMALS);

  return {
    network: args.network,
    evmAddress,
    bech32Address,
    nonce,
    balances: {
      nibi: {
        evmNative: nibiEvmHuman,
        bankUnibi: nibiBankHuman,
      },
      usdc: {
        erc20: usdcErc20Human,
        bank: usdcBankHuman,
        contract: cfg.usdcEvm,
        decimals: USDC_DECIMALS,
      },
    },
    chain: {
      evmRpc: cfg.evmRpc,
      cosmosRest: cfg.cosmosRest,
      evmInterface: cfg.evmInterface,
    },
    signerSource: process.env.SAI_PRIVATE_KEY ? "SAI_PRIVATE_KEY" : "SAI_MNEMONIC",
  };
}
