import { z } from "zod";
import { graphqlRequest, type Network } from "../client.js";

const NetworkSchema = z
  .enum(["mainnet", "testnet"])
  .default("mainnet")
  .describe("Network to query. Defaults to mainnet.");

export const listVaultsSchema = {
  network: NetworkSchema,
};

export async function listVaults(args: { network: Network }) {
  const query = `
    {
      lp {
        vaults {
          address
          collateralDenom
          collateralToken { symbol name logoUrl }
          collateralERC20
          sharesDenom
          sharesERC20
          tvl
          sharePrice
          apy
          feeApy
          availableAssets
          currentEpoch
          epochStart
          revenueInfo {
            RevenueCumulative
            NetProfit
            TraderLosses
            ClosedPnl
            CurrentEpochPositiveOpenPnl
            Liabilities
            Rewards
          }
        }
        epochDurationDays
        epochDurationHours
      }
    }
  `;
  return graphqlRequest(query, {}, args.network);
}

export const getVaultStatsSchema = {
  network: NetworkSchema,
  vault: z.string().min(1).describe("Vault address (nibi1...)."),
  range: z
    .enum(["1d", "7d", "30d", "all"])
    .default("all")
    .describe("Time range. Defaults to 'all'."),
};

export async function getVaultStats(args: {
  network: Network;
  vault: string;
  range: "1d" | "7d" | "30d" | "all";
}) {
  const query = `
    query VaultStats($vault: String!, $range: String!) {
      lp {
        vaultStats(vault: $vault, range: $range) {
          timestamp
          sharePrice
          apy
          deposits
          depositsUsd
          withdrawals
          withdrawalsUsd
          volume
          volumeUsd
        }
      }
    }
  `;
  return graphqlRequest(
    query,
    { vault: args.vault, range: args.range },
    args.network,
  );
}

export const getDepositHistorySchema = {
  network: NetworkSchema,
  depositor: z.string().optional().describe("Optional depositor bech32 address filter."),
  vault: z.string().optional().describe("Optional vault address filter."),
  limit: z.number().int().positive().max(500).default(50),
  offset: z.number().int().nonnegative().default(0),
};

export async function getDepositHistory(args: {
  network: Network;
  depositor?: string;
  vault?: string;
  limit: number;
  offset: number;
}) {
  const where: Record<string, unknown> = {};
  if (args.depositor) where.depositor = args.depositor;
  if (args.vault) where.vault = args.vault;

  const query = `
    query DepositHistory($where: LpDepositHistoryFilter, $limit: Int, $offset: Int) {
      lp {
        depositHistory(where: $where, limit: $limit, offset: $offset, order_desc: true) {
          id
          action
          depositor
          amount
          shares
          collateralPrice
          txHash
          evmTxHash
          vault { address collateralToken { symbol } }
          block { block block_ts }
        }
      }
    }
  `;
  return graphqlRequest(
    query,
    { where, limit: args.limit, offset: args.offset },
    args.network,
  );
}

export const getWithdrawRequestsSchema = {
  network: NetworkSchema,
  depositor: z.string().optional().describe("Optional depositor bech32 address filter."),
  vault: z.string().optional().describe("Optional vault address filter."),
  limit: z.number().int().positive().max(500).default(100),
  offset: z.number().int().nonnegative().default(0),
};

export async function getWithdrawRequests(args: {
  network: Network;
  depositor?: string;
  vault?: string;
  limit: number;
  offset: number;
}) {
  const where: Record<string, unknown> = {};
  if (args.depositor) where.depositor = args.depositor;
  if (args.vault) where.vault = args.vault;

  const query = `
    query Withdraws($where: LpWithdrawRequestsFilter, $limit: Int, $offset: Int) {
      lp {
        withdrawRequests(where: $where, limit: $limit, offset: $offset) {
          depositor
          shares
          unlockEpoch
          autoRedeem
          vault {
            address
            currentEpoch
            collateralToken { symbol }
          }
        }
      }
    }
  `;
  return graphqlRequest(
    query,
    { where, limit: args.limit, offset: args.offset },
    args.network,
  );
}
