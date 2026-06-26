import { z } from "zod";
import { graphqlRequest, type Network } from "../client.js";
import { normalizeTraderAddress } from "../chain.js";
import { microsToUnits, ratioToPctString } from "../format.js";

const NetworkSchema = z
  .enum(["mainnet", "testnet"])
  .default("mainnet")
  .describe("Network to query. Defaults to mainnet.");

const TRADER_ADDRESS_DESC =
  "Trader address: a Nibiru bech32 address (nibi1...) or an EVM hex address (0x...). Both forms resolve to the same wallet.";

export const listMarketsSchema = {
  network: NetworkSchema,
  visibleOnly: z
    .boolean()
    .default(true)
    .describe("Filter to only visible (live) markets."),
  limit: z.number().int().positive().max(500).default(200),
};

export async function listMarkets(args: {
  network: Network;
  visibleOnly: boolean;
  limit: number;
}) {
  // `borrowings` returns the short shape — for full market details use sai_get_market.
  // `tradingSchedule` is non-null for scheduled markets (US stocks, commodities)
  // and null for 24/7 crypto markets; `isOpen` reflects the live tradeable state.
  const query = `
    query Markets($limit: Int) {
      perp {
        borrowings(limit: $limit) {
          marketId
          baseToken { id symbol name }
          quoteToken { symbol }
          collateralToken { id symbol name }
          visible
          isOpen
          tradingSchedule { name timezone }
        }
      }
    }
  `;
  const data = await graphqlRequest<{
    perp: { borrowings: Array<{ visible: boolean }> };
  }>(query, { limit: args.limit }, args.network);
  return args.visibleOnly
    ? data.perp.borrowings.filter((b) => b.visible)
    : data.perp.borrowings;
}

export const getMarketSchema = {
  network: NetworkSchema,
  marketId: z
    .number()
    .int()
    .describe(
      "Market ID. Crypto markets are low IDs (0 = BTC, 1 = ETH, 16 = SOL); US-stock markets are 1000+ (e.g. 1000 = QQQ, 1001 = SPY, 1002 = NVDA). Call sai_list_markets to enumerate all (100+) markets.",
    ),
  collateralId: z
    .number()
    .int()
    .describe("Collateral token ID (1 = USDC, 2 = stNIBI)."),
};

export async function getMarket(args: {
  network: Network;
  marketId: number;
  collateralId: number;
}) {
  const query = `
    query Market($collateralId: Int!, $marketId: Int!) {
      perp {
        borrowing(collateralId: $collateralId, marketId: $marketId) {
          marketId
          baseToken { id symbol name logoUrl }
          quoteToken { symbol }
          collateralToken { id symbol name }
          price
          price24HrsAgo
          priceChangePct24Hrs
          minPrice24Hrs
          maxPrice24Hrs
          # Cumulative all-time USD volume for this market. NOT a 24h figure
          volumeUsd
          oiLong
          oiShort
          oiMax
          feesPerHourLong
          feesPerHourShort
          openFeePct
          closeFeePct
          triggerOrderFeePct
          maxLeverage
          minLeverage
          minPositionSizeUSD
          priceImpactOiLongUsd
          priceImpactOiShortUsd
          priceImpactOnePercentDepthAboveUsd
          priceImpactOnePercentDepthBelowUsd
          priceImpactExponent
          visible
          isOpen
          tradingSchedule {
            name
            timezone
            startDayOfWeek
            startTimeOfDay
            closeDayOfWeek
            closeTimeOfDay
            holidays
          }
        }
      }
      oracle {
        tokenPricesUsd(limit: 500) {
          token { symbol }
          priceUsd
        }
      }
    }
  `;
  const data = await graphqlRequest<{
    perp: { borrowing: Record<string, any> | null } | null;
    oracle: {
      tokenPricesUsd: Array<{ token: { symbol: string }; priceUsd: number }>;
    } | null;
  }>(
    query,
    { collateralId: args.collateralId, marketId: args.marketId },
    args.network,
  );

  // oiLong / oiShort / oiMax are micro-units of the COLLATERAL token, not USD.
  // /1e6 yields collateral tokens; USD additionally needs the collateral price.
  // For USDC (~$1) the price step is a ~no-op, but for stNIBI-collateral markets
  // (~$0.0023) skipping it overstates USD ~440x. Attach a units-explicit `human`
  // projection with the OI in USD, mirroring sai_list_vaults. Non-breaking: the
  // raw oi* fields are preserved.
  const b = data?.perp?.borrowing;
  if (b) {
    const symbol: string | null = b.collateralToken?.symbol ?? null;
    const price = symbol
      ? data?.oracle?.tokenPricesUsd?.find((p) => p.token?.symbol === symbol)
          ?.priceUsd ?? null
      : null;
    const oiLongTokens = microsToUnits(b.oiLong);
    const oiShortTokens = microsToUnits(b.oiShort);
    const oiMaxTokens = microsToUnits(b.oiMax);
    const usd = (t: number | null) =>
      t !== null && price !== null ? t * price : null;
    b.human = {
      collateralToken: symbol,
      collateralPriceUsd: price === null ? null : Number(price),
      oiLongUsd: usd(oiLongTokens),
      oiShortUsd: usd(oiShortTokens),
      oiMaxUsd: usd(oiMaxTokens),
      note: "oiLong / oiShort / oiMax are micro-units of the collateral token, NOT USD: divide by 1e6 for collateral tokens, then multiply by collateralPriceUsd for USD. For USDC markets that USD value ~= the token amount; for stNIBI markets it differs ~440x. (price / priceChangePct24Hrs / fee percents are already in their natural units.)",
    };
  }

  // The oracle list was fetched only for the join; return the original shape.
  return { perp: data.perp };
}

export const getTraderTradesSchema = {
  network: NetworkSchema,
  trader: z.string().min(1).describe(TRADER_ADDRESS_DESC),
  isOpen: z
    .boolean()
    .optional()
    .describe("Filter to open or closed trades only."),
  marketId: z.number().int().optional().describe("Filter by perp market id."),
  collateralId: z
    .number()
    .int()
    .optional()
    .describe("Filter by perp collateral id."),
  limit: z.number().int().positive().max(500).default(50),
  offset: z.number().int().nonnegative().default(0),
};

export async function getTraderTrades(args: {
  network: Network;
  trader: string;
  isOpen?: boolean;
  marketId?: number;
  collateralId?: number;
  limit: number;
  offset: number;
}) {
  const where: Record<string, unknown> = {
    trader: normalizeTraderAddress(args.trader),
  };
  if (args.isOpen !== undefined) where.isOpen = args.isOpen;
  if (args.collateralId !== undefined) where.perpCollateralId = args.collateralId;
  // NOTE: the keeper's `perpMarketId` filter is broken server-side. It
  // generates SQL referencing a non-existent column `pt.market_id`
  // (SQLSTATE 42703), so passing it 500s the whole query. We omit it from the
  // server `where` and filter by marketId client-side below. When marketId is
  // set we fetch the full page (schema max) and paginate the filtered result
  // ourselves so limit/offset still apply to the per-market set.
  const marketFilter = args.marketId !== undefined;

  const query = `
    query Trades($where: PerpTradesFilter!, $limit: Int, $offset: Int) {
      perp {
        trades(where: $where, limit: $limit, offset: $offset, order_desc: true) {
          id
          trader
          isOpen
          isLong
          tradeType
          leverage
          collateralAmount
          openCollateralAmount
          openPrice
          closePrice
          sl
          tp
          perpBorrowing {
            marketId
            baseToken { symbol }
            collateralToken { symbol }
          }
          openBlock { block block_ts }
          closeBlock { block block_ts }
          state {
            pnlCollateral
            pnlPct
            pnlCollateralAfterFees
            positionValue
            liquidationPrice
            borrowingFeeCollateral
            borrowingFeePct
            closingFeeCollateral
            closingFeePct
            remainingCollateralAfterFees
          }
        }
      }
    }
  `;
  const data = await graphqlRequest<{
    perp: { trades: Array<{ perpBorrowing: { marketId: number } }> } | null;
  }>(
    query,
    {
      where,
      limit: marketFilter ? 500 : args.limit,
      offset: marketFilter ? 0 : args.offset,
    },
    args.network,
  );

  if (marketFilter && data?.perp?.trades) {
    const filtered = data.perp.trades.filter(
      (t) => t.perpBorrowing?.marketId === args.marketId,
    );
    data.perp.trades = filtered.slice(args.offset, args.offset + args.limit);
  }

  // Bug #3: the keeper's per-trade `state` mixes unit conventions under
  // similarly-named fields: *Collateral fields are micro-units of the
  // collateral token (divide by 1e6), while *Pct fields are RAW RATIOS, not
  // percents (-0.011 means -1.1%). Reading them verbatim invites a
  // 6-orders-of-magnitude misread, so attach a units-explicit `human`
  // projection next to (not replacing) the raw fields. Non-breaking: raw fields
  // are preserved for any client already depending on them.
  for (const t of (data?.perp?.trades ?? []) as Array<Record<string, any>>) {
    const s = t.state;
    if (!s) continue;
    s.human = {
      collateralToken: t.perpBorrowing?.collateralToken?.symbol ?? null,
      pnl: microsToUnits(s.pnlCollateral),
      pnlAfterFees: microsToUnits(s.pnlCollateralAfterFees),
      pnlPct: ratioToPctString(s.pnlPct),
      positionValue: microsToUnits(s.positionValue),
      borrowingFee: microsToUnits(s.borrowingFeeCollateral),
      closingFee: microsToUnits(s.closingFeeCollateral),
      remainingCollateralAfterFees: microsToUnits(s.remainingCollateralAfterFees),
      note: "Amounts are in collateralToken units (the raw state.*Collateral fields are micro-units, /1e6); pnlPct is the raw state.pnlPct ratio rendered as a percent.",
    };
  }
  return data;
}

export const getTraderHistorySchema = {
  network: NetworkSchema,
  trader: z.string().min(1).describe(TRADER_ADDRESS_DESC),
  limit: z.number().int().positive().max(500).default(50),
  offset: z.number().int().nonnegative().default(0),
};

export async function getTraderHistory(args: {
  network: Network;
  trader: string;
  limit: number;
  offset: number;
}) {
  const query = `
    query History($where: PerpTradeHistoryFilter, $limit: Int, $offset: Int) {
      perp {
        tradeHistory(where: $where, limit: $limit, offset: $offset, order_desc: true) {
          id
          tradeChangeType
          realizedPnlCollateral
          realizedPnlPct
          collateralPrice
          openingFeeUsd
          closingFeeUsd
          txHash
          evmTxHash
          block { block block_ts }
          trade {
            id
            isLong
            leverage
            perpBorrowing { baseToken { symbol } collateralToken { symbol } }
          }
        }
      }
    }
  `;
  const data = await graphqlRequest<{
    perp: { tradeHistory: Array<Record<string, any>> | null } | null;
  }>(
    query,
    {
      where: { trader: normalizeTraderAddress(args.trader) },
      limit: args.limit,
      offset: args.offset,
    },
    args.network,
  );

  // realizedPnlCollateral is micro-units of the position's collateral token (NOT
  // USD); realizedPnlPct is a raw ratio (0.0559 = 5.59%). Each row carries the
  // historical `collateralPrice` (plain USD at the event), so project PnL to
  // collateral tokens and on to USD. For stNIBI-collateral positions a verbatim
  // /1e6 read overstates the dollar PnL ~440x. openingFeeUsd / closingFeeUsd are
  // already USD. Non-breaking: raw fields preserved. realizedPnlCollateral is
  // null on position_opened rows -> human.realizedPnl stays null.
  for (const h of data?.perp?.tradeHistory ?? []) {
    const cp = Number(h.collateralPrice);
    const price = Number.isFinite(cp) && cp > 0 ? cp : null;
    const pnlTokens = microsToUnits(h.realizedPnlCollateral);
    h.human = {
      collateralToken: h.trade?.perpBorrowing?.collateralToken?.symbol ?? null,
      collateralPriceUsd: price,
      realizedPnl: pnlTokens,
      realizedPnlUsd:
        pnlTokens !== null && price !== null ? pnlTokens * price : null,
      realizedPnlPct: ratioToPctString(h.realizedPnlPct),
      note: "realizedPnl is in collateral-token units (raw realizedPnlCollateral is micro-units, /1e6); realizedPnlUsd = realizedPnl * collateralPriceUsd (the historical price at the event). realizedPnlPct is the raw ratio rendered as a percent. openingFeeUsd / closingFeeUsd are already USD.",
    };
  }

  return data;
}

export const getUserPortfolioSchema = {
  network: NetworkSchema,
  trader: z.string().min(1).describe(TRADER_ADDRESS_DESC),
  range: z
    .enum(["1d", "7d", "30d", "all"])
    .default("all")
    .describe("Time range. Defaults to 'all'."),
};

export async function getUserPortfolio(args: {
  network: Network;
  trader: string;
  range: "1d" | "7d" | "30d" | "all";
}) {
  const query = `
    query Portfolio($trader: String!, $range: String!) {
      perp {
        statsUserPortfolio(trader: $trader, range: $range) {
          trader
          timestamp
          realizedPnlUSD
          realizedPnlUSDCumulative
          pendingPnlUSDCumulative
          volumeUSD
          volumeUSDCumulative
          tradesCount
          tradesCountCumulative
        }
      }
    }
  `;
  return graphqlRequest(
    query,
    { trader: normalizeTraderAddress(args.trader), range: args.range },
    args.network,
  );
}

export const getFeeTierProgressSchema = {
  network: NetworkSchema,
  trader: z.string().min(1).describe(TRADER_ADDRESS_DESC),
};

export async function getFeeTierProgress(args: {
  network: Network;
  trader: string;
}) {
  const query = `
    query FeeTier($trader: String!) {
      perp {
        traderFeeTierProgress(trader: $trader) {
          trader
          currentDay
          trailingPoints
          currentTierLevel
          currentTierFeeMultiplier
          currentTierPointsThreshold
          nextTierLevel
          nextTierPointsThreshold
          pointsToNextTier
          progressWithinTierPct
          tradesCountWindow
          avgPointsPerTrade
          estTradesToNextTier
          tierDropAt
          dropToTierLevel
          pointsAtRisk
        }
      }
    }
  `;
  return graphqlRequest(
    query,
    { trader: normalizeTraderAddress(args.trader) },
    args.network,
  );
}
