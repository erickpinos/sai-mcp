# sai-mcp

An [MCP](https://modelcontextprotocol.io) server for the **[Sai.fun](https://sai.fun)** decentralized perpetual futures protocol on [Nibiru Chain](https://nibiru.fi). Exposes the `sai-keeper` GraphQL indexer as MCP tools so any MCP-compatible client (Claude Desktop, Cursor, Claude Code, etc.) can query live Sai data without writing GraphQL.

## What you can ask

- "What perp markets does Sai have right now and what's their funding rate?"
- "Is the SPY market open, and what are its trading hours?"
- "Show me open positions for trader `0x1238…4323` with current PnL"
- "What's the TVL and APY of the USDC vault?"
- "How much fees has the Sai protocol collected this week?"
- "Who's on top of the PnL leaderboard?"
- "Plot BTC's last 24 hours of hourly candles"
- "Did `0x1238…4323` get liquidated in the last 24 hours?"

Trader, depositor, and referrer addresses accept either an EVM hex address (`0x...`) or a Nibiru bech32 address (`nibi1...`) interchangeably. The server converts `0x` to bech32 for you.

## Install

### Option A: Run via `npx` (no install)

```bash
npx sai-mcp
```

### Option B: Clone and build locally

```bash
git clone https://github.com/erickpinos/sai-mcp.git
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

## Adding a signing wallet (for trading)

The 20 read tools work with no wallet. To use the write tools (`sai_open_trade`, `sai_close_trade`, `sai_update_tpsl`, `sai_update_leverage`, `sai_send`) and `sai_get_wallet_info`, the server needs a signer.

**The recommended way is a local keystore.** It's the simplest path: you run one command, never paste a seed phrase into a config file, and the secret stays out of the process environment and off the MCP/LLM channel. The server auto-loads it on startup.

### New wallet

```bash
npx sai-mcp keygen --save
```

Generates a fresh random wallet, writes it to a local keystore at `~/.sai-mcp/wallet.json` (mode `0600`, override the path with `SAI_KEYSTORE`), and prints **only** the public EVM + Nibiru addresses. The seed and private key are deliberately **not** printed. The server reads the keystore automatically whenever no env signer is set, so there's nothing to paste into your config (and it's picked up live, no restart).

Because `--save` keeps the secret out of its output, it's also the form to use when an **AI agent** sets up trading for you: the seed never reaches the model or transcript.

### Existing wallet

Already have a wallet? There's deliberately no import command (a CLI import would route your seed through your shell history or an AI session). Instead, write the keystore file yourself, in your own terminal, so the secret never leaves your machine:

```bash
mkdir -p ~/.sai-mcp
# Put your seed phrase OR private key (exactly one) in the file:
cat > ~/.sai-mcp/wallet.json <<'JSON'
{ "mnemonic": "word1 word2 word3 ... word12" }
JSON
chmod 600 ~/.sai-mcp/wallet.json
```

Use `{ "privateKey": "0x..." }` instead if that's what you have. For a mnemonic you may optionally add `"derivationPath"` (defaults to `m/44'/60'/0'/0/0`). Keep exactly one of `mnemonic` / `privateKey` — the server errors if both are present. It reads the keystore live on the next call, so no restart is needed; confirm the loaded wallet with `sai_get_wallet_info`. Override the location with `SAI_KEYSTORE`.

Type or paste the secret only into your own editor/terminal — never into a chat with an AI assistant.

### Fund, then trade

A freshly generated wallet is **empty**. Fund its EVM address with USDC for collateral, then call `sai_get_wallet_info` to confirm the balance landed and that it's the right wallet. Only then place a trade.

Trading on Sai is **gasless**: the chain sponsors gas for trades through the Sai contract (see [Write tools](#write-tools-opt-in-require-a-signer)), so you don't need NIBI to open, close, or manage positions. You only need NIBI later if you want to **withdraw** funds out of this wallet (a plain transfer pays normal gas), or you can export the keystore's keys into a wallet that handles gas for you.

> **Security:** the keystore is plaintext at rest (same exposure as a secret in a config `env` block), just with enforced `0600` permissions and kept out of your config file and process environment. Treat it like any other key material; to back it up, open `~/.sai-mcp/wallet.json` yourself in a private terminal and copy the phrase somewhere safe. Writes default to a dry run (`confirm=false`); you must explicitly pass `confirm=true` to broadcast a transaction.

### Advanced: env-var signer (hosted / Docker / CI)

For hosted, containerized, or CI deployments where a local keystore file is inconvenient, supply the signer via **one** of these environment variables instead. A set env var always wins over the keystore.

| Variable | Value |
|----------|-------|
| `SAI_MNEMONIC` | Your 12/24-word seed phrase |
| `SAI_PRIVATE_KEY` | A raw hex private key (`0x…`) |

**Claude Desktop / Cursor** — add an `env` key alongside `command`/`args`:

```json
{
  "mcpServers": {
    "sai": {
      "command": "npx",
      "args": ["-y", "sai-mcp"],
      "env": {
        "SAI_MNEMONIC": "word1 word2 word3 ... word12"
      }
    }
  }
}
```

**Claude Code** — pass it with `-e`:

```bash
claude mcp add sai -e SAI_MNEMONIC="word1 word2 ... word12" -- npx -y sai-mcp
```

To mint a wallet for this path without writing a keystore, run plain `npx sai-mcp keygen` (no flag): it prints a fresh mnemonic + private key for you to copy into the `env` block. The secret is on stdout, so run that one yourself in a terminal, never via an assistant. The wallet is derived on the same path the server uses (`m/44'/60'/0'/0/0`, overridable via `SAI_DERIVATION_PATH`), so the address shown is exactly the one the server will load.

## Tools

All tools accept an optional `network` argument (`"mainnet"` | `"testnet"`, default `mainnet`).

Every tool carries MCP **annotations**: the 20 read tools are marked `readOnlyHint`, the 5 on-chain write tools `destructiveHint`, and each tool gets a human `title`, so clients can tell them apart. Every tool also returns **structured output**: the read tools wrap their payload under a `result` field, while the write tools and `sai_get_wallet_info` advertise a typed `outputSchema`. The server also ships an `instructions` block (units, market IDs, the dry-run safety model) in its initialize response, so a connected model has the conventions without being told.

### Markets & trading

| Tool | Purpose |
|------|---------|
| `sai_list_markets` | All perp markets (100+: crypto + US stocks) — marketId, base/quote/collateral tokens, visibility, `isOpen`, and `tradingSchedule` name/timezone |
| `sai_get_market` | Full info for one market by `marketId` + `collateralId` (price, OI, funding, fees, price impact, `isOpen`, and full `tradingSchedule` for stock/commodity markets) |
| `sai_get_trader_trades` | A trader's open/closed positions with real-time PnL, liq price, fees |
| `sai_get_trader_history` | A trader's position events (open, close, liquidate, SL/TP) with realized PnL, opening/closing fees (USD), and tx hashes |
| `sai_get_user_portfolio` | A trader's portfolio stats (realized PnL, volume, trade count) over a range |
| `sai_get_fee_tier_progress` | A trader's fee tier, multiplier, and progress to next tier |
| `sai_get_leaderboard` | PnL / volume / volume-marathon / cookout leaderboards with rank, rewards, and trader stats |
| `sai_get_candles` | OHLCV candles for a market by base symbol at a chosen resolution (1m–1M) |

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

### Referrals

| Tool | Purpose |
|------|---------|
| `sai_get_referrals` | A referrer's codes, attributed trades, claims, and earnings/volume time series |
| `sai_get_referral_for_trader` | Which referral code (and referrer) a trader redeemed, if any |

### Protocol stats & yield

These hit the keeper's REST ("dexpal") API rather than GraphQL.

| Tool | Purpose |
|------|---------|
| `sai_get_protocol_stats` | Exchange-wide aggregates: volume (24h/7d/30d/all-time), trades, open interest, users, open positions, TVL, accrued fees |
| `sai_get_yield_opportunities` | LP vault yield opportunities (accepted deposits, APY/APR, TVL) |

### Escape hatch

| Tool | Purpose |
|------|---------|
| `sai_graphql_query` | Run an arbitrary GraphQL query — for any field not covered above |

Use the escape hatch when the typed tools don't cover what you need. See the live schema at <https://sai-keeper.nibiru.fi/>.

> **Known gap:** per-wallet balance/net-worth snapshots (`UserInfo`: `netWorthUSD`, per-token USD value, pending PnL) are exposed by the keeper only as a GraphQL **subscription**, with no query equivalent — so a request/response MCP can't surface them yet. Use `sai_get_user_portfolio` (PnL/volume) and `sai_get_wallet_info` (on-chain balances of the configured signer) in the meantime.

### Write tools (opt-in, require a signer)

These tools sign and broadcast on-chain transactions. They are inert unless you provide a wallet to the MCP server via a local keystore or env var (see [Signer setup](#signer-setup)).

| Tool | Purpose |
|------|---------|
| `sai_get_wallet_info` | Report the configured signer's EVM + bech32 addresses, NIBI/USDC balances, nonce, and chain config |
| `sai_send` | Withdraw native NIBI or **any ERC20** (USDC, stNIBI, or a `0x` token address) from the signer wallet to another address; `all: true` empties the balance. **Defaults to dry-run** |
| `sai_open_trade` | Open a long or short perp position with USDC collateral. **Defaults to dry-run** — pass `confirm: true` to broadcast |
| `sai_close_trade` | Close an open position, or cancel a pending limit/stop order (same on-chain call). **Defaults to dry-run** |
| `sai_update_tpsl` | Set, change, or clear take-profit / stop-loss on an open position. **Defaults to dry-run** |
| `sai_update_leverage` | Change a position's leverage (USDC collateral); notional held constant, collateral delta settled to/from the wallet. **Defaults to dry-run** |

The four trade tools identify a position by its per-user trade index — the `id` field returned by `sai_get_trader_trades`. You can only manage the configured signer's own trades.

**Withdrawing / emptying a wallet.** `sai_send` is how funds come back out. Close any open positions first (`sai_close_trade`) so collateral returns to the wallet, then `sai_send` each token to your own address — `token: "usdc"` (or `"nibi"`, or a `0x` token contract such as stNIBI), with `amount` for a partial withdrawal or `all: true` to sweep the balance. To fully drain a wallet, sweep each ERC20 first, then NIBI last (the NIBI sweep retains only its own gas). Unlike the trade tools, a plain transfer is **not** gas-sponsored — sponsorship is specific to the Sai perp contract. Even though `eth_gasPrice` reports `0`, the chain enforces a minimum gas price (~1e12 wei/gas, roughly 0.05 NIBI per transfer) and deducts it from the sender, so **the wallet must hold a little native NIBI to send anything, including to withdraw USDC.** A wallet with 0 NIBI cannot `sai_send`; fund a small amount of NIBI first. The dry-run floors to this minimum and reports `funded: false` when the wallet can't cover gas. **Exporting your key:** there is intentionally no tool that returns your seed phrase or private key, and the assistant will never print it. Retrieve it yourself from the keystore file (`~/.sai-mcp/wallet.json`, or `SAI_KEYSTORE`) or your own `SAI_MNEMONIC` / `SAI_PRIVATE_KEY` config — see [Security](#security).

**Safety model.** Every write tool defaults to `confirm: false`, which simulates the action (gas estimate + validation against market/position constraints) without signing or broadcasting. The returned summary includes the resolved position, the change being made, the wallet, and the encoded wasm message. Set `confirm: true` only after reviewing the dry-run output. `sai_close_trade`, `sai_update_tpsl`, and `sai_update_leverage` refuse to broadcast if gas estimation fails; `sai_open_trade` instead falls back to a fixed gas limit and broadcasts anyway (flagged via `broadcastWithFallbackGas`), because `eth_estimateGas` is unreliable for the funtoken-precompile open path. Operators can further constrain trades with env-based caps — see [Trade guard rails](#trade-guard-rails-operator-set-caps).

**Freshly-opened positions can revert on close/update.** Gas estimation does not catch one timing case: acting on a position within ~1–2 minutes of opening it has been observed to revert on-chain even when the dry-run gas estimate succeeds. This is a transient oracle/settlement-timing condition right after open, not a contract-enforced minimum hold — the perp contract's close handler (`NibiruChain/sai-perps`, `contracts/perp/src/trade.rs`) has no open-time check; its only rejections are `Paused`, `MarketClosed`, and `OraclePriceStale`. `eth_estimateGas` does not catch it. So a clean dry-run is not a guarantee an immediate close/update lands. The dry-run flags a freshly-opened position under a `warning` field; and if a confirmed `sai_close_trade` / `sai_update_tpsl` / `sai_update_leverage` reverts, the tool returns the tx hash, explorer link, and a "wait ~1–2 minutes and retry" hint instead of an opaque `CALL_EXCEPTION`. Confirm a trade's true state via `sai_get_trader_history` (look for the `position_closed` / `tpsl_updated` event) rather than the eventually-consistent `sai_get_trader_trades`.

The trade is executed via the `PerpVaultEvmInterface` contract on Nibiru's EVM. Gas is sponsored by the chain when targeting this contract, so the wallet does not need NIBI for gas — only USDC for collateral. No ERC20 approve is required; the contract pulls USDC directly via the Nibiru funtoken precompile.

## Resources

The server exposes read-only [MCP resources](https://modelcontextprotocol.io) a client can pull into context without spending a tool call. All are mainnet snapshots (use the tools for testnet):

| URI | Type | Contents |
|-----|------|----------|
| `sai://guide` | `text/markdown` | Protocol conventions and the write-tool safety model |
| `sai://markets` | `application/json` | Live list of visible mainnet markets (same payload as `sai_list_markets`) |
| `sai://tokens` | `application/json` | Live mainnet oracle tokens (same as `sai_list_tokens`) |
| `sai://schema` | `text/markdown` | GraphQL query roots and fields, derived from live introspection, for the `sai_graphql_query` escape hatch |

## Prompts

Reusable analysis templates that surface like slash commands in MCP clients. Each expands into a guided request that drives the relevant tools (the prompt itself runs no tools):

| Prompt | Arguments | Purpose |
|--------|-----------|---------|
| `analyze_trader` | `trader` (required), `network` | Pull a trader's positions, history, portfolio, and fee tier; summarize exposure, PnL, and risk |
| `market_overview` | `network` | Which markets are open, top volume/OI, notable funding rates, biggest movers |
| `vault_yield_report` | `network` | Vault TVL, share price, APY, and best yield opportunities |
| `protocol_health` | `network` | Exchange-wide volume, open interest, TVL, users, and fees |

## Units & conventions

- **Micro-units**: amounts (`tvl`, `collateralAmount`, `oiLong`, etc.) are integers in micro-units. Divide by `10^decimals` — USDC and stNIBI both use **6 decimals**, so divide by 1,000,000.
- **Addresses**: trader, depositor, and referrer filters accept either an EVM hex address (`0x...`) or a Nibiru bech32 address (`nibi1...`); the server converts `0x` to bech32 before querying. Vault filters also accept a vault's EVM share-token address (`sharesERC20`, `0x...`), resolved against the live vault list. Addresses in responses are bech32.
- **Timestamps**: `block_ts` is RFC3339; `epochStart` is in the chain's native time encoding.
- **Funding rate APR**: `feesPerHourLong * 24 * 365 * 100`.
- **Market IDs** (mainnet): Sai lists 100+ markets. Crypto uses low IDs (0 = BTC, 1 = ETH, 16 = SOL); US-stock markets use IDs 1000+ (1000 = QQQ, 1001 = SPY, 1002 = NVDA, …). Collateral IDs: 1 = USDC, 2 = stNIBI. Each (market, collateral) pair is a distinct market — `sai_list_markets` enumerates them all.
- **Trading schedules**: crypto markets trade 24/7 (`tradingSchedule` is null). US-stock/commodity markets carry a `tradingSchedule` (e.g. 09:30–16:00 `America/New_York`, with a `holidays` list) and `isOpen` reflects whether they're currently tradeable. `sai_open_trade` rejects a closed market and reports its hours.

## Configuration

Override any of the three backend endpoints with env vars (handy for self-hosted indexers):

```bash
SAI_KEEPER_ENDPOINT="https://your-indexer.example.com/query" \
SAI_API_ENDPOINT="https://your-stats-api.example.com" \
SAI_CANDLES_ENDPOINT="https://your-candles.example.com" \
  npx sai-mcp
```

- `SAI_KEEPER_ENDPOINT` — GraphQL indexer (most tools).
- `SAI_API_ENDPOINT` — REST stats/dexpal API host (`sai_get_protocol_stats`, `sai_get_yield_opportunities`).
- `SAI_CANDLES_ENDPOINT` — candles (TradingView UDF) API host (`sai_get_candles`).

Default endpoints:

| | GraphQL | REST stats | Candles |
|---|---|---|---|
| **Mainnet** | `https://sai-keeper.nibiru.fi/query` | `https://sai-api.nibiru.fi` | `https://sai-candles.nibiru.fi` |
| **Testnet** | `https://sai-keeper.testnet-2.nibiru.fi/query` | `https://sai-api.testnet-2.nibiru.fi` | `https://sai-candles.testnet-2.nibiru.fi` |

### Remote access (HTTP transport)

By default the server speaks MCP over **stdio** (the client spawns it as a local subprocess). To run it as a long-lived **Streamable HTTP** server instead, set `SAI_HTTP_PORT` (or pass `--http [port]`):

```bash
SAI_HTTP_PORT=3000 npx sai-mcp      # or: npm run start:http
```

Leave it running, then point a client at the URL:

```bash
claude mcp add --transport http sai http://127.0.0.1:3000/
```

| Env | Default | Purpose |
|-----|---------|---------|
| `SAI_HTTP_PORT` | unset (= stdio) | Port to serve Streamable HTTP on. Also enabled by `--http`. |
| `SAI_HTTP_HOST` | `127.0.0.1` | Bind address |
| `SAI_HTTP_TOKEN` | unset | Bearer token required on every request when a signer is configured |
| `SAI_HTTP_ALLOWED_HOSTS` | loopback only | Extra `host:port` values (comma-separated) the DNS-rebinding guard accepts, for a non-local bind |

**Security.** The server binds to `127.0.0.1` and enables DNS-rebinding protection. Because the write tools sign with the configured wallet's key, an open HTTP port lets anyone who can reach it trade with that wallet, so:

- With a signer configured (keystore or `SAI_MNEMONIC` / `SAI_PRIVATE_KEY`) **and** `SAI_HTTP_TOKEN` set, every request must carry `Authorization: Bearer <token>` or it gets `401`.
- With a signer but **no** token, the server still serves the write tools and prints a loud startup warning. Set a token, or drop the signer to run read-only over HTTP.
- Exposing beyond localhost is not recommended. The allowed-host list defaults to loopback, so a non-local bind (e.g. `SAI_HTTP_HOST=0.0.0.0`) must add its public `host:port` to `SAI_HTTP_ALLOWED_HOSTS` or every remote request is rejected with `403`. Do this only behind a bearer token and a TLS-terminating proxy.

Sessions are stateful (the server issues an `Mcp-Session-Id` on initialize); the read-only tools and resources also work over HTTP with no signer and no token.

### Signer setup

Write tools (`sai_open_trade`, `sai_close_trade`, `sai_update_tpsl`, `sai_update_leverage`, `sai_get_wallet_info`) are disabled until you give the MCP server a wallet.

**Recommended (local): a keystore.** Run once and the server auto-loads it; nothing to paste into a config:

```bash
npx sai-mcp keygen --save       # fresh wallet -> ~/.sai-mcp/wallet.json (mode 0600)
```

Already have a wallet? Write `~/.sai-mcp/wallet.json` yourself with `{ "mnemonic": "..." }` or `{ "privateKey": "0x..." }` and `chmod 600` it (see [Existing wallet](#existing-wallet)). There's no import command, so your seed never goes through a shell command or a chat.

**Hosted / Docker / CI: an env-var signer.** Supply **one** (a set env var overrides the keystore):

```bash
SAI_MNEMONIC="word word word ..." npx sai-mcp
# or
SAI_PRIVATE_KEY="0x..." npx sai-mcp
```

Optional:

```bash
SAI_DERIVATION_PATH="m/44'/60'/0'/0/0"   # default; for mnemonic only
SAI_KEYSTORE="~/.sai-mcp/wallet.json"    # default keystore path; consulted only when no env signer is set
```

#### Trade guard rails (operator-set caps)

When the MCP server runs in an agent loop, set hard ceilings the agent cannot raise. Unset = no cap on that dimension; the underlying market constraints still apply.

```bash
SAI_MAX_TRADE_USDC="100"          # max collateral per trade, in human USDC units
SAI_MAX_LEVERAGE="10"             # max leverage per trade
SAI_MAX_POSITION_USD="1000"       # max notional (collateral × leverage)
SAI_MARKET_ALLOWLIST="0,1,16"     # comma-separated marketIds (e.g. 0=BTC, 1=ETH, 16=SOL)
```

Caps are enforced before any network call — including in dry-run mode — so an over-limit request returns an immediate error rather than a confusing simulation. The active caps are echoed back in `sai_open_trade`'s dry-run summary under `guards`, so the agent can see what's in effect.

In a Claude Desktop / Cursor / Claude Code config, pass the env via the `env` field:

```json
{
  "mcpServers": {
    "sai": {
      "command": "npx",
      "args": ["-y", "sai-mcp"],
      "env": {
        "SAI_MNEMONIC": "word word word ..."
      }
    }
  }
}
```

**Treat your keystore (or the env file containing your mnemonic) like any other private key.** The MCP server never exposes the seed via any tool; it only derives the address and signs locally. If you'd rather not give an LLM access to a hot wallet, configure no signer at all; read-only tools continue to work.

## Develop

```bash
npm install
npm run dev          # tsc --watch
npm run inspect      # open MCP Inspector against the server
```

### Testing the CLI locally

To exercise the `sai-mcp` command against your local checkout (e.g. testing changes before publishing, rather than the published version `npx` would fetch), build it and symlink the bin:

```bash
npm install
npm run build        # compile to dist/ (or `npm run dev` to rebuild on change)
npm link             # `sai-mcp` now resolves to this checkout
```

After that, `sai-mcp` (and `sai-mcp keygen`, etc.) run your working copy. `npm unlink -g sai-mcp` removes the symlink when you're done. Note that the MCP server itself doesn't need this — configs launch it directly via `node /absolute/path/to/dist/index.js`.

## License

MIT
