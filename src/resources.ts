import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listMarkets } from "./tools/perp.js";
import { listTokens } from "./tools/oracle.js";
import { graphqlRequest } from "./client.js";

// MCP Resources for sai-mcp.
//
// Resources are read-only context surfaces a client can fetch by URI (distinct
// from tools, which the model invokes). We expose four FIXED mainnet URIs
// rather than a network ResourceTemplate: the typed tools already take a
// `network` arg and do their own filtering, so the resources only need to be
// quick mainnet discovery snapshots. A `sai://{network}/...` template would
// double the surface and complicate the list callback for little gain.
//
// - sai://guide   STATIC markdown: protocol conventions + write-tool safety.
// - sai://markets LIVE json: visible mainnet markets (listMarkets).
// - sai://tokens  LIVE json: mainnet oracle tokens (listTokens).
// - sai://schema  LIVE markdown: GraphQL schema reference for sai_graphql_query,
//                 derived from introspection (introspection is enabled on the
//                 keeper endpoint; verified by probe). Falls back to a curated
//                 listing if a read ever fails.
//
// Every live read callback catches its own errors and returns a clear message
// in the contents text rather than throwing, so a transient network failure
// surfaces as readable content instead of a protocol error.

// Mirrors the SERVER_INSTRUCTIONS facts in index.ts, reformatted as markdown
// and enriched with a resource-discovery section. Kept as a standalone string
// (rather than importing SERVER_INSTRUCTIONS) to avoid a circular import
// between index.ts and this module; if you edit the facts in one place, update
// the other.
const GUIDE_MARKDOWN = `# sai-mcp guide

sai-mcp exposes the Sai.fun decentralized perpetual-futures protocol on Nibiru
Chain as MCP tools (live data from the sai-keeper indexer).

## Conventions

- **network**: every tool takes an optional \`network\` ("mainnet" | "testnet"), default mainnet. The resources below are always mainnet; use the tools for testnet.
- **Micro-units**: on-chain amounts (tvl, collateralAmount, oiLong, etc.) are integers in micro-units. Divide by 10^decimals. USDC and stNIBI both use 6 decimals (divide by 1,000,000).
- **Addresses**: traders/depositors are Nibiru bech32 (nibi1...). The signer also has a 0x EVM address.
- **Timestamps**: \`block_ts\` is RFC3339.
- **Funding-rate APR**: \`feesPerHourLong * 24 * 365 * 100\`.
- **Market IDs (mainnet)**: crypto uses low IDs (0=BTC, 1=ETH, 16=SOL); US-stock markets use IDs 1000+ (1000=QQQ, 1001=SPY, 1002=NVDA). Collateral IDs: 1=USDC, 2=stNIBI. Each (market, collateral) pair is a distinct market; \`sai_list_markets\` enumerates them all.
- **Trading schedules**: crypto trades 24/7 (\`tradingSchedule\` is null). US-stock/commodity markets carry a \`tradingSchedule\` and \`isOpen\` reflects whether they are currently tradeable; \`sai_open_trade\` rejects a closed market.

## Reads are eventually-consistent

Read tools query a live indexer delayed behind the chain by a few seconds to
~1-2 minutes, and are NOT read-your-writes. Immediately after a write,
\`sai_get_trader_trades\` may still show stale (pre-write) state. Confirm a write
landed via the broadcast tx receipt (status: success) and/or the matching
\`sai_get_trader_history\` event (match on \`evmTxHash\`), not
\`sai_get_trader_trades\`.

## Write tools

\`sai_open_trade\`, \`sai_close_trade\`, \`sai_update_tpsl\`, \`sai_update_leverage\`:

- Require a signer: set \`SAI_MNEMONIC\` or \`SAI_PRIVATE_KEY\` in the MCP server environment. Inert otherwise.
- **DEFAULT TO DRY-RUN** (\`confirm=false\`): they simulate + gas-estimate and return a summary WITHOUT signing or broadcasting. Always preview with \`confirm=false\`, show the summary to the user, then re-run with \`confirm=true\` to broadcast.
- Acting on a position within ~1-2 minutes of opening it can revert on-chain even when the dry-run gas estimate succeeds (the contract enforces a brief minimum hold that \`eth_estimateGas\` does not simulate). The close/update dry-runs flag this under "warning".

## Resources

- \`sai://guide\` (this page): conventions + the write-tool safety model.
- \`sai://markets\`: live JSON list of visible mainnet markets (the \`sai_list_markets\` payload).
- \`sai://tokens\`: live JSON list of mainnet oracle tokens (the \`sai_list_tokens\` payload).
- \`sai://schema\`: GraphQL schema reference (query roots and their fields) for the \`sai_graphql_query\` escape hatch.

For anything the typed tools do not cover, use \`sai_graphql_query\` (schema
explorer: https://sai-keeper.nibiru.fi/).
`;

// Standard GraphQL introspection query, trimmed to the shape we render: the
// query/mutation root names and, per type, its fields with arg names and the
// (unwrapped) return type name. Introspection is enabled on the keeper
// endpoint, so sai://schema serves a derived view of this at read time.
const INTROSPECTION_QUERY = `
  query SaiSchemaIntrospection {
    __schema {
      queryType { name }
      mutationType { name }
      types {
        kind
        name
        fields(includeDeprecated: true) {
          name
          args { name }
          type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
        }
      }
    }
  }
`;

interface IntrospectionTypeRef {
  kind: string;
  name: string | null;
  ofType?: IntrospectionTypeRef | null;
}

interface IntrospectionField {
  name: string;
  args?: Array<{ name: string }>;
  type: IntrospectionTypeRef;
}

interface IntrospectionType {
  kind: string;
  name: string;
  fields?: IntrospectionField[] | null;
}

interface IntrospectionSchema {
  queryType: { name: string } | null;
  mutationType: { name: string } | null;
  types: IntrospectionType[];
}

// Peel LIST/NON_NULL wrappers off a type ref down to the named type.
function unwrapTypeName(t: IntrospectionTypeRef | null | undefined): string {
  let cur = t;
  while (cur) {
    if (cur.name) return cur.name;
    cur = cur.ofType ?? null;
  }
  return "?";
}

// Render a compact markdown view: the query roots, each root object type's
// fields (with arg names and return types), the Mutation fields, and a catalog
// of object type names. This is far smaller than the raw ~69KB introspection
// JSON while still giving the model enough to hand-write sai_graphql_query
// calls.
function renderSchemaMarkdown(schema: IntrospectionSchema): string {
  const byName = new Map(schema.types.map((t) => [t.name, t]));
  const queryRoot = schema.queryType?.name;
  const mutationRoot = schema.mutationType?.name;

  const lines: string[] = [];
  lines.push("# Sai GraphQL schema (live introspection)");
  lines.push("");
  lines.push(
    "Reference for the `sai_graphql_query` escape hatch. Query roots and their" +
      " fields are listed below as `field(args) -> ReturnType`. Explorer:" +
      " https://sai-keeper.nibiru.fi/",
  );
  lines.push("");

  // Walk: the Query root, then each top-level root field's object type
  // (perp, oracle, lp, ...), then the Mutation root.
  const queryObj = queryRoot ? byName.get(queryRoot) : undefined;
  const rootFieldTypes = (queryObj?.fields ?? []).map((f) =>
    unwrapTypeName(f.type),
  );
  const visitOrder = [queryRoot, mutationRoot, ...rootFieldTypes].filter(
    (n): n is string => Boolean(n),
  );

  const seen = new Set<string>();
  for (const name of visitOrder) {
    if (seen.has(name)) continue;
    seen.add(name);
    const t = byName.get(name);
    if (!t || !t.fields || t.fields.length === 0) continue;
    lines.push(`## ${name}`);
    for (const f of t.fields) {
      const args = (f.args ?? []).map((a) => a.name).join(", ");
      lines.push(`- ${f.name}(${args}) -> ${unwrapTypeName(f.type)}`);
    }
    lines.push("");
  }

  const objectNames = schema.types
    .filter((t) => t.kind === "OBJECT" && !t.name.startsWith("__"))
    .map((t) => t.name)
    .sort();
  lines.push(`## Object types (${objectNames.length})`);
  lines.push(objectNames.join(", "));
  lines.push("");

  return lines.join("\n");
}

// Curated fallback, used only if live introspection ever fails (network error
// or introspection disabled). Query roots gleaned from the typed-tool queries
// in src/tools/*.ts.
const SCHEMA_FALLBACK = `# Sai GraphQL schema (curated fallback)

Live introspection was unavailable, so this is a hand-maintained summary of the
query roots used by the typed tools. Explorer: https://sai-keeper.nibiru.fi/

## Query roots

- perp { trade, trades, tradeHistory, borrowing, borrowings, statsUserPortfolio, traderFeeTierProgress, leaderboard, volumeLeaderboard, volumeMarathonLeaderboard, cookoutLeaderboard }
- oracle { tokens, token, tokenPricesUsd }
- lp { vaults, depositHistory, withdrawRequests, vaultStats, epochDurationDays, epochDurationHours }
- referral { referralCodes, referralTrades, referralRedemption, referralRedemptionTrader, referralClaims, referralStats }
- saiPoints { summary, tasks, taskCompletions, redemptions }
- appVersion { dev, prod }

Some aggregate stats (protocol-wide volume/OI/TVL/fees, yield opportunities) and
OHLCV candles are served by separate REST APIs, not GraphQL.
`;

export function registerResources(server: McpServer) {
  // sai://guide -- static markdown. No fetch, so it cannot fail.
  server.registerResource(
    "guide",
    "sai://guide",
    {
      title: "Sai MCP guide",
      description:
        "Protocol conventions and the write-tool safety model (dry-run defaults, eventual consistency, micro-units, market IDs).",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: GUIDE_MARKDOWN },
      ],
    }),
  );

  // sai://markets -- live visible mainnet markets.
  server.registerResource(
    "markets",
    "sai://markets",
    {
      title: "Sai markets (mainnet)",
      description:
        "Live list of visible mainnet perpetual markets (marketId, tokens, isOpen, tradingSchedule). Same payload as sai_list_markets. For testnet or full per-market detail use the tools.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const markets = await listMarkets({
          network: "mainnet",
          visibleOnly: true,
          limit: 500,
        });
        const body = {
          network: "mainnet",
          fetchedAt: new Date().toISOString(),
          count: Array.isArray(markets) ? markets.length : null,
          markets,
        };
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(body, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(
                {
                  network: "mainnet",
                  fetchedAt: new Date().toISOString(),
                  count: null,
                  markets: [],
                  error: `Failed to load mainnet markets: ${message}`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // sai://tokens -- live mainnet oracle token list.
  server.registerResource(
    "tokens",
    "sai://tokens",
    {
      title: "Sai oracle tokens (mainnet)",
      description:
        "Live list of tokens known to the Sai oracle on mainnet (id, symbol, name, description, type). Same data as sai_list_tokens.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const data = await listTokens({ network: "mainnet", limit: 500 });
        // listTokens returns the raw GraphQL shape { oracle: { tokens: [...] } };
        // unwrap to the array, falling back to the raw payload if the shape shifts.
        const tokens =
          (data as { oracle?: { tokens?: unknown } })?.oracle?.tokens ?? data;
        const body = {
          network: "mainnet",
          fetchedAt: new Date().toISOString(),
          count: Array.isArray(tokens) ? tokens.length : null,
          tokens,
        };
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(body, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(
                {
                  network: "mainnet",
                  fetchedAt: new Date().toISOString(),
                  count: null,
                  tokens: [],
                  error: `Failed to load mainnet oracle tokens: ${message}`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // sai://schema -- live GraphQL introspection, rendered to compact markdown.
  server.registerResource(
    "schema",
    "sai://schema",
    {
      title: "Sai GraphQL schema",
      description:
        "Schema reference for the sai_graphql_query escape hatch: query roots and their fields, derived from live introspection of the mainnet keeper endpoint.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      try {
        const data = await graphqlRequest<{ __schema?: IntrospectionSchema }>(
          INTROSPECTION_QUERY,
          {},
          "mainnet",
        );
        const schema = data?.__schema;
        if (!schema) throw new Error("introspection returned no __schema");
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/markdown",
              text: renderSchemaMarkdown(schema),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const text = `${SCHEMA_FALLBACK}\n> Live introspection failed: ${message}\n`;
        return {
          contents: [{ uri: uri.href, mimeType: "text/markdown", text }],
        };
      }
    },
  );
}
