import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// MCP Prompts for sai-mcp.
//
// Prompts are reusable, parameterized request templates a user picks in the
// client (they surface like slash commands). They do NOT call tools
// themselves: each returns a single user message that instructs the model
// which sai_* tools to call and what analysis to produce. The model then runs
// the tools and answers. Keeping the orchestration in the message (not in
// code) lets the model adapt and keeps these in sync with the tools.

// Matches how the tools declare network: optional, defaults to mainnet.
const networkArg = z
  .enum(["mainnet", "testnet"])
  .default("mainnet")
  .describe("Network to analyze. Defaults to mainnet.");

type PromptResult = {
  messages: Array<{
    role: "user" | "assistant";
    content: { type: "text"; text: string };
  }>;
};

// The SDK's generic registerPrompt infers the callback arg types from
// argsSchema; with a zod `.default()` in the shape that inference exceeds the
// TS instantiation-depth limit (TS2589). The tool path sidesteps the same class
// of issue by casting its schema. Here we bind registerPrompt through a
// concrete local signature instead: the real zod shape is still passed at
// runtime (so each prompt's advertised arguments are correct), we just stop TS
// from instantiating the deep generic. Prompt args always arrive as strings.
type RegisterPromptFn = (
  name: string,
  config: {
    title?: string;
    description?: string;
    argsSchema?: Record<string, z.ZodTypeAny>;
  },
  cb: (args: Record<string, string>) => PromptResult,
) => void;

export function registerPrompts(server: McpServer) {
  const reg = server.registerPrompt.bind(server) as unknown as RegisterPromptFn;

  reg(
    "analyze_trader",
    {
      title: "Analyze a Sai trader",
      description:
        "Pull a trader's open/closed positions, event history, portfolio stats, and fee tier, then summarize their exposure, PnL, and risk.",
      argsSchema: {
        trader: z
          .string()
          .min(1)
          .describe(
            "Trader address: a Nibiru bech32 address (nibi1...) or an EVM hex address (0x...).",
          ),
        network: networkArg,
      },
    },
    ({ trader, network }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Analyze the Sai.fun perpetual-futures trader \`${trader}\` on ${network}.

Use these tools, all with network="${network}":
1. sai_get_trader_trades (trader="${trader}") for current open positions and recent closed ones: direction, leverage, entry/mark price, liquidation price, live PnL, TP/SL, fees.
2. sai_get_trader_history (trader="${trader}") for the position event log: opens, closes, liquidations, TP/SL changes, with realized PnL and tx hashes.
3. sai_get_user_portfolio (trader="${trader}", range="all") and again with range="30d" for realized/pending PnL, volume, and trade counts.
4. sai_get_fee_tier_progress (trader="${trader}") for the current fee tier, multiplier, and tier-drop risk.

Then produce a concise report:
- Open exposure: net long/short, total notional, leverage, and how close any position sits to its liquidation price.
- Performance: realized PnL (all-time and 30d), the win/loss pattern from history, biggest wins and losses.
- Activity and fees: volume, trade count, fee tier, and whether they are at risk of dropping a tier.
- Risk flags: over-leverage, positions near liquidation, recent liquidations.

Remember amounts are in micro-units (divide USDC/stNIBI fields by 1,000,000), and the indexer can lag the chain by up to ~1-2 minutes.`,
          },
        },
      ],
    }),
  );

  reg(
    "market_overview",
    {
      title: "Sai market overview",
      description:
        "Summarize the Sai perpetual markets: which are open, top markets by volume and open interest, notable funding rates, and biggest movers.",
      argsSchema: {
        network: networkArg,
      },
    },
    ({ network }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Give an overview of Sai.fun perpetual markets on ${network}.

1. Call sai_list_markets (network="${network}") to enumerate markets. Crypto markets use low IDs (0=BTC, 1=ETH, 16=SOL); US-stock markets use IDs 1000+ (1000=QQQ, 1001=SPY, 1002=NVDA). Note which are open (isOpen) and any tradingSchedule.
2. For a handful of notable markets (e.g. BTC, ETH, SOL, plus any that look unusually active), call sai_get_market (with the marketId and collateralId=1 for USDC) to get price, 24h change, volume, open interest (oiLong/oiShort), and funding rates.

Then summarize:
- Which markets are open vs closed right now (and, for closed stock markets, when they reopen).
- Top markets by volume and open interest.
- Notable funding rates (annualize with feesPerHourLong*24*365*100) and any heavily one-sided open interest.
- Biggest 24h movers.

Amounts are micro-units (divide USDC-denominated fields by 1,000,000).`,
          },
        },
      ],
    }),
  );

  reg(
    "vault_yield_report",
    {
      title: "Sai vault yield report",
      description:
        "Summarize Sai LP vault yields: TVL, share price, APY (and how much is fee-driven), and the best current yield opportunities.",
      argsSchema: {
        network: networkArg,
      },
    },
    ({ network }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Report on Sai.fun LP vault yields on ${network}.

1. Call sai_list_vaults (network="${network}") for each vault's TVL, share price, APY, fee APY, current epoch, and revenue breakdown.
2. Call sai_get_yield_opportunities (network="${network}") for the accepted-deposit yield opportunities (APY/APR, TVL).

Then summarize:
- Each vault: TVL, current share price, APY, and how much of that APY is fee-driven vs other revenue.
- The best risk-adjusted yield right now, and the epoch timing that governs deposits and withdrawals.
- Any notable TVL or APY changes worth flagging.

TVL and amounts are micro-units (divide by 1,000,000; both USDC and stNIBI use 6 decimals).`,
          },
        },
      ],
    }),
  );

  reg(
    "protocol_health",
    {
      title: "Sai protocol health",
      description:
        "Summarize exchange-wide Sai health: volume trend, open interest, TVL, unique users, open positions, and accrued fees.",
      argsSchema: {
        network: networkArg,
      },
    },
    ({ network }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Summarize the overall health of the Sai.fun protocol on ${network}.

1. Call sai_get_protocol_stats (network="${network}") for exchange-wide volume (24h / 7d / 30d / all-time), trade counts, open interest, unique users, open positions, TVL, and accrued trading fees.
2. Optionally call sai_list_vaults (network="${network}") for vault TVL context.

Then produce a short health report:
- Activity: 24h volume and trade count vs the 7d / 30d trend.
- Liquidity: open interest, TVL, and open positions.
- Growth: unique users.
- Revenue: accrued trading fees across the periods.

Call out anything unusual (a sharp volume drop, an open-interest spike, fee anomalies). These are USD aggregates served by the keeper REST API.`,
          },
        },
      ],
    }),
  );
}
