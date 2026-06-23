import { z } from "zod";
import { graphqlRequest, type Network } from "../client.js";

const NetworkSchema = z
  .enum(["mainnet", "testnet"])
  .default("mainnet")
  .describe("Network to query. Defaults to mainnet.");

export const getReferralsSchema = {
  network: NetworkSchema,
  referrer: z
    .string()
    .min(1)
    .describe("Referrer bech32 address (nibi1...) whose referral program to inspect."),
  range: z
    .enum(["1d", "7d", "30d", "all"])
    .default("all")
    .describe("Time range for the referralStats time series. Defaults to 'all'."),
  tradesLimit: z.number().int().positive().max(500).default(50),
  claimsLimit: z.number().int().positive().max(200).default(50),
};

export async function getReferrals(args: {
  network: Network;
  referrer: string;
  range: "1d" | "7d" | "30d" | "all";
  tradesLimit: number;
  claimsLimit: number;
}) {
  // One round-trip covers a referrer's whole program: their codes (with
  // aggregate unique traders / earnings / volume), recent attributed trades,
  // claim events, and a time series of earnings/volume.
  const query = `
    query Referrals(
      $referrer: String!
      $range: String!
      $tradesLimit: Int
      $claimsLimit: Int
    ) {
      referral {
        referralCodes(referrer: $referrer) {
          code
          active
          uniqueTraders
          earningsUSD
          volumeUSD
        }
        referralTrades(referrer: $referrer, limit: $tradesLimit) {
          code
          trader
          tradeId
          volumeUSD
          earningsUSD
          block { block block_ts }
          txHash
          evmTxHash
        }
        referralClaims(referrer: $referrer, limit: $claimsLimit) {
          amount { denom amount }
          block { block block_ts }
          txHash
          evmTxHash
        }
        referralStats(referrer: $referrer, range: $range) {
          timestamp
          tradesCount
          earningsUSD
          volumeUSD
        }
      }
    }
  `;
  return graphqlRequest(
    query,
    {
      referrer: args.referrer,
      range: args.range,
      tradesLimit: args.tradesLimit,
      claimsLimit: args.claimsLimit,
    },
    args.network,
  );
}

export const getReferralForTraderSchema = {
  network: NetworkSchema,
  trader: z
    .string()
    .min(1)
    .describe("Trader bech32 address (nibi1...) to look up the redeemed referral for."),
};

export async function getReferralForTrader(args: {
  network: Network;
  trader: string;
}) {
  const query = `
    query ReferralForTrader($trader: String!) {
      referral {
        referralRedemptionTrader(trader: $trader) {
          referrer
          trader
          code
          active
          block { block block_ts }
          txHash
        }
      }
    }
  `;
  return graphqlRequest(query, { trader: args.trader }, args.network);
}
