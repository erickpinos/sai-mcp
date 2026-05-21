# sai-mcp

An [MCP](https://modelcontextprotocol.io) server for **[Sai.fun](https://sai.fun)** — the decentralized perpetual futures protocol on [Nibiru Chain](https://nibiru.fi). Exposes the `sai-keeper` GraphQL indexer as MCP tools so any MCP-compatible client (Claude Desktop, Cursor, Claude Code, etc.) can query live Sai data without writing GraphQL.

## What you can ask

- "What perp markets does Sai have right now and what's their funding rate?"
- "Show me open positions for trader `nibi1abc...` with current PnL"
- "What's the TVL and APY of the USDC vault?"
- "How much fees has the Sai protocol collected this week?"
- "Did `nibi1xyz...` get liquidated in the last 24 hours?"

## Install

### Option A: Run via `npx` (no install)

Once published:

```bash
npx sai-mcp
```

### Option B: Clone and build locally

```bash
git clone https://github.com/<you>/sai-mcp.git
cd sai-mcp
npm install
npm run build
```

This produces `dist/index.js`, which is the executable MCP server entrypoint.

## Add to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "sai": {
      "command": "node",
      "args": ["/absolute/path/to/sai-mcp/dist/index.js"]
    }
  }
}
```

Or with `npx`:

```json
{
  "mcpServers": {
    "sai": {
      "command": "npx",
      "args": ["-y", "sai-mcp"]
    }
  }
}
```

Restart Claude Desktop. The `sai` tools will appear in the tools menu.

## Add to Claude Code

```bash
claude mcp add sai -- node /absolute/path/to/sai-mcp/dist/index.js
```

## Add to Cursor

In `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "sai": {
      "command": "node",
      "args": ["/absolute/path/to/sai-mcp/dist/index.js"]
    }
  }
}
```

## Tools

All tools accept an optional `network` argument (`"mainnet"` | `"testnet"`, default `mainnet`).

### Markets & trading

| Tool | Purpose |
|------|---------|
| `sai_list_markets` | All perp markets (marketId, base/quote/collateral tokens, visibility) |
| `sai_get_market` | Full info for one market by `marketId` + `collateralId` (price, OI, funding, fees, price impact) |
| `sai_get_trader_trades` | A trader's open/closed positions with real-time PnL, liq price, fees |
| `sai_get_trader_history` | A trader's position events (open, close, liquidate, SL/TP) with tx hashes |
| `sai_get_user_portfolio` | A trader's portfolio stats (realized PnL, volume, trade count) over a range |
| `sai_get_fee_tier_progress` | A trader's fee tier, multiplier, and progress to next tier |

### Liquidity vaults

| Tool | Purpose |
|------|---------|
| `sai_list_vaults` | All LP vaults with TVL, share price, APY, epoch, revenue breakdown |
| `sai_get_vault_stats` | Time-series stats for a single vault |
| `sai_get_deposit_history` | Vault deposit/withdrawal events (filter by depositor or vault) |
| `sai_get_withdraw_requests` | Pending withdrawal requests with unlock epoch |

### Oracle

| Tool | Purpose |
|------|---------|
| `sai_get_token_prices` | Current USD oracle prices |
| `sai_list_tokens` | All tokens known to the Sai oracle |

### Escape hatch

| Tool | Purpose |
|------|---------|
| `sai_graphql_query` | Run an arbitrary GraphQL query — for referrals, leaderboards, or any field not covered above |

Use the escape hatch when the typed tools don't cover what you need. See the live schema at <https://sai-keeper.nibiru.fi/>.

## Units & conventions

- **Micro-units**: amounts (`tvl`, `collateralAmount`, `oiLong`, etc.) are integers in micro-units. Divide by `10^decimals` — USDC and stNIBI both use **6 decimals**, so divide by 1,000,000.
- **Addresses**: trader and depositor addresses are Nibiru bech32 (`nibi1...`).
- **Timestamps**: `block_ts` is RFC3339; `epochStart` is in the chain's native time encoding.
- **Funding rate APR**: `feesPerHourLong * 24 * 365 * 100`.
- **Market IDs** (mainnet): 0 = BTC, 1 = ETH, 16 = SOL, plus others. Collateral IDs: 1 = USDC, 2 = stNIBI. Each (market, collateral) pair is a distinct market — `sai_list_markets` enumerates them all.

## Configuration

Override the GraphQL endpoint with an env var (handy for self-hosted indexers):

```bash
SAI_KEEPER_ENDPOINT="https://your-indexer.example.com/graphql" npx sai-mcp
```

Default endpoints:

- Mainnet: `https://sai-keeper.nibiru.fi/query`
- Testnet: `https://sai-keeper.testnet-2.nibiru.fi/query`

## Develop

```bash
npm install
npm run dev          # tsc --watch
npm run inspect      # open MCP Inspector against the server
```

## License

MIT
