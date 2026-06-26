import { z } from "zod";
import { graphqlRequest, type Network } from "../client.js";
import { normalizeTraderAddress } from "../chain.js";

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
    }
  `;
  return graphqlRequest(
    query,
    { collateralId: args.collateralId, marketId: args.marketId },
    args.network,
  );
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
  return graphqlRequest(
    query,
    {
      where: { trader: normalizeTraderAddress(args.trader) },
      limit: args.limit,
      offset: args.offset,
    },
    args.network,
  );
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
