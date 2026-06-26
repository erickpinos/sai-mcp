import { z } from "zod";
import { graphqlRequest, type Network } from "../client.js";
import { humanAge } from "../format.js";

const NetworkSchema = z
  .enum(["mainnet", "testnet"])
  .default("mainnet")
  .describe("Network to query. Defaults to mainnet.");

// A price not refreshed within this window is flagged stale. Live crypto feeds
// refresh every few seconds; a price minutes/hours/months old (dead feed, or a
// market that simply has not traded) is surfaced loudly so a caller never quotes
// a months-old number as current. Scheduled markets (stocks/commodities) read
// stale outside their trading hours, which is correct: the price IS stale.
const PRICE_STALE_AFTER_SEC = 3600;

export const getTokenPricesSchema = {
  network: NetworkSchema,
  tokenId: z
    .number()
    .int()
    .optional()
    .describe("Optional oracle token id to fetch a single price."),
  limit: z.number().int().positive().max(500).default(200),
};

export async function getTokenPrices(args: {
  network: Network;
  tokenId?: number;
  limit: number;
}) {
  const where = args.tokenId !== undefined ? { tokenId: args.tokenId } : {};
  const query = `
    query Prices($where: TokenPriceUsdFilter, $limit: Int) {
      oracle {
        tokenPricesUsd(where: $where, limit: $limit) {
          token { id symbol name }
          priceUsd
          lastUpdatedBlock { block block_ts }
        }
      }
    }
  `;
  const data = await graphqlRequest<{
    oracle: { tokenPricesUsd: Array<Record<string, any>> } | null;
  }>(query, { where, limit: args.limit }, args.network);

  // Bug #7: enrich each price with a staleness signal so a months-old feed is
  // obvious. Non-breaking: adds ageSeconds / lastUpdatedAgo / stale alongside
  // the existing priceUsd and lastUpdatedBlock fields.
  const now = Date.now();
  for (const p of data?.oracle?.tokenPricesUsd ?? []) {
    const ms = p.lastUpdatedBlock?.block_ts
      ? Date.parse(p.lastUpdatedBlock.block_ts)
      : NaN;
    if (Number.isFinite(ms)) {
      p.ageSeconds = Math.max(0, Math.round((now - ms) / 1000));
      p.lastUpdatedAgo = humanAge(ms, now);
      p.stale = p.ageSeconds > PRICE_STALE_AFTER_SEC;
    } else {
      p.ageSeconds = null;
      p.lastUpdatedAgo = null;
      p.stale = null;
    }
  }
  return data;
}

export const listTokensSchema = {
  network: NetworkSchema,
  limit: z.number().int().positive().max(500).default(200),
};

export async function listTokens(args: { network: Network; limit: number }) {
  const query = `
    query Tokens($limit: Int) {
      oracle {
        tokens(limit: $limit) {
          id
          symbol
          name
          description
          type
          permissionGroup
          logoUrl
        }
      }
    }
  `;
  return graphqlRequest(query, { limit: args.limit }, args.network);
}
