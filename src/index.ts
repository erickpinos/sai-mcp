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
import {
  getReferrals,
  getReferralsSchema,
  getReferralForTrader,
  getReferralForTraderSchema,
} from "./tools/referral.js";
import { getLeaderboard, getLeaderboardSchema } from "./tools/leaderboard.js";
import {
  getProtocolStats,
  getProtocolStatsSchema,
  getYieldOpportunities,
  getYieldOpportunitiesSchema,
} from "./tools/stats.js";
import { getCandles, getCandlesSchema } from "./tools/candles.js";
import { rawQuery, rawQuerySchema } from "./tools/raw.js";
import { getWalletInfo, getWalletInfoSchema } from "./tools/wallet.js";
import { openTrade, openTradeSchema } from "./tools/trade.js";
import {
  closeTrade,
  closeTradeSchema,
  updateTpSl,
  updateTpSlSchema,
  updateLeverage,
  updateLeverageSchema,
} from "./tools/manage.js";

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
  "List Sai perpetual markets (100+, marketId, base/quote/collateral tokens, visibility, isOpen, and tradingSchedule name/timezone for scheduled markets). Covers crypto (low IDs: 0=BTC, 1=ETH, 16=SOL) and US stocks (IDs 1000+: 1000=QQQ, 1001=SPY, 1002=NVDA, ...). For full per-market details (price, OI, funding, fees, full schedule) call sai_get_market with the marketId.",
  listMarketsSchema,
  listMarkets,
);

register(
  "sai_get_market",
  "Get a single perpetual market's full info: price, 24h change, volume, open interest, funding rates, leverage caps, fees, price impact parameters, isOpen, and (for US-stock/commodity markets) the tradingSchedule with hours, timezone, and holidays.",
  getMarketSchema,
  getMarket,
);

register(
  "sai_get_trader_trades",
  "List a trader's open and closed perpetual positions with live PnL, leverage, liquidation price, tp/sl, and accumulated fees. NOTE: this reads the keeper's indexed state, which is delayed behind the chain by a few seconds to ~1-2 minutes. It is NOT read-your-writes: immediately after a sai_open_trade / sai_update_tpsl / sai_update_leverage / sai_close_trade broadcast, this may still show the pre-update values (stale leverage, tp/sl, or open/closed state). To confirm a write took effect, trust the broadcast's tx receipt (status: success) and/or the matching sai_get_trader_history event; only treat this query as authoritative once the indexer has caught up.",
  getTraderTradesSchema,
  getTraderTrades,
);

register(
  "sai_get_trader_history",
  "List a trader's position events (position_opened, position_closed, liquidation, tpsl_updated, leverage updates, SL/TP triggered) with realized PnL, tx hashes (cosmos + evm), and block timestamps. This is the per-event audit log and the best way to confirm a write landed (match on the broadcast's evmTxHash). Like sai_get_trader_trades it reads indexed state, so a just-broadcast event may take a few seconds to ~1-2 minutes to appear.",
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

// Referrals
register(
  "sai_get_referrals",
  "Get a referrer's program data: their referral codes (with unique traders, earnings, volume), recent attributed trades, claim events, and an earnings/volume time series over a range.",
  getReferralsSchema,
  getReferrals,
);

register(
  "sai_get_referral_for_trader",
  "Look up which referral code (and referrer) a given trader redeemed, if any. Returns empty when the trader has not redeemed a code.",
  getReferralForTraderSchema,
  getReferralForTrader,
);

// Leaderboards
register(
  "sai_get_leaderboard",
  "Get a Sai leaderboard: 'pnl' (realized PnL, ROI, capital used + rewards), 'volume' and 'volumeMarathon' (volume races), or 'cookout' (event leaderboard). Each row includes trader address and reward.",
  getLeaderboardSchema,
  getLeaderboard,
);

// Protocol-wide stats and yield (keeper REST / dexpal API)
register(
  "sai_get_protocol_stats",
  "Get exchange-wide aggregate stats (USD): trading volume (24h/7d/30d/all-time), trade counts, open interest, unique users, open positions, TVL, and accrued trading fees. Answers protocol-level questions like total fees collected this week. Served by the keeper REST API, not GraphQL.",
  getProtocolStatsSchema,
  getProtocolStats,
);

register(
  "sai_get_yield_opportunities",
  "List Sai yield/earning opportunities (LP vaults) with accepted deposits, APY/APR, and TVL. Served by the keeper REST API.",
  getYieldOpportunitiesSchema,
  getYieldOpportunities,
);

// Candles (OHLCV)
register(
  "sai_get_candles",
  "Get OHLCV candles for a market by base symbol (e.g. BTC, ETH, NVDA) at a resolution (1/5/15/60/240/360/720 minutes, or 1D/1W/1M). Provide an explicit from/to Unix-second range, or a countback for the most recent N bars. Served by the keeper candles (TradingView UDF) API.",
  getCandlesSchema,
  getCandles,
);

// Escape hatch
register(
  "sai_graphql_query",
  "Run an arbitrary GraphQL query against the sai-keeper endpoint. Escape hatch for queries not covered by the typed tools — leaderboards, referrals, portfolio drill-downs, etc. Schema explorer: https://sai-keeper.nibiru.fi/",
  rawQuerySchema,
  rawQuery,
);

// Write tools — require SAI_MNEMONIC or SAI_PRIVATE_KEY env var on the MCP server.
register(
  "sai_get_wallet_info",
  "Return the configured signer's EVM and bech32 addresses, NIBI and USDC balances, current nonce, and chain config. Requires SAI_MNEMONIC or SAI_PRIVATE_KEY in the MCP server environment. Call this first to confirm which wallet is loaded before any write operation.",
  getWalletInfoSchema,
  getWalletInfo,
);

register(
  "sai_open_trade",
  "Open a long or short perpetual position on Sai using USDC collateral. Defaults to a DRY RUN that simulates and gas-estimates the trade without broadcasting — set confirm=true to actually send the transaction. The signer is loaded from SAI_MNEMONIC or SAI_PRIVATE_KEY on the MCP server. Always preview with confirm=false (or omit it) and show the summary to the user before re-running with confirm=true.",
  openTradeSchema,
  openTrade,
);

register(
  "sai_close_trade",
  "Close an open Sai perpetual position, or cancel a pending limit/stop order (same on-chain call — the contract distinguishes by the trade's state). Identify the trade by its per-user index (the `id` from sai_get_trader_trades). Defaults to a DRY RUN that simulates and gas-estimates without broadcasting — set confirm=true to actually send. The signer is loaded from SAI_MNEMONIC or SAI_PRIVATE_KEY; only the signer's own trades can be managed. Caveat: closing a position within ~1-2 minutes of opening it can revert on-chain even when the dry-run gas estimate succeeds (the contract enforces a brief minimum hold); if a confirmed close reverts, wait ~1-2 minutes and retry. The dry-run flags a freshly-opened position under `warning`.",
  closeTradeSchema,
  closeTrade,
);

register(
  "sai_update_tpsl",
  "Set or clear the take-profit and/or stop-loss on an open Sai position. Omit a field to leave it unchanged, pass a price to set it, or pass null to clear it. Validates that newly-set targets are on the correct side of the live price. Identify the trade by its `id` from sai_get_trader_trades. Defaults to a DRY RUN — set confirm=true to broadcast. Signer from SAI_MNEMONIC or SAI_PRIVATE_KEY.",
  updateTpSlSchema,
  updateTpSl,
);

register(
  "sai_update_leverage",
  "Change the leverage on an open Sai position (USDC collateral only). Notional is held constant: raising leverage frees collateral back to the wallet, lowering it pulls additional USDC from the wallet. newLeverage must be a whole number within the market's min/max. Identify the trade by its `id` from sai_get_trader_trades. Defaults to a DRY RUN — set confirm=true to broadcast. Signer from SAI_MNEMONIC or SAI_PRIVATE_KEY.",
  updateLeverageSchema,
  updateLeverage,
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
