import { z } from "zod";
import { graphqlRequest, type Network } from "../client.js";

const NetworkSchema = z
  .enum(["mainnet", "testnet"])
  .default("mainnet")
  .describe("Network to query. Defaults to mainnet.");

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
  network?: Network;
  tokenId?: number;
  limit?: number;
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
  return graphqlRequest(
    query,
    { where, limit: args.limit ?? 200 },
    args.network,
  );
}

export const listTokensSchema = {
  network: NetworkSchema,
  limit: z.number().int().positive().max(500).default(200),
};

export async function listTokens(args: { network?: Network; limit?: number }) {
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
  return graphqlRequest(query, { limit: args.limit ?? 200 }, args.network);
}
