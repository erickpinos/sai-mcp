import { ethers } from "ethers";
import { z } from "zod";
import {
  ERC20_ABI,
  getWallet,
  PERP_VAULT_EVM_ABI,
  USDC_DECIMALS,
} from "../chain.js";
import { graphqlRequest, type Network } from "../client.js";

const NetworkSchema = z
  .enum(["mainnet", "testnet"])
  .default("mainnet")
  .describe("Network to use. Defaults to mainnet.");

export const openTradeSchema = {
  network: NetworkSchema,
  marketId: z
    .number()
    .int()
    .nonnegative()
    .describe("Perp market id (e.g. 0 = BTC, 1 = ETH, 16 = SOL). Use sai_list_markets to enumerate."),
  long: z
    .boolean()
    .describe("true for a long position, false for a short."),
  leverage: z
    .number()
    .int()
    .positive()
    .describe("Integer leverage (must be within market's min/max — see sai_get_market)."),
  amountUsdc: z
    .number()
    .positive()
    .describe("Collateral in human USDC units (e.g. 10 = 10 USDC). USDC has 6 decimals on chain."),
  slippagePct: z
    .number()
    .positive()
    .default(1)
    .describe("Slippage tolerance in percent (default 1)."),
  tp: z
    .number()
    .positive()
    .nullable()
    .default(null)
    .describe("Take-profit price (null for none)."),
  sl: z
    .number()
    .positive()
    .nullable()
    .default(null)
    .describe("Stop-loss price (null for none)."),
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "Required to broadcast. Defaults to false (dry-run: simulate + gas-estimate only, do not sign or send). Set true to actually open the position.",
    ),
};

type OpenTradeArgs = {
  network?: Network;
  marketId: number;
  long: boolean;
  leverage: number;
  amountUsdc: number;
  slippagePct?: number;
  tp?: number | null;
  sl?: number | null;
  confirm?: boolean;
};

type Borrowing = {
  isOpen: boolean;
  marketId: number;
  price: number;
  minLeverage: number;
  maxLeverage: number;
  minPositionSizeUSD: number;
  baseToken: { symbol: string | null; name: string };
  quoteToken: { symbol: string | null; name: string };
};

async function fetchBorrowing(
  network: Network | undefined,
  marketId: number,
  collateralId: number,
): Promise<Borrowing> {
  const data = await graphqlRequest<{
    perp: { borrowing: Borrowing | null } | null;
  }>(
    `query Borrowing($marketId: Int!, $collateralId: Int!) {
      perp {
        borrowing(marketId: $marketId, collateralId: $collateralId) {
          isOpen marketId price minLeverage maxLeverage minPositionSizeUSD
          baseToken { symbol name }
          quoteToken { symbol name }
        }
      }
    }`,
    { marketId, collateralId },
    network,
  );
  const b = data.perp?.borrowing;
  if (!b) {
    throw new Error(`No market found for marketId=${marketId}, collateralId=${collateralId}`);
  }
  return b;
}

export async function openTrade(args: OpenTradeArgs) {
  const network = args.network ?? "mainnet";
  const slippagePct = args.slippagePct ?? 1;
  const tp = args.tp ?? null;
  const sl = args.sl ?? null;
  const confirm = args.confirm ?? false;

  const { wallet, provider, evmAddress, bech32Address, cfg } = getWallet(network);

  // --- market info ---
  const borrowing = await fetchBorrowing(network, args.marketId, cfg.usdcTokenIndex);
  if (!borrowing.isOpen) {
    throw new Error(`Market ${args.marketId} is currently closed`);
  }
  if (args.leverage < borrowing.minLeverage || args.leverage > borrowing.maxLeverage) {
    throw new Error(
      `Leverage ${args.leverage} outside allowed range [${borrowing.minLeverage}, ${borrowing.maxLeverage}] for market ${args.marketId}`,
    );
  }
  const positionSizeUSD = args.amountUsdc * args.leverage;
  if (positionSizeUSD < borrowing.minPositionSizeUSD) {
    throw new Error(
      `Position size ${positionSizeUSD} USD below market minimum ${borrowing.minPositionSizeUSD} USD (collateral * leverage)`,
    );
  }
  const baseSym = borrowing.baseToken.symbol ?? borrowing.baseToken.name;
  const quoteSym = borrowing.quoteToken.symbol ?? borrowing.quoteToken.name;

  const amount = ethers.parseUnits(args.amountUsdc.toString(), USDC_DECIMALS);

  // --- balance check ---
  const usdc = new ethers.Contract(cfg.usdcEvm, ERC20_ABI, wallet);
  const erc20Balance: bigint = await usdc.balanceOf(evmAddress);
  if (erc20Balance < amount) {
    throw new Error(
      `Insufficient USDC: wallet has ${ethers.formatUnits(erc20Balance, USDC_DECIMALS)}, need ${args.amountUsdc}`,
    );
  }

  // --- build wasm msg ---
  // Mirrors execOpenTradeEvm in sai-website/webapp/state/web3Calls/trade.tsx.
  const wasmMsg = {
    open_trade: {
      market_index: `MarketIndex(${args.marketId})`,
      leverage: args.leverage.toString(),
      long: args.long,
      collateral_index: `TokenIndex(${cfg.usdcTokenIndex})`,
      trade_type: "trade" as const,
      open_price: borrowing.price.toString(),
      tp: tp === null ? null : tp.toString(),
      sl: sl === null ? null : sl.toString(),
      slippage_p: slippagePct.toString(),
      is_evm_origin: true,
    },
  };
  const wasmMsgBytes = ethers.toUtf8Bytes(JSON.stringify(wasmMsg));

  // The PerpVaultEvmInterface pulls ERC20 USDC directly via the Nibiru funtoken
  // precompile — no prior approve needed. Gas is sponsored when targeting this
  // contract.
  const totalAmount = amount;
  const useErc20Amount = amount;

  const perpVault = new ethers.Contract(cfg.evmInterface, PERP_VAULT_EVM_ABI, wallet);

  // --- gas estimate (also doubles as simulation) ---
  let gasEstimate: bigint | null = null;
  let gasLimit: bigint;
  let estimationError: string | undefined;
  try {
    gasEstimate = await perpVault.openTrade.estimateGas(
      wasmMsgBytes,
      cfg.usdcTokenIndex,
      totalAmount,
      useErc20Amount,
    );
    gasLimit = (gasEstimate * 11n) / 10n;
  } catch (e) {
    estimationError = (e as Error).message;
    gasLimit = 2_500_000n;
  }

  const net = await provider.getNetwork();
  const nonce = await provider.getTransactionCount(evmAddress);

  const summary = {
    network,
    market: {
      marketId: args.marketId,
      symbol: `${baseSym}/${quoteSym}`,
      currentPrice: borrowing.price,
      leverageRange: [borrowing.minLeverage, borrowing.maxLeverage],
      minPositionSizeUSD: borrowing.minPositionSizeUSD,
    },
    trade: {
      direction: args.long ? "long" : "short",
      leverage: args.leverage,
      collateralUsdc: args.amountUsdc,
      positionSizeUsd: positionSizeUSD,
      slippagePct,
      tp,
      sl,
    },
    wallet: {
      evmAddress,
      bech32Address,
      usdcBalance: ethers.formatUnits(erc20Balance, USDC_DECIMALS),
      nonce,
      chainId: Number(net.chainId),
    },
    gas: {
      estimate: gasEstimate?.toString() ?? null,
      limit: gasLimit.toString(),
      estimationError,
      gasPrice: "0 (sponsored by chain when targeting PerpVaultEvmInterface)",
    },
    wasmMsg,
  };

  if (!confirm) {
    return {
      ...summary,
      status: "dry-run",
      note: "No transaction sent. Pass confirm=true to broadcast.",
    };
  }

  if (estimationError) {
    throw new Error(
      `Gas estimation failed — refusing to broadcast: ${estimationError}. Re-run with confirm=false to inspect.`,
    );
  }

  // --- broadcast ---
  const tx = await perpVault.openTrade(
    wasmMsgBytes,
    cfg.usdcTokenIndex,
    totalAmount,
    useErc20Amount,
    { gasLimit, gasPrice: 0n },
  );
  const receipt = await tx.wait();
  const success = receipt?.status === 1;

  return {
    ...summary,
    status: success ? "success" : "reverted",
    tx: {
      hash: tx.hash,
      explorer: cfg.explorerTx(tx.hash),
      blockNumber: receipt?.blockNumber,
      gasUsed: receipt?.gasUsed?.toString(),
    },
  };
}
