import { z } from "zod";
import { restRequest, type Network } from "../client.js";

const NetworkSchema = z
  .enum(["mainnet", "testnet"])
  .default("mainnet")
  .describe("Network to query. Defaults to mainnet.");

export const getProtocolStatsSchema = {
  network: NetworkSchema,
};

export async function getProtocolStats(args: { network: Network }) {
  // Exchange-wide aggregates served by the keeper REST ("dexpal") API, not the
  // GraphQL endpoint: 24h/7d/30d/all-time volume, trades, open interest, users,
  // open positions, TVL, and accrued trading fees. All dollar amounts in USD.
  // The endpoint returns both camelCase and snake_case keys for the same values;
  // passed through verbatim.
  return restRequest("/dexpal/v1/stats", args.network);
}

export const getYieldOpportunitiesSchema = {
  network: NetworkSchema,
};

export async function getYieldOpportunities(args: { network: Network }) {
  // Yield/earning opportunities (LP vaults: accepted deposits, APY/APR, TVL).
  return restRequest("/dexpal/v1/yield", args.network);
}
