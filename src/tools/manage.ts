import { ethers } from "ethers";
import { z } from "zod";
import {
  type ChainCfg,
  ERC20_ABI,
  getWallet,
  PERP_VAULT_EVM_ABI,
  USDC_DECIMALS,
} from "../chain.js";
import { graphqlRequest, type Network } from "../client.js";
import { toPlainDecimalString } from "../format.js";
import { loadTradeGuards } from "../guards.js";

const NetworkSchema = z
  .enum(["mainnet", "testnet"])
  .default("mainnet")
  .describe("Network to use. Defaults to mainnet.");

const ConfirmSchema = z
  .boolean()
  .default(false)
  .describe(
    "Required to broadcast. Defaults to false (dry-run: simulate + gas-estimate only). Set true to actually send the transaction.",
  );

// --- shared trade lookup ---------------------------------------------------

type ManagedTrade = {
  id: number;
  isOpen: boolean;
  isLong: boolean;
  leverage: number;
  collateralAmount: number; // base units (USDC has 6 decimals)
  openPrice: number;
  tp: number | null;
  sl: number | null;
  tradeType: "trade" | "limit" | "stop";
  openBlock: { block: number; block_ts: string } | null;
  perpBorrowing: {
    marketId: number;
    price: number;
    minLeverage: number;
    maxLeverage: number;
    isOpen: boolean;
    baseToken: { symbol: string | null; name: string };
    quoteToken: { symbol: string | null; name: string };
    collateralToken: { id: number; symbol: string | null };
  };
  state: { liquidationPrice: number; pnlCollateral: number; pnlPct: number } | null;
};

// The keeper's `trade(id, trader)` query keys on the per-user trade index — the
// same integer the contract expects as `UserTradeIndex(N)` — so the `id` field
// returned by sai_get_trader_trades is exactly what these tools take.
async function fetchTrade(
  network: Network,
  id: number,
  trader: string,
): Promise<ManagedTrade> {
  const data = await graphqlRequest<{ perp: { trade: ManagedTrade | null } }>(
    `query Trade($id: Int!, $trader: String!) {
      perp {
        trade(id: $id, trader: $trader) {
          id isOpen isLong leverage collateralAmount openPrice tp sl tradeType
          openBlock { block block_ts }
          perpBorrowing {
            marketId isOpen
            baseToken { symbol name }
            quoteToken { symbol name }
            collateralToken { id symbol }
          }
          state { liquidationPrice pnlCollateral pnlPct }
        }
      }
    }`,
    { id, trader },
    network,
  );
  const trade = data.perp?.trade;
  if (!trade) {
    throw new Error(
      `No trade with index ${id} found for ${trader}. Use sai_get_trader_trades to list open positions and their ids.`,
    );
  }
  // price / minLeverage / maxLeverage are NOT exposed on a trade's
  // `perpBorrowing` (type PerpBorrowingShortInfo); they live on the separate
  // `perp.borrowing(marketId, collateralId)` query. Fetch and merge them so the
  // TP/SL direction check and leverage-range check have live values.
  const market = await fetchBorrowingInfo(
    network,
    trade.perpBorrowing.marketId,
    trade.perpBorrowing.collateralToken.id,
  );
  trade.perpBorrowing.price = market.price;
  trade.perpBorrowing.minLeverage = market.minLeverage;
  trade.perpBorrowing.maxLeverage = market.maxLeverage;
  return trade;
}

async function fetchBorrowingInfo(
  network: Network,
  marketId: number,
  collateralId: number,
): Promise<{ price: number; minLeverage: number; maxLeverage: number }> {
  const data = await graphqlRequest<{
    perp: {
      borrowing: {
        price: number;
        minLeverage: number;
        maxLeverage: number;
      } | null;
    } | null;
  }>(
    `query Borrowing($marketId: Int!, $collateralId: Int!) {
      perp {
        borrowing(marketId: $marketId, collateralId: $collateralId) {
          price minLeverage maxLeverage
        }
      }
    }`,
    { marketId, collateralId },
    network,
  );
  const b = data.perp?.borrowing;
  if (!b) {
    throw new Error(
      `Could not load market info (marketId=${marketId}, collateralId=${collateralId}) needed to validate the update.`,
    );
  }
  return b;
}

function marketSymbol(t: ManagedTrade): string {
  const b = t.perpBorrowing.baseToken;
  const q = t.perpBorrowing.quoteToken;
  return `${b.symbol ?? b.name}/${q.symbol ?? q.name}`;
}

// --- freshly-opened-position guard -----------------------------------------
//
// Acting on a position within ~2 minutes of opening can revert ON-CHAIN even
// though estimateGas returns a clean estimate with no error. The contract's
// funtoken-precompile path appears to enforce a brief minimum-hold / same-block
// guard that eth_estimateGas does not simulate. So a clean dry-run is NOT a
// guarantee an immediate close/update lands. (Observed: open then close ~8s
// later reverted with an undecodable CALL_EXCEPTION; the same close ~2 min later
// succeeded.) We surface this as an advisory in the dry-run summary, and (if a
// real broadcast reverts) translate the opaque revert into an actionable
// "wait and retry" hint rather than leaking the raw precompile error.
const RECENT_OPEN_SECONDS = 120;

function positionAgeSeconds(trade: ManagedTrade): number | null {
  const ts = trade.openBlock?.block_ts;
  if (!ts) return null;
  const openedMs = Date.parse(ts);
  if (Number.isNaN(openedMs)) return null;
  return Math.max(0, Math.round(Date.now() / 1000 - openedMs / 1000));
}

// Advisory shown in the dry-run summary when the position was opened recently.
function recentOpenAdvisory(
  ageSec: number | null,
  verb: "close" | "modify",
): string | undefined {
  if (ageSec === null || ageSec >= RECENT_OPEN_SECONDS) return undefined;
  return `This position was opened ~${ageSec}s ago. Acting on a position within ~1-2 minutes of opening can revert on-chain even when this gas estimate succeeds (the contract appears to enforce a brief minimum hold). If the ${verb} broadcast reverts, wait ~1-2 minutes and retry. This tool does not auto-wait.`;
}

// Hint appended to a broadcast-revert error, tailored by how fresh the position is.
function revertRetryHint(ageSec: number | null): string {
  return ageSec !== null && ageSec < RECENT_OPEN_SECONDS
    ? `The position was opened ~${ageSec}s ago; actions within ~1-2 min of opening commonly revert here even after a clean gas estimate. Wait ~1-2 minutes and retry.`
    : "If you just opened or modified this position its state may still be settling; wait a moment and retry. It may also already be closed/settled.";
}

// --- shared simulate / broadcast -------------------------------------------

type Simulated = {
  gasEstimate: bigint | null;
  estimationError: string | undefined;
  gasLimit: bigint;
  chainId: number;
  nonce: number;
};

// estimateGas doubles as the on-chain simulation; it runs alongside the
// network/nonce reads in a single round-trip batch.
async function simulate(
  provider: ethers.JsonRpcProvider,
  evmAddress: string,
  estimateGasFn: () => Promise<bigint>,
): Promise<Simulated> {
  const [gas, net, nonce] = await Promise.all([
    estimateGasFn()
      .then((estimate) => ({ estimate, error: undefined as string | undefined }))
      .catch((e: Error) => ({ estimate: null as bigint | null, error: e.message })),
    provider.getNetwork(),
    provider.getTransactionCount(evmAddress, "pending"),
  ]);
  const gasEstimate = gas.estimate;
  return {
    gasEstimate,
    estimationError: gas.error,
    gasLimit: gasEstimate !== null ? (gasEstimate * 11n) / 10n : 2_500_000n,
    chainId: Number(net.chainId),
    nonce,
  };
}

async function broadcast(
  txPromise: Promise<ethers.ContractTransactionResponse>,
  cfg: ChainCfg,
  // Appended to the error when the broadcast reverts on-chain. estimateGas can
  // pass for a tx that then reverts (notably right after opening, see
  // revertRetryHint), so callers pass a context-specific retry hint here.
  revertHint?: string,
) {
  const tx = await txPromise;
  try {
    const receipt = await tx.wait();
    return {
      status: receipt?.status === 1 ? "success" : "reverted",
      tx: {
        hash: tx.hash,
        explorer: cfg.explorerTx(tx.hash),
        blockNumber: receipt?.blockNumber,
        gasUsed: receipt?.gasUsed?.toString(),
      },
    };
  } catch (e) {
    // ethers throws CALL_EXCEPTION when a tx reverts during execution. The
    // funtoken-precompile path returns no decodable reason, so translate the
    // opaque blob into an actionable message that keeps the tx hash visible.
    const msg = e instanceof Error ? e.message : String(e);
    if (/missing revert data|CALL_EXCEPTION|execution reverted/i.test(msg)) {
      throw new Error(
        `Broadcast reverted on-chain (tx ${tx.hash}, ${cfg.explorerTx(tx.hash)}). This contract's funtoken-precompile path returns no decodable revert reason.${revertHint ? " " + revertHint : ""} Confirm the trade's true state via sai_get_trader_history before retrying.`,
      );
    }
    throw e;
  }
}

function gasSummary(sim: Simulated) {
  return {
    estimate: sim.gasEstimate?.toString() ?? null,
    limit: sim.gasLimit.toString(),
    estimationError: sim.estimationError,
    gasPrice: "0 (sponsored by chain when targeting PerpVaultEvmInterface)",
  };
}

// The PerpVaultEvmInterface routes through the Nibiru funtoken precompile, whose
// reverts come back to ethers as an undecodable CALL_EXCEPTION ("missing revert
// data") with no reason string. That raw blob is useless to a caller, so we
// translate it into an actionable hint. `action` lets us tailor the most likely
// cause: a close/cancel that reverts almost always means the trade is already
// closed/settled (the keeper's isOpen flag is eventually-consistent and can
// still read open for a minute or two after a close, so the friendly isOpen
// guard upstream may not catch it). Returns undefined when there is no error or
// the error is already a clear, decoded message.
function interpretSimulationError(
  estimationError: string | undefined,
  action: "close-position" | "cancel-order" | "update-tpsl" | "update-leverage",
): string | undefined {
  if (!estimationError) return undefined;
  const isUndecodableRevert =
    /missing revert data|CALL_EXCEPTION/i.test(estimationError);
  if (!isUndecodableRevert) return estimationError;
  const base =
    "On-chain simulation reverted without a decodable reason (common for this contract's precompile path).";
  const cause =
    action === "close-position" || action === "cancel-order"
      ? " The most likely cause is that this trade is already closed/settled or no longer exists. Note the keeper's open/closed state is eventually-consistent and can be delayed behind the chain by up to ~1-2 minutes; confirm the trade's true state via sai_get_trader_history (look for a position_closed event) rather than sai_get_trader_trades."
      : " The most likely cause is that this trade is no longer open, or a parameter is out of range for the position's current state. Confirm the trade's true state via sai_get_trader_history.";
  return base + cause;
}

// ---------------------------------------------------------------------------
// sai_close_trade — close an open position or cancel a pending order
// ---------------------------------------------------------------------------

export const closeTradeSchema = {
  network: NetworkSchema,
  tradeIndex: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "The trade's per-user index (the `id` field from sai_get_trader_trades).",
    ),
  confirm: ConfirmSchema,
};

export async function closeTrade(args: {
  network: Network;
  tradeIndex: number;
  confirm: boolean;
}) {
  const { wallet, provider, evmAddress, bech32Address, cfg } = getWallet(args.network);
  const trade = await fetchTrade(args.network, args.tradeIndex, bech32Address);
  if (!trade.isOpen) {
    throw new Error(`Trade ${args.tradeIndex} is already closed.`);
  }
  // A market position (tradeType "trade") is closed; a not-yet-filled limit/stop
  // order is cancelled. Both are the same on-chain call (close_trade).
  const isPendingOrder = trade.tradeType !== "trade";
  const action = isPendingOrder ? "cancel-order" : "close-position";

  // A market position only has the minimum-hold revert risk; a pending order is
  // cancellable immediately, so only advise/hint for real positions.
  const ageSec = isPendingOrder ? null : positionAgeSeconds(trade);
  const advisory = recentOpenAdvisory(ageSec, "close");
  const revertHint = revertRetryHint(ageSec);

  // close_trade also cancels a pending order — the contract distinguishes by the
  // trade's own state, so the message is identical.
  const wasmMsg = {
    close_trade: { trade_index: `UserTradeIndex(${args.tradeIndex})` },
  };
  const wasmMsgBytes = ethers.toUtf8Bytes(JSON.stringify(wasmMsg));

  const perpVault = new ethers.Contract(cfg.evmInterface, PERP_VAULT_EVM_ABI, wallet);
  const sim = await simulate(provider, evmAddress, () =>
    perpVault.executeSimpleFunctions.estimateGas(wasmMsgBytes),
  );

  const summary = {
    network: args.network,
    action,
    trade: {
      index: args.tradeIndex,
      symbol: marketSymbol(trade),
      direction: trade.isLong ? "long" : "short",
      leverage: trade.leverage,
      tradeType: trade.tradeType,
      pnlCollateral: trade.state?.pnlCollateral ?? null,
      pnlPct: trade.state?.pnlPct ?? null,
    },
    wallet: { evmAddress, bech32Address, nonce: sim.nonce, chainId: sim.chainId },
    gas: gasSummary(sim),
    wasmMsg,
  };

  const simulationNote = interpretSimulationError(sim.estimationError, action);

  if (!args.confirm) {
    return {
      ...summary,
      ...(simulationNote ? { simulationNote } : {}),
      ...(advisory ? { warning: advisory } : {}),
      status: "dry-run",
      note: `No transaction sent. Pass confirm=true to ${isPendingOrder ? "cancel this order" : "close this position"}.`,
    };
  }
  if (sim.estimationError) {
    throw new Error(
      `Refusing to broadcast: ${simulationNote ?? sim.estimationError} Re-run with confirm=false to inspect.`,
    );
  }
  return {
    ...summary,
    ...(await broadcast(
      perpVault.executeSimpleFunctions(wasmMsgBytes, {
        gasLimit: sim.gasLimit,
        gasPrice: 0n,
      }),
      cfg,
      revertHint,
    )),
  };
}

// ---------------------------------------------------------------------------
// sai_update_tpsl — set or clear take-profit / stop-loss
// ---------------------------------------------------------------------------

export const updateTpSlSchema = {
  network: NetworkSchema,
  tradeIndex: z
    .number()
    .int()
    .nonnegative()
    .describe("The trade's per-user index (the `id` from sai_get_trader_trades)."),
  tp: z
    .number()
    .positive()
    .finite()
    .nullable()
    .optional()
    .describe(
      "New take-profit price. Omit to leave TP unchanged; pass null to clear an existing TP; pass a price to set it.",
    ),
  sl: z
    .number()
    .positive()
    .finite()
    .nullable()
    .optional()
    .describe(
      "New stop-loss price. Omit to leave SL unchanged; pass null to clear an existing SL; pass a price to set it.",
    ),
  confirm: ConfirmSchema,
};

export async function updateTpSl(args: {
  network: Network;
  tradeIndex: number;
  tp?: number | null;
  sl?: number | null;
  confirm: boolean;
}) {
  const tpProvided = args.tp !== undefined;
  const slProvided = args.sl !== undefined;
  if (!tpProvided && !slProvided) {
    throw new Error(
      "Nothing to update: provide tp and/or sl (a price to set, or null to clear).",
    );
  }

  const { wallet, provider, evmAddress, bech32Address, cfg } = getWallet(args.network);
  const trade = await fetchTrade(args.network, args.tradeIndex, bech32Address);
  if (!trade.isOpen) {
    throw new Error(`Trade ${args.tradeIndex} is closed; nothing to update.`);
  }

  const ageSec = positionAgeSeconds(trade);
  const advisory = recentOpenAdvisory(ageSec, "modify");
  const revertHint = revertRetryHint(ageSec);

  // Direction sanity for newly-set targets, mirroring sai_open_trade: a TP/SL on
  // the wrong side of the live price triggers immediately. Skipped when clearing
  // (null) or leaving unchanged (omitted).
  const price = trade.perpBorrowing.price;
  if (price > 0) {
    const settingTp = tpProvided && args.tp !== null;
    const settingSl = slProvided && args.sl !== null;
    if (trade.isLong) {
      if (settingTp && (args.tp as number) <= price)
        throw new Error(`LONG take-profit (${args.tp}) must be above current price (${price}).`);
      if (settingSl && (args.sl as number) >= price)
        throw new Error(`LONG stop-loss (${args.sl}) must be below current price (${price}).`);
    } else {
      if (settingTp && (args.tp as number) >= price)
        throw new Error(`SHORT take-profit (${args.tp}) must be below current price (${price}).`);
      if (settingSl && (args.sl as number) <= price)
        throw new Error(`SHORT stop-loss (${args.sl}) must be above current price (${price}).`);
    }
  }

  // Contract semantics: omit a field to leave it unchanged; send "0" to clear it.
  const inner: Record<string, unknown> = {
    trade_index: `UserTradeIndex(${args.tradeIndex})`,
  };
  if (args.tp !== undefined)
    inner.new_tp = args.tp === null ? "0" : toPlainDecimalString(args.tp);
  if (args.sl !== undefined)
    inner.new_sl = args.sl === null ? "0" : toPlainDecimalString(args.sl);
  const wasmMsg = { update_tp: inner };
  const wasmMsgBytes = ethers.toUtf8Bytes(JSON.stringify(wasmMsg));

  const perpVault = new ethers.Contract(cfg.evmInterface, PERP_VAULT_EVM_ABI, wallet);
  const sim = await simulate(provider, evmAddress, () =>
    perpVault.executeSimpleFunctions.estimateGas(wasmMsgBytes),
  );

  // NOTE: `trade.tp` / `trade.sl` (the `from` values below) come from the
  // keeper's indexed PerpTrade record, which is delayed behind the chain by a few seconds /
  // blocks. Immediately after broadcasting an update, a re-read can still show
  // the pre-update value (or null), so `from` may be briefly stale right after
  // a confirmed `tpsl_updated` event before the indexer catches up — it is NOT
  // a reliable read-your-writes source. A null `from` therefore does not prove
  // no target is set on-chain. The update itself is correct regardless (omit a
  // field to preserve it, send "0" to clear).
  const describe = (
    provided: boolean,
    value: number | null | undefined,
    current: number | null,
  ) => (!provided ? `unchanged (${current ?? "none"})` : value === null ? "cleared" : value);

  const summary = {
    network: args.network,
    action: "update-tpsl",
    trade: {
      index: args.tradeIndex,
      symbol: marketSymbol(trade),
      direction: trade.isLong ? "long" : "short",
      currentPrice: price,
      liquidationPrice: trade.state?.liquidationPrice ?? null,
    },
    changes: {
      tp: { from: trade.tp, to: describe(tpProvided, args.tp, trade.tp) },
      sl: { from: trade.sl, to: describe(slProvided, args.sl, trade.sl) },
    },
    wallet: { evmAddress, bech32Address, nonce: sim.nonce, chainId: sim.chainId },
    gas: gasSummary(sim),
    wasmMsg,
  };

  const simulationNote = interpretSimulationError(sim.estimationError, "update-tpsl");

  if (!args.confirm) {
    return {
      ...summary,
      ...(simulationNote ? { simulationNote } : {}),
      ...(advisory ? { warning: advisory } : {}),
      status: "dry-run",
      note: "No transaction sent. Pass confirm=true to apply.",
    };
  }
  if (sim.estimationError) {
    throw new Error(
      `Refusing to broadcast: ${simulationNote ?? sim.estimationError} Re-run with confirm=false to inspect.`,
    );
  }
  return {
    ...summary,
    ...(await broadcast(
      perpVault.executeSimpleFunctions(wasmMsgBytes, {
        gasLimit: sim.gasLimit,
        gasPrice: 0n,
      }),
      cfg,
      revertHint,
    )),
  };
}

// ---------------------------------------------------------------------------
// sai_update_leverage — change a position's leverage (settles a collateral delta)
// ---------------------------------------------------------------------------

export const updateLeverageSchema = {
  network: NetworkSchema,
  tradeIndex: z
    .number()
    .int()
    .nonnegative()
    .describe("The trade's per-user index (the `id` from sai_get_trader_trades)."),
  newLeverage: z
    .number()
    .int()
    .positive()
    .finite()
    .describe(
      "New leverage. Must be a whole number (EVM constraint) within the market's min/max. Raising leverage frees collateral back to the wallet; lowering it pulls additional USDC collateral from the wallet (position notional is held constant).",
    ),
  confirm: ConfirmSchema,
};

export async function updateLeverage(args: {
  network: Network;
  tradeIndex: number;
  newLeverage: number;
  confirm: boolean;
}) {
  const guards = loadTradeGuards();
  const { wallet, provider, evmAddress, bech32Address, cfg } = getWallet(args.network);
  const trade = await fetchTrade(args.network, args.tradeIndex, bech32Address);

  if (!trade.isOpen) {
    throw new Error(`Trade ${args.tradeIndex} is closed; leverage cannot be changed.`);
  }
  if (trade.tradeType !== "trade") {
    throw new Error(
      `Trade ${args.tradeIndex} is a pending ${trade.tradeType} order, not an open position; leverage cannot be adjusted.`,
    );
  }

  const ageSec = positionAgeSeconds(trade);
  const advisory = recentOpenAdvisory(ageSec, "modify");
  const revertHint = revertRetryHint(ageSec);

  const collateralIndex = trade.perpBorrowing.collateralToken.id;
  if (collateralIndex !== cfg.usdcTokenIndex) {
    throw new Error(
      `Leverage updates via this MCP only support USDC-collateral positions (trade uses collateral index ${collateralIndex}).`,
    );
  }

  // Operator guards: allowlist + leverage cap still apply to a raise.
  if (guards.marketAllowlist && !guards.marketAllowlist.has(trade.perpBorrowing.marketId)) {
    throw new Error(
      `Market ${trade.perpBorrowing.marketId} is not in SAI_MARKET_ALLOWLIST; operator has restricted which markets this MCP may trade.`,
    );
  }
  if (guards.maxLeverage !== null && args.newLeverage > guards.maxLeverage) {
    throw new Error(
      `newLeverage=${args.newLeverage} exceeds SAI_MAX_LEVERAGE=${guards.maxLeverage}.`,
    );
  }

  const b = trade.perpBorrowing;
  if (args.newLeverage < b.minLeverage || args.newLeverage > b.maxLeverage) {
    throw new Error(
      `newLeverage ${args.newLeverage} outside market range [${b.minLeverage}, ${b.maxLeverage}].`,
    );
  }
  if (args.newLeverage === trade.leverage) {
    throw new Error(`Trade ${args.tradeIndex} is already at ${trade.leverage}x.`);
  }

  // Notional-preserving collateral delta (matches the webapp's
  // getLeverageCollateralDelta, ROUND_FLOOR). Amounts are in USDC base units.
  const existingCollateral = BigInt(trade.collateralAmount);
  const isIncrease = args.newLeverage > trade.leverage;
  const newCollateral = BigInt(
    Math.floor((Number(existingCollateral) * trade.leverage) / args.newLeverage),
  );
  const collateralDelta = isIncrease
    ? existingCollateral - newCollateral
    : newCollateral - existingCollateral;
  // On a raise the contract returns the freed collateral; no funds are pulled.
  const fundAmount = isIncrease || collateralDelta < 0n ? 0n : collateralDelta;

  const perpVault = new ethers.Contract(cfg.evmInterface, PERP_VAULT_EVM_ABI, wallet);
  const usdc = new ethers.Contract(cfg.usdcEvm, ERC20_ABI, wallet);
  const erc20Balance: bigint = await usdc.balanceOf(evmAddress);
  if (fundAmount > 0n && erc20Balance < fundAmount) {
    throw new Error(
      `Insufficient USDC to lower leverage: need ${ethers.formatUnits(fundAmount, USDC_DECIMALS)} more collateral, wallet has ${ethers.formatUnits(erc20Balance, USDC_DECIMALS)}.`,
    );
  }

  const sim = await simulate(provider, evmAddress, () =>
    perpVault.updateLeverage.estimateGas(
      args.tradeIndex,
      args.newLeverage,
      collateralIndex,
      fundAmount,
      fundAmount,
    ),
  );

  const summary = {
    network: args.network,
    action: "update-leverage",
    trade: {
      index: args.tradeIndex,
      symbol: marketSymbol(trade),
      direction: trade.isLong ? "long" : "short",
      fromLeverage: trade.leverage,
      toLeverage: args.newLeverage,
    },
    collateral: {
      direction: isIncrease ? "freed-to-wallet" : "pulled-from-wallet",
      deltaUsdc: ethers.formatUnits(collateralDelta < 0n ? 0n : collateralDelta, USDC_DECIMALS),
      fromUsdc: ethers.formatUnits(existingCollateral, USDC_DECIMALS),
      toUsdc: ethers.formatUnits(newCollateral, USDC_DECIMALS),
    },
    wallet: {
      evmAddress,
      bech32Address,
      usdcBalance: ethers.formatUnits(erc20Balance, USDC_DECIMALS),
      nonce: sim.nonce,
      chainId: sim.chainId,
    },
    guards: { maxLeverage: guards.maxLeverage },
    gas: gasSummary(sim),
  };

  const simulationNote = interpretSimulationError(sim.estimationError, "update-leverage");

  if (!args.confirm) {
    return {
      ...summary,
      ...(simulationNote ? { simulationNote } : {}),
      ...(advisory ? { warning: advisory } : {}),
      status: "dry-run",
      note: "No transaction sent. Pass confirm=true to apply.",
    };
  }
  if (sim.estimationError) {
    throw new Error(
      `Refusing to broadcast: ${simulationNote ?? sim.estimationError} Re-run with confirm=false to inspect.`,
    );
  }
  return {
    ...summary,
    ...(await broadcast(
      perpVault.updateLeverage(
        args.tradeIndex,
        args.newLeverage,
        collateralIndex,
        fundAmount,
        fundAmount,
        { gasLimit: sim.gasLimit, gasPrice: 0n },
      ),
      cfg,
      revertHint,
    )),
  };
}
