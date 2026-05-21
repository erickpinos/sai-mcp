#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  listMarkets,
  listMarketsSchema,
  getMarket,
  getMarketSchema,
  getTraderTrades,
  getTraderTradesSchema,
  getTraderHistory,
  getTraderHistorySchema,
  getUserPortfolio,
  getUserPortfolioSchema,
  getFeeTierProgress,
  getFeeTierProgressSchema,
} from "./tools/perp.js";
import {
  listVaults,
  listVaultsSchema,
  getVaultStats,
  getVaultStatsSchema,
  getDepositHistory,
  getDepositHistorySchema,
  getWithdrawRequests,
  getWithdrawRequestsSchema,
} from "./tools/lp.js";
import {
  getTokenPrices,
  getTokenPricesSchema,
  listTokens,
  listTokensSchema,
} from "./tools/oracle.js";
import { rawQuery, rawQuerySchema } from "./tools/raw.js";

const server = new McpServer({
  name: "sai-mcp",
  version: "0.1.0",
});

type AnyShape = Record<string, unknown>;

function asText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function register<S extends AnyShape>(
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: any) => Promise<unknown>,
) {
  server.registerTool(
    name,
    { description, inputSchema: inputSchema as never },
    (async (args: unknown) => {
      try {
        const result = await handler(args);
        return asText(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${message}` }],
        };
      }
    }) as never,
  );
}

// Perp — markets and trading
register(
  "sai_list_markets",
  "List Sai perpetual markets (marketId, base/quote/collateral tokens, visibility). For full per-market details (price, OI, funding, fees) call sai_get_market with the marketId.",
  listMarketsSchema,
  listMarkets,
);

register(
  "sai_get_market",
  "Get a single perpetual market's full info: price, 24h change, volume, open interest, funding rates, leverage caps, fees, and price impact parameters.",
  getMarketSchema,
  getMarket,
);

register(
  "sai_get_trader_trades",
  "List a trader's open and closed perpetual positions with real-time PnL, leverage, liquidation price, and accumulated fees.",
  getTraderTradesSchema,
  getTraderTrades,
);

register(
  "sai_get_trader_history",
  "List a trader's position events (open, close, liquidation, SL/TP triggered) with realized PnL, tx hashes, and block timestamps.",
  getTraderHistorySchema,
  getTraderHistory,
);

register(
  "sai_get_user_portfolio",
  "Get a trader's portfolio stats: realized PnL, pending PnL, volume, and trade counts for a given time range ('1d', '7d', '30d', 'all').",
  getUserPortfolioSchema,
  getUserPortfolio,
);

register(
  "sai_get_fee_tier_progress",
  "Get a trader's fee tier progress: current tier, fee multiplier, trailing points, distance to next tier, and tier drop risk.",
  getFeeTierProgressSchema,
  getFeeTierProgress,
);

// LP / vaults
register(
  "sai_list_vaults",
  "List all Sai LP vaults (USDC, stNIBI) with TVL, share price, APY, fee APY, current epoch, and full revenue breakdown.",
  listVaultsSchema,
  listVaults,
);

register(
  "sai_get_vault_stats",
  "Get time-series stats for a single vault over a range ('1d', '7d', '30d', 'all').",
  getVaultStatsSchema,
  getVaultStats,
);

register(
  "sai_get_deposit_history",
  "List vault deposit/withdrawal events with amounts, shares, action type, and tx hashes. Filter by depositor or vault.",
  getDepositHistorySchema,
  getDepositHistory,
);

register(
  "sai_get_withdraw_requests",
  "List pending vault withdrawal requests with unlock epoch and auto-redeem flag. Filter by depositor or vault.",
  getWithdrawRequestsSchema,
  getWithdrawRequests,
);

// Oracle
register(
  "sai_get_token_prices",
  "Get current USD oracle prices for tokens tracked by Sai. Omit tokenId to get all prices.",
  getTokenPricesSchema,
  getTokenPrices,
);

register(
  "sai_list_tokens",
  "List all tokens known to the Sai oracle (id, symbol, name, description, type).",
  listTokensSchema,
  listTokens,
);

// Escape hatch
register(
  "sai_graphql_query",
  "Run an arbitrary GraphQL query against the sai-keeper endpoint. Escape hatch for queries not covered by the typed tools — leaderboards, referrals, portfolio drill-downs, etc. Schema explorer: https://sai-keeper.nibiru.fi/",
  rawQuerySchema,
  rawQuery,
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("sai-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
