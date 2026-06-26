import { ethers } from "ethers";
import { z } from "zod";
import {
  ERC20_ABI,
  getWallet,
  PERP_VAULT_EVM_ABI,
  USDC_DECIMALS,
} from "../chain.js";
import { graphqlRequest, type Network } from "../client.js";
import { toPlainDecimalString, toTokenAmountString } from "../format.js";
import { assertTradeAllowed, loadTradeGuards } from "../guards.js";

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
    .finite()
    .describe("Integer leverage (must be within market's min/max — see sai_get_market)."),
  amountUsdc: z
    .number()
    .positive()
    .finite()
    .describe("Collateral in human USDC units (e.g. 10 = 10 USDC). USDC has 6 decimals on chain — extra fractional digits are rejected."),
  slippagePct: z
    .number()
    .positive()
    .finite()
    .default(1)
    .describe("Slippage tolerance in percent (default 1)."),
  tp: z
    .number()
    .positive()
    .finite()
    .nullable()
    .default(null)
    .describe("Take-profit price (null for none)."),
  sl: z
    .number()
    .positive()
    .finite()
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

// All fields are required at runtime — the MCP SDK runs the Zod schema
// (which declares `.default(...)` for optional inputs) before calling here,
// so the handler always sees fully-populated args.
type OpenTradeArgs = {
  network: Network;
  marketId: number;
  long: boolean;
  leverage: number;
  amountUsdc: number;
  slippagePct: number;
  tp: number | null;
  sl: number | null;
  confirm: boolean;
};

type TradingSchedule = {
  name: string;
  timezone: string;
  startTimeOfDay: string;
  closeTimeOfDay: string;
  holidays: (string | null)[];
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
  tradingSchedule: TradingSchedule | null;
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
          tradingSchedule {
            name timezone startTimeOfDay closeTimeOfDay holidays
          }
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
  // Operator-set caps (env vars) — apply before any network call. Always
  // enforced, even in dry-run, so the agent gets an immediate signal that the
  // operation is off-limits rather than discovering it after simulation.
  const guards = loadTradeGuards();
  assertTradeAllowed(
    { marketId: args.marketId, amountUsdc: args.amountUsdc, leverage: args.leverage },
    guards,
  );

  const { wallet, provider, evmAddress, bech32Address, cfg } = getWallet(args.network);

  // --- market info ---
  const borrowing = await fetchBorrowing(args.network, args.marketId, cfg.usdcTokenIndex);
  if (!borrowing.isOpen) {
    const sch = borrowing.tradingSchedule;
    const scheduleNote = sch
      ? ` This is a scheduled market (${sch.name}); trading hours are ${sch.startTimeOfDay}–${sch.closeTimeOfDay} ${sch.timezone}, closed on weekends and holidays.`
      : "";
    throw new Error(`Market ${args.marketId} is currently closed.${scheduleNote}`);
  }
  if (!(borrowing.price > 0)) {
    throw new Error(
      `Market ${args.marketId} has no valid oracle price (got ${borrowing.price}); refusing to trade`,
    );
  }
  if (args.leverage < borrowing.minLeverage || args.leverage > borrowing.maxLeverage) {
    throw new Error(
      `Leverage ${args.leverage} outside allowed range [${borrowing.minLeverage}, ${borrowing.maxLeverage}] for market ${args.marketId}`,
    );
  }
  // The GraphQL `minPositionSizeUSD` does NOT reflect the on-chain enforced
  // minimum (live positions exist well below it, e.g. ~$0.02 notional; the
  // indexer also reports the same flat value for every market, the signature of
  // a placeholder), so a hard client-side reject here would block trades the
  // chain actually accepts. The on-chain `estimateGas` simulation below is
  // authoritative: a genuinely too-small position surfaces as a non-null
  // `gas.estimationError`. We surface the reported minimum as an advisory in the
  // summary instead of throwing.
  const positionSizeUSD = args.amountUsdc * args.leverage;
  const belowReportedMinPositionSize =
    positionSizeUSD < borrowing.minPositionSizeUSD;
  // When the position is below the reported min, the model has historically
  // mistaken `minPositionSizeUSD` for a hard floor and inflated leverage to
  // "clear" it (e.g. forcing 12x on 0.1 USDC to reach $1.20). Surface the
  // correction inline so the model does not change the trade to satisfy a number
  // that is not enforced. `minLeverage` is 1 on the major markets, so the right
  // way to size a small position is low leverage, not high.
  const minPositionSizeNote = belowReportedMinPositionSize
    ? `positionSizeUsd ($${positionSizeUSD}) is below the indexer's reported minPositionSizeUSD ($${borrowing.minPositionSizeUSD}), but this is ADVISORY ONLY and is NOT enforced on-chain — the chain accepts positions far smaller (sub-$1, ~$0.02 observed) and this market's minLeverage is ${borrowing.minLeverage}. Do NOT raise leverage to exceed this number; size the position as the user asked. The authoritative check is the dry-run gas estimate: if the position were genuinely too small, gas.estimationError would be set.`
    : undefined;
  if (args.slippagePct > 50) {
    throw new Error(
      `slippagePct=${args.slippagePct} is unreasonably high (max 50). Set a realistic tolerance, typically 0.1–5.`,
    );
  }
  // tp/sl direction sanity — the contract will accept any value but if tp/sl is
  // on the wrong side of the entry price the position triggers immediately, so
  // catch it here with an actionable error.
  if (args.long) {
    if (args.tp !== null && args.tp <= borrowing.price) {
      throw new Error(
        `LONG take-profit (${args.tp}) must be above current price (${borrowing.price}); otherwise the position fills and immediately triggers a loss`,
      );
    }
    if (args.sl !== null && args.sl >= borrowing.price) {
      throw new Error(
        `LONG stop-loss (${args.sl}) must be below current price (${borrowing.price})`,
      );
    }
  } else {
    if (args.tp !== null && args.tp >= borrowing.price) {
      throw new Error(
        `SHORT take-profit (${args.tp}) must be below current price (${borrowing.price}); otherwise the position fills and immediately triggers a loss`,
      );
    }
    if (args.sl !== null && args.sl <= borrowing.price) {
      throw new Error(
        `SHORT stop-loss (${args.sl}) must be above current price (${borrowing.price})`,
      );
    }
  }
  const baseSym = borrowing.baseToken.symbol ?? borrowing.baseToken.name;
  const quoteSym = borrowing.quoteToken.symbol ?? borrowing.quoteToken.name;

  const amount = ethers.parseUnits(
    toTokenAmountString(args.amountUsdc, USDC_DECIMALS),
    USDC_DECIMALS,
  );

  // --- build wasm msg ---
  // Mirrors execOpenTradeEvm in sai-website/webapp/state/web3Calls/trade.tsx.
  const wasmMsg = {
    open_trade: {
      market_index: `MarketIndex(${args.marketId})`,
      leverage: toPlainDecimalString(args.leverage),
      long: args.long,
      collateral_index: `TokenIndex(${cfg.usdcTokenIndex})`,
      trade_type: "trade" as const,
      open_price: toPlainDecimalString(borrowing.price),
      tp: args.tp === null ? null : toPlainDecimalString(args.tp),
      sl: args.sl === null ? null : toPlainDecimalString(args.sl),
      slippage_p: toPlainDecimalString(args.slippagePct),
      is_evm_origin: true,
      // The contract reads the position collateral from this field; omitting it
      // makes openTrade revert during gas estimation with an undecodable error.
      // Mirrors execOpenTradeEvm in sai-website (collateral_amount in bank units;
      // USDC bank and erc20 are both 6 decimals, so this equals `amount`).
      collateral_amount: amount.toString(),
    },
  };
  const wasmMsgBytes = ethers.toUtf8Bytes(JSON.stringify(wasmMsg));

  // The PerpVaultEvmInterface pulls ERC20 USDC directly via the Nibiru funtoken
  // precompile — no prior approve needed. Gas is sponsored when targeting this
  // contract.
  const totalAmount = amount;
  const useErc20Amount = amount;

  const perpVault = new ethers.Contract(cfg.evmInterface, PERP_VAULT_EVM_ABI, wallet);
  const usdc = new ethers.Contract(cfg.usdcEvm, ERC20_ABI, wallet);

  // --- balance, gas estimate, network, nonce in one round-trip batch ---
  // These RPC calls are independent of each other; firing them together instead
  // of sequentially saves ~3 network round-trips on every (dry-run and live)
  // call. The gas estimate doubles as the on-chain simulation.
  const [erc20Balance, gas, net, nonce] = await Promise.all([
    usdc.balanceOf(evmAddress) as Promise<bigint>,
    perpVault.openTrade
      .estimateGas(wasmMsgBytes, cfg.usdcTokenIndex, totalAmount, useErc20Amount)
      .then((estimate: bigint) => ({ estimate, error: undefined as string | undefined }))
      .catch((e: Error) => ({ estimate: null as bigint | null, error: e.message })),
    provider.getNetwork(),
    provider.getTransactionCount(evmAddress, "pending"),
  ]);

  // --- balance check --- (after the batch; a clearer error than the raw
  // estimateGas revert the precompile throws when funds are short)
  if (erc20Balance < amount) {
    throw new Error(
      `Insufficient USDC: wallet has ${ethers.formatUnits(erc20Balance, USDC_DECIMALS)}, need ${args.amountUsdc}`,
    );
  }

  const gasEstimate = gas.estimate;
  const estimationError = gas.error;
  const gasLimit = gasEstimate !== null ? (gasEstimate * 11n) / 10n : 2_500_000n;

  const summary = {
    network: args.network,
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
      belowReportedMinPositionSize,
      ...(minPositionSizeNote ? { minPositionSizeNote } : {}),
      slippagePct: args.slippagePct,
      tp: args.tp,
      sl: args.sl,
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
    guards: {
      maxTradeUsdc: guards.maxTradeUsdc,
      maxLeverage: guards.maxLeverage,
      maxPositionUsd: guards.maxPositionUsd,
      marketAllowlist: guards.marketAllowlist
        ? [...guards.marketAllowlist].sort((a, b) => a - b)
        : null,
    },
    wasmMsg,
  };

  if (!args.confirm) {
    return {
      ...summary,
      status: "dry-run",
      note: "No transaction sent. Pass confirm=true to broadcast.",
    };
  }

  // Gas estimation CAN be unreliable for this contract: PerpVaultEvmInterface
  // pulls USDC via the Nibiru funtoken precompile, whose estimateGas path can
  // fail to simulate under some states, so a failed estimate does not always
  // mean the trade would revert. (Caveat: in mainnet testing 2026-06-26 the
  // estimate was actually accurate for valid opens and only threw the
  // undecodable "missing revert data" for a genuinely-doomed over-balance open,
  // so the failure mode we reproduced was a real revert. We keep the fallback
  // as a cheap safety net rather than relying on it being common.) Mirror the
  // webapp (estimateGasWithFallback in sai-website): on estimation failure, fall
  // back to the fixed gas limit (already computed above) and broadcast anyway.
  // The estimationError stays visible in `summary.gas` and is flagged via
  // `broadcastWithFallbackGas` so the caller knows it was sent without a
  // validated estimate.
  const broadcastWithFallbackGas = estimationError !== undefined;

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
    broadcastWithFallbackGas,
    tx: {
      hash: tx.hash,
      explorer: cfg.explorerTx(tx.hash),
      blockNumber: receipt?.blockNumber,
      gasUsed: receipt?.gasUsed?.toString(),
    },
  };
}
