import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
import {
  resultEnvelopeSchema,
  walletInfoOutputSchema,
  openTradeOutputSchema,
  manageTradeOutputSchema,
} from "./output.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

// Server-level usage guidance, surfaced to clients in the initialize response.
// These are the protocol conventions and the write-tool safety model - facts a
// client/model needs to interpret results and operate the write tools safely,
// which otherwise only live in the README where the model never sees them.
const SERVER_INSTRUCTIONS = `sai-mcp exposes the Sai.fun decentralized perpetual-futures protocol on Nibiru Chain as MCP tools (live data from the sai-keeper indexer).

Conventions:
- network: every tool takes an optional network ("mainnet" | "testnet"), default mainnet.
- Micro-units: on-chain amounts (tvl, collateralAmount, oiLong, etc.) are integers in micro-units - divide by 10^decimals. USDC and stNIBI both use 6 decimals (divide by 1,000,000).
- Addresses: traders/depositors are Nibiru bech32 (nibi1...). The signer also has a 0x EVM address.
- Timestamps: block_ts is RFC3339.
- Funding-rate APR: feesPerHourLong * 24 * 365 * 100.
- Market IDs (mainnet): crypto uses low IDs (0=BTC, 1=ETH, 16=SOL); US-stock markets use IDs 1000+ (1000=QQQ, 1001=SPY, 1002=NVDA). Collateral IDs: 1=USDC, 2=stNIBI. Each (market, collateral) pair is a distinct market - sai_list_markets enumerates them all.
- Trading schedules: crypto trades 24/7 (tradingSchedule is null). US-stock/commodity markets carry a tradingSchedule and isOpen reflects whether they are currently tradeable; sai_open_trade rejects a closed market.

Reads are eventually-consistent:
- Read tools query a live indexer delayed behind the chain by a few seconds to ~1-2 minutes, and are NOT read-your-writes. Immediately after a write, sai_get_trader_trades may still show stale (pre-write) state. Confirm a write landed via the broadcast tx receipt (status: success) and/or the matching sai_get_trader_history event (match on evmTxHash), not sai_get_trader_trades.

Write tools (sai_open_trade, sai_close_trade, sai_update_tpsl, sai_update_leverage):
- Require a signer: set SAI_MNEMONIC or SAI_PRIVATE_KEY in the MCP server environment. Inert otherwise.
- DEFAULT TO DRY-RUN (confirm=false): they simulate + gas-estimate and return a summary WITHOUT signing or broadcasting. Always preview with confirm=false, show the summary to the user, then re-run with confirm=true to broadcast.
- Acting on a position within ~1-2 minutes of opening it can revert on-chain even when the dry-run gas estimate succeeds (the contract enforces a brief minimum hold that eth_estimateGas does not simulate). The close/update dry-runs flag this under "warning".

For anything the typed tools do not cover, use sai_graphql_query (schema explorer: https://sai-keeper.nibiru.fi/).`;

type AnyShape = Record<string, unknown>;

interface RegisterOpts {
  // Human-readable label for the tool (annotations.title).
  title: string;
  // True for the on-chain write tools - annotated as not read-only and
  // potentially destructive. Defaults to false (a read tool).
  destructive?: boolean;
  // Output schema for tools with a stable, in-repo result shape (the write
  // tools + wallet info). When omitted, the tool advertises the generic
  // `result` envelope and its payload is returned under structuredContent.result.
  outputSchema?: AnyShape;
}

// Build a fully-registered server instance. Both transports (stdio and the
// optional Streamable HTTP transport) call this, so tool/resource/prompt
// registration lives in exactly one place. This module is side-effect-free (no
// top-level main()), so http.ts can import it without pulling in the entry
// point. The register() helper is defined inside the factory so it closes over
// the local `server`.
export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "sai-mcp",
      version: "0.1.0",
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  function register<S extends AnyShape>(
    name: string,
    description: string,
    inputSchema: S,
    handler: (args: any) => Promise<unknown>,
    opts: RegisterOpts,
  ) {
    const destructive = opts.destructive ?? false;
    const annotations = destructive
      ? {
          title: opts.title,
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        }
      : {
          title: opts.title,
          readOnlyHint: true,
          openWorldHint: true,
        };

    // Tools with their own outputSchema return the handler result directly as
    // structuredContent; the rest wrap their payload in the `result` envelope.
    const hasOwnSchema = opts.outputSchema !== undefined;
    const outputSchema = opts.outputSchema ?? resultEnvelopeSchema;

    server.registerTool(
      name,
      {
        description,
        inputSchema: inputSchema as never,
        outputSchema: outputSchema as never,
        annotations,
      },
      (async (args: unknown) => {
        try {
          const result = await handler(args);
          const structuredContent = hasOwnSchema
            ? (result as Record<string, unknown>)
            : { result };
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result, null, 2) },
            ],
            structuredContent,
          };
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

  // Perp - markets and trading
  register(
    "sai_list_markets",
    "List Sai perpetual markets (100+, marketId, base/quote/collateral tokens, visibility, isOpen, and tradingSchedule name/timezone for scheduled markets). Covers crypto (low IDs: 0=BTC, 1=ETH, 16=SOL) and US stocks (IDs 1000+: 1000=QQQ, 1001=SPY, 1002=NVDA, ...). For full per-market details (price, OI, funding, fees, full schedule) call sai_get_market with the marketId.",
    listMarketsSchema,
    listMarkets,
    { title: "List Sai markets" },
  );

  register(
    "sai_get_market",
    "Get a single perpetual market's full info: price, 24h change, volume, open interest, funding rates, leverage caps, fees, price impact parameters, isOpen, and (for US-stock/commodity markets) the tradingSchedule with hours, timezone, and holidays.",
    getMarketSchema,
    getMarket,
    { title: "Get market details" },
  );

  register(
    "sai_get_trader_trades",
    "List a trader's open and closed perpetual positions with live PnL, leverage, liquidation price, tp/sl, and accumulated fees. NOTE: this reads the keeper's indexed state, which is delayed behind the chain by a few seconds to ~1-2 minutes. It is NOT read-your-writes: immediately after a sai_open_trade / sai_update_tpsl / sai_update_leverage / sai_close_trade broadcast, this may still show the pre-update values (stale leverage, tp/sl, or open/closed state). To confirm a write took effect, trust the broadcast's tx receipt (status: success) and/or the matching sai_get_trader_history event; only treat this query as authoritative once the indexer has caught up.",
    getTraderTradesSchema,
    getTraderTrades,
    { title: "Get trader positions" },
  );

  register(
    "sai_get_trader_history",
    "List a trader's position events (position_opened, position_closed, liquidation, tpsl_updated, leverage updates, SL/TP triggered) with realized PnL, tx hashes (cosmos + evm), and block timestamps. This is the per-event audit log and the best way to confirm a write landed (match on the broadcast's evmTxHash). Like sai_get_trader_trades it reads indexed state, so a just-broadcast event may take a few seconds to ~1-2 minutes to appear.",
    getTraderHistorySchema,
    getTraderHistory,
    { title: "Get trader history" },
  );

  register(
    "sai_get_user_portfolio",
    "Get a trader's portfolio stats: realized PnL, pending PnL, volume, and trade counts for a given time range ('1d', '7d', '30d', 'all').",
    getUserPortfolioSchema,
    getUserPortfolio,
    { title: "Get trader portfolio" },
  );

  register(
    "sai_get_fee_tier_progress",
    "Get a trader's fee tier progress: current tier, fee multiplier, trailing points, distance to next tier, and tier drop risk.",
    getFeeTierProgressSchema,
    getFeeTierProgress,
    { title: "Get fee-tier progress" },
  );

  // LP / vaults
  register(
    "sai_list_vaults",
    "List all Sai LP vaults (USDC, stNIBI) with TVL, share price, APY, fee APY, current epoch, and full revenue breakdown.",
    listVaultsSchema,
    listVaults,
    { title: "List LP vaults" },
  );

  register(
    "sai_get_vault_stats",
    "Get time-series stats for a single vault over a range ('1d', '7d', '30d', 'all').",
    getVaultStatsSchema,
    getVaultStats,
    { title: "Get vault stats" },
  );

  register(
    "sai_get_deposit_history",
    "List vault deposit/withdrawal events with amounts, shares, action type, and tx hashes. Filter by depositor or vault.",
    getDepositHistorySchema,
    getDepositHistory,
    { title: "Get vault deposit history" },
  );

  register(
    "sai_get_withdraw_requests",
    "List pending vault withdrawal requests with unlock epoch and auto-redeem flag. Filter by depositor or vault.",
    getWithdrawRequestsSchema,
    getWithdrawRequests,
    { title: "Get withdrawal requests" },
  );

  // Oracle
  register(
    "sai_get_token_prices",
    "Get current USD oracle prices for tokens tracked by Sai. Omit tokenId to get all prices.",
    getTokenPricesSchema,
    getTokenPrices,
    { title: "Get oracle prices" },
  );

  register(
    "sai_list_tokens",
    "List all tokens known to the Sai oracle (id, symbol, name, description, type).",
    listTokensSchema,
    listTokens,
    { title: "List oracle tokens" },
  );

  // Referrals
  register(
    "sai_get_referrals",
    "Get a referrer's program data: their referral codes (with unique traders, earnings, volume), recent attributed trades, claim events, and an earnings/volume time series over a range.",
    getReferralsSchema,
    getReferrals,
    { title: "Get referral program data" },
  );

  register(
    "sai_get_referral_for_trader",
    "Look up which referral code (and referrer) a given trader redeemed, if any. Returns an empty list when the trader has not redeemed a code.",
    getReferralForTraderSchema,
    getReferralForTrader,
    { title: "Get trader's referral" },
  );

  // Leaderboards
  register(
    "sai_get_leaderboard",
    "Get a Sai leaderboard: 'pnl' (realized PnL, ROI, capital used + rewards), 'volume' and 'volumeMarathon' (volume races), or 'cookout' (event leaderboard). Each row includes trader address and reward.",
    getLeaderboardSchema,
    getLeaderboard,
    { title: "Get leaderboard" },
  );

  // Protocol-wide stats and yield (keeper REST / dexpal API)
  register(
    "sai_get_protocol_stats",
    "Get exchange-wide aggregate stats (USD): trading volume (24h/7d/30d/all-time), trade counts, open interest, unique users, open positions, TVL, and accrued trading fees. Answers protocol-level questions like total fees collected this week. Served by the keeper REST API, not GraphQL.",
    getProtocolStatsSchema,
    getProtocolStats,
    { title: "Get protocol stats" },
  );

  register(
    "sai_get_yield_opportunities",
    "List Sai yield/earning opportunities (LP vaults) with accepted deposits, APY/APR, and TVL. Served by the keeper REST API.",
    getYieldOpportunitiesSchema,
    getYieldOpportunities,
    { title: "List yield opportunities" },
  );

  // Candles (OHLCV)
  register(
    "sai_get_candles",
    "Get OHLCV candles for a market by base symbol (e.g. BTC, ETH, NVDA) at a resolution (1/5/15/60/240/360/720 minutes, or 1D/1W/1M). Provide an explicit from/to Unix-second range, or a countback for the most recent N bars. Served by the keeper candles (TradingView UDF) API.",
    getCandlesSchema,
    getCandles,
    { title: "Get OHLCV candles" },
  );

  // Escape hatch
  register(
    "sai_graphql_query",
    "Run an arbitrary GraphQL query against the sai-keeper endpoint. Escape hatch for queries not covered by the typed tools - leaderboards, referrals, portfolio drill-downs, etc. Schema explorer: https://sai-keeper.nibiru.fi/",
    rawQuerySchema,
    rawQuery,
    { title: "Run GraphQL query" },
  );

  // Write tools - require SAI_MNEMONIC or SAI_PRIVATE_KEY env var on the MCP server.
  register(
    "sai_get_wallet_info",
    "Return the configured signer's EVM and bech32 addresses, NIBI and USDC balances, current nonce, and chain config. Requires SAI_MNEMONIC or SAI_PRIVATE_KEY in the MCP server environment. Call this first to confirm which wallet is loaded before any write operation.",
    getWalletInfoSchema,
    getWalletInfo,
    { title: "Get signer wallet info", outputSchema: walletInfoOutputSchema },
  );

  register(
    "sai_open_trade",
    "Open a long or short perpetual position on Sai using USDC collateral. Defaults to a DRY RUN that simulates and gas-estimates the trade without broadcasting - set confirm=true to actually send the transaction. The signer is loaded from SAI_MNEMONIC or SAI_PRIVATE_KEY on the MCP server. Always preview with confirm=false (or omit it) and show the summary to the user before re-running with confirm=true.",
    openTradeSchema,
    openTrade,
    { title: "Open perp position", destructive: true, outputSchema: openTradeOutputSchema },
  );

  register(
    "sai_close_trade",
    "Close an open Sai perpetual position, or cancel a pending limit/stop order (same on-chain call - the contract distinguishes by the trade's state). Identify the trade by its per-user index (the `id` from sai_get_trader_trades). Defaults to a DRY RUN that simulates and gas-estimates without broadcasting - set confirm=true to actually send. The signer is loaded from SAI_MNEMONIC or SAI_PRIVATE_KEY; only the signer's own trades can be managed. Caveat: closing a position within ~1-2 minutes of opening it can revert on-chain even when the dry-run gas estimate succeeds (the contract enforces a brief minimum hold); if a confirmed close reverts, wait ~1-2 minutes and retry. The dry-run flags a freshly-opened position under `warning`.",
    closeTradeSchema,
    closeTrade,
    { title: "Close position / cancel order", destructive: true, outputSchema: manageTradeOutputSchema },
  );

  register(
    "sai_update_tpsl",
    "Set or clear the take-profit and/or stop-loss on an open Sai position. Omit a field to leave it unchanged, pass a price to set it, or pass null to clear it. Validates that newly-set targets are on the correct side of the live price. Identify the trade by its `id` from sai_get_trader_trades. Defaults to a DRY RUN - set confirm=true to broadcast. Signer from SAI_MNEMONIC or SAI_PRIVATE_KEY.",
    updateTpSlSchema,
    updateTpSl,
    { title: "Update take-profit / stop-loss", destructive: true, outputSchema: manageTradeOutputSchema },
  );

  register(
    "sai_update_leverage",
    "Change the leverage on an open Sai position (USDC collateral only). Notional is held constant: raising leverage frees collateral back to the wallet, lowering it pulls additional USDC from the wallet. newLeverage must be a whole number within the market's min/max. Identify the trade by its `id` from sai_get_trader_trades. Defaults to a DRY RUN - set confirm=true to broadcast. Signer from SAI_MNEMONIC or SAI_PRIVATE_KEY.",
    updateLeverageSchema,
    updateLeverage,
    { title: "Update position leverage", destructive: true, outputSchema: manageTradeOutputSchema },
  );

  // MCP Resources - read-only context surfaces (guide, live markets/tokens, schema).
  registerResources(server);

  // MCP Prompts - reusable analysis templates (analyze_trader, market_overview, ...).
  registerPrompts(server);

  return server;
}
