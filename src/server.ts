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
import { send, sendSchema } from "./tools/send.js";
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
  sendOutputSchema,
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
- Addresses: trader/depositor/referrer filters accept either a Nibiru bech32 address (nibi1...) or an EVM hex address (0x...) - the tools convert 0x to bech32 automatically. Vault filters also accept a vault's EVM share-token address (sharesERC20, 0x...), resolved against the live vault list. Returned addresses are bech32. The signer also has a 0x EVM address.
- Timestamps: block_ts is RFC3339.
- Funding-rate APR: feesPerHourLong * 24 * 365 * 100.
- Market IDs (mainnet): crypto uses low IDs (0=BTC, 1=ETH, 16=SOL); US-stock markets use IDs 1000+ (1000=QQQ, 1001=SPY, 1002=NVDA). Collateral IDs: 1=USDC, 2=stNIBI. Each (market, collateral) pair is a distinct market - sai_list_markets enumerates them all.
- Trading schedules: crypto trades 24/7 (tradingSchedule is null). US-stock/commodity markets carry a tradingSchedule and isOpen reflects whether they are currently tradeable; sai_open_trade rejects a closed market.

Reads are eventually-consistent:
- Read tools query a live indexer delayed behind the chain by a few seconds to ~1-2 minutes, and are NOT read-your-writes. Immediately after a write, sai_get_trader_trades may still show stale (pre-write) state. Confirm a write landed via the broadcast tx receipt (status: success) and/or the matching sai_get_trader_history event (match on evmTxHash), not sai_get_trader_trades.

Write tools (sai_open_trade, sai_close_trade, sai_update_tpsl, sai_update_leverage, sai_send):
- Require a signer (inert otherwise). Default: ASK the user whether to create a NEW wallet, then run \`sai-mcp keygen --save\` (safe in-session; writes a 0600 keystore the server auto-loads, no restart, prints no secret). A user with an EXISTING wallet adds it by editing the keystore JSON themselves (see "Onboarding a signer"). Hosted/Docker setups can instead set SAI_MNEMONIC or SAI_PRIVATE_KEY in the server environment.
- DEFAULT TO DRY-RUN (confirm=false): they simulate + gas-estimate and return a summary WITHOUT signing or broadcasting. Always preview with confirm=false, show the summary to the user, then re-run with confirm=true to broadcast.
- No minimum position size: there is NO enforced minimum notional. The market's minPositionSizeUSD (reported by the indexer, surfaced in sai_open_trade's summary) is ADVISORY ONLY and NOT enforced on-chain — it is the same flat value for every market and the chain accepts positions far below it (sub-$1, ~$0.02 notional observed). minLeverage is 1 on the major markets, so a small position should be opened at LOW leverage, not by inflating leverage to reach minPositionSizeUSD. NEVER raise the user's requested leverage to "meet a minimum"; open exactly what the user asked. The authoritative size check is the dry-run gas estimate (a genuinely too-small position sets gas.estimationError); the dry-run flags this via trade.minPositionSizeNote.
- Acting on a position within ~1-2 minutes of opening it has been observed to revert on-chain even when the dry-run gas estimate succeeds (a transient oracle/settlement-timing condition right after open, NOT a contract-enforced minimum hold). eth_estimateGas does not catch it; if a confirmed close/update reverts, wait ~1-2 minutes and retry. The close/update dry-runs flag this under "warning".
- Gas: Sai perp trades are GASLESS. sai_open_trade / sai_close_trade / sai_update_tpsl / sai_update_leverage target the PerpVaultEvmInterface contract, whose gas the chain sponsors, so the wallet needs ZERO NIBI to open, close, or manage a position. When funding a wallet to trade, ask ONLY for USDC; never tell the user they need NIBI "for gas" to trade, and never gate a trade on the NIBI balance. NIBI is needed ONLY for non-Sai transactions: sai_send (withdrawing funds back out, or any plain transfer) is an ordinary EVM transfer and is NOT gas-sponsored, so even though eth_gasPrice reports 0 the chain enforces a minimum gas price and deducts a small amount of native NIBI from the sender. A wallet with 0 NIBI can still trade but cannot sai_send; sai_send's dry-run reports a "funded" flag (false when the wallet lacks NIBI for gas).

Withdrawing funds / offboarding (what to say when a user asks "how do I get my money out?"):
- Use sai_send to withdraw. It sends native NIBI or any ERC20 (token: "nibi" | "usdc" | a 0x token address such as stNIBI). Close any open positions first (sai_close_trade) so the collateral returns to the wallet, then sai_send the USDC (and any stNIBI) out to the user's own address. To fully empty a wallet, sweep each ERC20 with all=true, then sweep NIBI last (the NIBI sweep keeps back only its own gas). Always preview with confirm=false and show the user the destination + amount before confirm=true.

Exporting the private key / seed phrase (what to say when a user asks "how do I get my key out?"):
- There is intentionally NO MCP tool that returns the seed phrase or private key, and you must NEVER print, echo, or reconstruct it in the conversation — a secret in chat is a key compromise. Do not offer to read it from the keystore and show it.
- Tell the user they can export it themselves, outside this channel: the wallet is stored at the keystore path (default ~/.sai-mcp/wallet.json, override SAI_KEYSTORE), a 0600 JSON file containing their "mnemonic" or "privateKey". They open that file in their own terminal. If they configured the signer via the SAI_MNEMONIC / SAI_PRIVATE_KEY env var instead, the secret is already in their own MCP config. Either way the user retrieves it directly; the assistant never relays it.

Onboarding a signer (no wallet configured yet):
- Default path: ASK the user whether you should create a NEW wallet for them. On yes, run \`sai-mcp keygen --save\` yourself (you have shell access) or have them run it. It mints a fresh wallet, writes a 0600 keystore the server auto-loads (no restart, no config edit), and intentionally prints NO secret, so it is safe to run in this session. The server reads the keystore live on each call, so it takes effect immediately.
- If the user instead wants to use an EXISTING wallet, they add it by editing the keystore file THEMSELVES, in their own terminal or editor, outside this chat. Give them these steps: create the JSON file at the keystore path (default ~/.sai-mcp/wallet.json, override SAI_KEYSTORE) containing either {"mnemonic": "<their 12/24 words>"} (optionally add "derivationPath", default m/44'/60'/0'/0/0) or {"privateKey": "0x..."} (exactly one of the two, never both), then \`chmod 600\` it. The server picks it up live on the next call, no restart. There is NO import command. NEVER ask the user to type, paste, or pipe a seed phrase or private key into this conversation, never print one, and do NOT offer to write the keystore for them from a secret they share; a secret in chat is a key compromise.
- A freshly created wallet is EMPTY. Do NOT proceed to a trade after setup. Call sai_get_wallet_info, show the user the EVM funding address, and tell them to send USDC (collateral) to it. Trading on Sai is gasless, so the wallet needs ONLY USDC and ZERO NIBI to trade: do NOT tell the user to fund NIBI "for gas" to open the position, and do NOT imply the trade needs gas. (A little NIBI matters only later, if they withdraw funds back out via sai_send; see offboarding.) Then STOP and wait for the user to confirm the USDC landed.
- Only after sai_get_wallet_info shows a non-zero USDC balance should you run the trade (starting, as always, with a confirm=false dry-run). The NIBI balance is irrelevant to opening a trade; never wait on it or ask the user to top it up to trade. Transfers take time; let the user drive the pace rather than retrying the trade against an unfunded wallet.

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

  // Write tools - require a configured signer (keystore via keygen, or SAI_MNEMONIC / SAI_PRIVATE_KEY env var).
  register(
    "sai_get_wallet_info",
    "Return the configured signer's EVM and bech32 addresses, NIBI and USDC balances, current nonce, and chain config. Requires a configured signer (keystore or env). Call this first to confirm which wallet is loaded before any write operation.",
    getWalletInfoSchema,
    getWalletInfo,
    { title: "Get signer wallet info", outputSchema: walletInfoOutputSchema },
  );

  register(
    "sai_send",
    "Send native NIBI or any ERC20 token from the signer wallet to another address — used to withdraw collateral or empty a wallet when you're done with it. token accepts \"nibi\" (native), \"usdc\" (collateral shorthand), or any ERC20 contract address (0x...) such as stNIBI or another deposited token; decimals are read from the contract. The recipient accepts either an EVM 0x... address or a Nibiru nibi1... bech32 address. Set amount for a specific quantity, or all=true to sweep the entire balance (for NIBI a small gas reserve is kept back). Unlike trades, plain transfers are NOT routed through the gas-sponsored perp contract: they use the network gas price (currently 0 on Nibiru mainnet, so typically no NIBI is needed; if it ever becomes nonzero the wallet needs a little NIBI). Defaults to a DRY RUN that resolves the recipient, reads token metadata and balances, and estimates gas without broadcasting — set confirm=true to actually transfer. Requires a configured signer.",
    sendSchema,
    send,
    { title: "Send NIBI / ERC20", destructive: true, outputSchema: sendOutputSchema },
  );

  register(
    "sai_open_trade",
    "Open a long or short perpetual position on Sai using USDC collateral. Defaults to a DRY RUN that simulates and gas-estimates the trade without broadcasting - set confirm=true to actually send the transaction. The signer is the wallet configured on the MCP server (keystore or env). Always preview with confirm=false (or omit it) and show the summary to the user before re-running with confirm=true.",
    openTradeSchema,
    openTrade,
    { title: "Open perp position", destructive: true, outputSchema: openTradeOutputSchema },
  );

  register(
    "sai_close_trade",
    "Close an open Sai perpetual position, or cancel a pending limit/stop order (same on-chain call - the contract distinguishes by the trade's state). Identify the trade by its per-user index (the `id` from sai_get_trader_trades). Defaults to a DRY RUN that simulates and gas-estimates without broadcasting - set confirm=true to actually send. The signer is the wallet configured on the MCP server; only the signer's own trades can be managed. Caveat: closing a position within ~1-2 minutes of opening it has been observed to revert on-chain even when the dry-run gas estimate succeeds (a transient oracle/settlement-timing condition right after open, not a contract-enforced minimum hold); if a confirmed close reverts, wait ~1-2 minutes and retry. The dry-run flags a freshly-opened position under `warning`.",
    closeTradeSchema,
    closeTrade,
    { title: "Close position / cancel order", destructive: true, outputSchema: manageTradeOutputSchema },
  );

  register(
    "sai_update_tpsl",
    "Set or clear the take-profit and/or stop-loss on an open Sai position. Omit a field to leave it unchanged, pass a price to set it, or pass null to clear it. Validates that newly-set targets are on the correct side of the live price. Identify the trade by its `id` from sai_get_trader_trades. Defaults to a DRY RUN - set confirm=true to broadcast. Requires a configured signer.",
    updateTpSlSchema,
    updateTpSl,
    { title: "Update take-profit / stop-loss", destructive: true, outputSchema: manageTradeOutputSchema },
  );

  register(
    "sai_update_leverage",
    "Change the leverage on an open Sai position (USDC collateral only). Notional is held constant: raising leverage frees collateral back to the wallet, lowering it pulls additional USDC from the wallet. newLeverage must be a whole number within the market's min/max. Identify the trade by its `id` from sai_get_trader_trades. Defaults to a DRY RUN - set confirm=true to broadcast. Requires a configured signer.",
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
