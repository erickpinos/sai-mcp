# Changelog

All notable changes to **sai-mcp** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Tool annotations** on all 24 tools: read tools get `title`, `readOnlyHint`, `openWorldHint`; the 4 write tools additionally get `destructiveHint` and `idempotentHint: false`. Lets clients distinguish the 20 read tools from the on-chain write tools.
- **Structured output**: tools now return `structuredContent` alongside the human-readable text. The write tools and `sai_get_wallet_info` advertise a typed `outputSchema`; read tools return their payload under a `result` envelope.
- **Server `instructions`**: the initialize response now carries the protocol conventions (micro-units, market IDs, funding-rate formula) and the write-tool safety model, so a connected model has the context without being told.
- **MCP Resources**: `sai://guide` (conventions + safety model), `sai://markets` and `sai://tokens` (live mainnet snapshots), and `sai://schema` (GraphQL query roots and fields, derived from live introspection of the keeper endpoint, with a curated fallback).
- **MCP Prompts**: `analyze_trader`, `market_overview`, `vault_yield_report`, and `protocol_health` analysis templates that drive the relevant tools.
- **Optional Streamable HTTP transport**: set `SAI_HTTP_PORT` (or pass `--http [port]`) to serve over HTTP instead of stdio. Stateful sessions (capped), binds to `127.0.0.1` with DNS-rebinding protection, a request body size limit, and an optional `SAI_HTTP_TOKEN` bearer gate (constant-time check) enforced whenever a signer is configured. `SAI_HTTP_HOST` overrides the bind address and `SAI_HTTP_ALLOWED_HOSTS` widens the host allowlist for non-local binds. Added the `start:http` npm script.

### Changed

- Server construction is now a `createServer()` factory shared by both the stdio and HTTP transports, so tools, resources, and prompts are registered in exactly one place.
- README: scoped the "refuses to broadcast if gas estimation fails" note to the management tools, since `sai_open_trade` deliberately falls back to a fixed gas limit and broadcasts anyway (flagged via `broadcastWithFallbackGas`).

## [0.1.0]

### Added

- Initial release. MCP server exposing the `sai-keeper` GraphQL indexer, REST stats API, and candles API as tools: markets, trader positions and history, portfolios, fee tiers, LP vaults, oracle prices, referrals, leaderboards, protocol stats, yield opportunities, OHLCV candles, and a `sai_graphql_query` escape hatch.
- Opt-in on-chain write tools (`sai_open_trade`, `sai_close_trade`, `sai_update_tpsl`, `sai_update_leverage`, `sai_get_wallet_info`) gated on a signer (`SAI_MNEMONIC` / `SAI_PRIVATE_KEY`), defaulting to dry-run, with operator-set trade guard rails.
