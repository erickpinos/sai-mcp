import { z } from "zod";
import { graphqlRequest, type Network } from "../client.js";

const NetworkSchema = z
  .enum(["mainnet", "testnet"])
  .default("mainnet")
  .describe("Network to query. Defaults to mainnet.");

export const listMarketsSchema = {
  network: NetworkSchema,
  visibleOnly: z
    .boolean()
    .default(true)
    .describe("Filter to only visible (live) markets."),
  limit: z.number().int().positive().max(500).default(200),
};

export async function listMarkets(args: {
  network?: Network;
  visibleOnly?: boolean;
  limit?: number;
}) {
  // `borrowings` returns the short shape — for full market details use sai_get_market.
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
        }
      }
    }
  `;
  const data = await graphqlRequest<{
    perp: { borrowings: Array<{ visible: boolean }> };
  }>(query, { limit: args.limit ?? 200 }, args.network);
  return args.visibleOnly
    ? data.perp.borrowings.filter((b) => b.visible)
    : data.perp.borrowings;
}

export const getMarketSchema = {
  network: NetworkSchema,
  marketId: z.number().int().describe("Market ID (e.g. 0 for BTC, 1 for ETH, 16 for SOL)."),
  collateralId: z
    .number()
    .int()
    .describe("Collateral token ID (1 = USDC, 2 = stNIBI)."),
};

export async function getMarket(args: {
  network?: Network;
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
  trader: z.string().min(1).describe("Trader bech32 address (e.g. nibi1...)."),
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
  network?: Network;
  trader: string;
  isOpen?: boolean;
  marketId?: number;
  collateralId?: number;
  limit?: number;
  offset?: number;
}) {
  const where: Record<string, unknown> = { trader: args.trader };
  if (args.isOpen !== undefined) where.isOpen = args.isOpen;
  if (args.marketId !== undefined) where.perpMarketId = args.marketId;
  if (args.collateralId !== undefined) where.perpCollateralId = args.collateralId;

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
  return graphqlRequest(
    query,
    { where, limit: args.limit ?? 50, offset: args.offset ?? 0 },
    args.network,
  );
}

export const getTraderHistorySchema = {
  network: NetworkSchema,
  trader: z.string().min(1).describe("Trader bech32 address."),
  limit: z.number().int().positive().max(500).default(50),
  offset: z.number().int().nonnegative().default(0),
};

export async function getTraderHistory(args: {
  network?: Network;
  trader: string;
  limit?: number;
  offset?: number;
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
      where: { trader: args.trader },
      limit: args.limit ?? 50,
      offset: args.offset ?? 0,
    },
    args.network,
  );
}

export const getUserPortfolioSchema = {
  network: NetworkSchema,
  trader: z.string().min(1).describe("Trader bech32 address."),
  range: z
    .enum(["1d", "7d", "30d", "all"])
    .default("all")
    .describe("Time range. Defaults to 'all'."),
};

export async function getUserPortfolio(args: {
  network?: Network;
  trader: string;
  range?: "1d" | "7d" | "30d" | "all";
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
    { trader: args.trader, range: args.range ?? "all" },
    args.network,
  );
}

export const getFeeTierProgressSchema = {
  network: NetworkSchema,
  trader: z.string().min(1).describe("Trader bech32 address."),
};

export async function getFeeTierProgress(args: {
  network?: Network;
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
  return graphqlRequest(query, { trader: args.trader }, args.network);
}
