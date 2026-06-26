// Operator-controlled trade guard rails. Configured via env vars on the MCP
// server so an agent calling the tools cannot raise its own ceiling — the
// agent only sees `Error: ...` if it exceeds a cap.
//
// All caps are opt-in: if the env var is unset, that dimension is uncapped
// and the underlying market constraints apply.

export type TradeGuards = {
  maxTradeUsdc: number | null;
  maxLeverage: number | null;
  maxPositionUsd: number | null;
  marketAllowlist: Set<number> | null;
};

function parsePositiveNumber(raw: string | undefined, name: string): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `${name} must be a positive finite number (got "${raw}"). Unset the env var to disable this cap.`,
    );
  }
  return n;
}

function parseMarketAllowlist(raw: string | undefined): Set<number> | null {
  if (raw === undefined || raw.trim() === "") return null;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(
          `SAI_MARKET_ALLOWLIST entry "${s}" is not a non-negative integer marketId.`,
        );
      }
      return n;
    });
  if (ids.length === 0) return null;
  return new Set(ids);
}

export function loadTradeGuards(): TradeGuards {
  return {
    maxTradeUsdc: parsePositiveNumber(process.env.SAI_MAX_TRADE_USDC, "SAI_MAX_TRADE_USDC"),
    maxLeverage: parsePositiveNumber(process.env.SAI_MAX_LEVERAGE, "SAI_MAX_LEVERAGE"),
    maxPositionUsd: parsePositiveNumber(process.env.SAI_MAX_POSITION_USD, "SAI_MAX_POSITION_USD"),
    marketAllowlist: parseMarketAllowlist(process.env.SAI_MARKET_ALLOWLIST),
  };
}

export type TradeRequest = {
  marketId: number;
  amountUsdc: number;
  leverage: number;
};

// Render the guards block for a tool summary. An all-null block (the previous
// behaviour) reads to a caller like "no safety configured" / a bug on a mainnet
// money tool. Instead, when no operator caps are set, return a self-explanatory
// object; when caps ARE set, return only the dimensions actually in effect.
export function summarizeGuards(
  guards: TradeGuards = loadTradeGuards(),
): Record<string, unknown> {
  const active: Record<string, unknown> = {};
  if (guards.maxTradeUsdc !== null) active.maxTradeUsdc = guards.maxTradeUsdc;
  if (guards.maxLeverage !== null) active.maxLeverage = guards.maxLeverage;
  if (guards.maxPositionUsd !== null) active.maxPositionUsd = guards.maxPositionUsd;
  if (guards.marketAllowlist)
    active.marketAllowlist = [...guards.marketAllowlist].sort((a, b) => a - b);
  if (Object.keys(active).length === 0) {
    return {
      configured: false,
      note: "No operator caps set on this MCP server; the chain's own market limits (leverage range, wallet balance, market open/closed) still apply.",
    };
  }
  return { configured: true, ...active };
}

export function assertTradeAllowed(req: TradeRequest, guards: TradeGuards = loadTradeGuards()): void {
  if (guards.marketAllowlist && !guards.marketAllowlist.has(req.marketId)) {
    const allowed = [...guards.marketAllowlist].sort((a, b) => a - b).join(", ");
    throw new Error(
      `Market ${req.marketId} is not in SAI_MARKET_ALLOWLIST (allowed: [${allowed}]). Operator has restricted which markets this MCP server may trade.`,
    );
  }
  if (guards.maxTradeUsdc !== null && req.amountUsdc > guards.maxTradeUsdc) {
    throw new Error(
      `amountUsdc=${req.amountUsdc} exceeds SAI_MAX_TRADE_USDC=${guards.maxTradeUsdc}. Operator has capped per-trade collateral.`,
    );
  }
  if (guards.maxLeverage !== null && req.leverage > guards.maxLeverage) {
    throw new Error(
      `leverage=${req.leverage} exceeds SAI_MAX_LEVERAGE=${guards.maxLeverage}. Operator has capped per-trade leverage.`,
    );
  }
  if (guards.maxPositionUsd !== null) {
    const positionUsd = req.amountUsdc * req.leverage;
    if (positionUsd > guards.maxPositionUsd) {
      throw new Error(
        `positionSizeUsd=${positionUsd} (amountUsdc * leverage) exceeds SAI_MAX_POSITION_USD=${guards.maxPositionUsd}. Operator has capped total notional.`,
      );
    }
  }
}
