import { z } from "zod";
import { graphqlRequest, type Network } from "../client.js";
import { normalizeTraderAddress, normalizeEvmAddress } from "../chain.js";

const NetworkSchema = z
  .enum(["mainnet", "testnet"])
  .default("mainnet")
  .describe("Network to query. Defaults to mainnet.");

const VAULT_ADDRESS_DESC =
  "Vault address: the bech32 CosmWasm address (nibi1...) or the vault's EVM share-token address (sharesERC20, 0x...). The 0x form is resolved against the live vault list.";

// Vaults are CosmWasm contracts the keeper indexes by their bech32 address, but
// each also issues an EVM share token (sharesERC20). The two forms are unrelated
// byte-wise (unlike a wallet's 0x/bech32 pair), so 0x -> bech32 can't be derived
// locally - it requires a lookup against the live vault list. We cache the map
// per network and refetch on a miss so a vault added after the cache warmed
// still resolves.
type VaultMap = { shares: Map<string, string>; collateral: Set<string> };
const vaultMapCache = new Map<Network, VaultMap>();

async function loadVaultMap(network: Network): Promise<VaultMap> {
  const data = await graphqlRequest<{
    lp: {
      vaults: Array<{
        address: string;
        sharesERC20: string;
        collateralERC20: string;
      }>;
    } | null;
  }>(`{ lp { vaults { address sharesERC20 collateralERC20 } } }`, {}, network);
  const shares = new Map<string, string>();
  const collateral = new Set<string>();
  for (const v of data?.lp?.vaults ?? []) {
    if (v.sharesERC20) shares.set(v.sharesERC20.toLowerCase(), v.address);
    if (v.collateralERC20) collateral.add(v.collateralERC20.toLowerCase());
  }
  return { shares, collateral };
}

// Resolve a vault filter to the bech32 address the keeper indexes by. Bech32
// passes through; an EVM share-token address (0x...) is looked up. A miss
// triggers one refetch before erroring; a collateral-token 0x gets a targeted
// hint since it is a common mix-up (collateral is shared across vaults).
export async function resolveVaultAddress(
  vault: string,
  network: Network,
): Promise<string> {
  const trimmed = vault.trim();
  if (!/^0x/i.test(trimmed)) return trimmed;
  const key = normalizeEvmAddress(trimmed).toLowerCase();

  let map = vaultMapCache.get(network);
  if (!map) {
    map = await loadVaultMap(network);
    vaultMapCache.set(network, map);
  }
  let hit = map.shares.get(key);
  if (!hit) {
    // Refetch once in case a vault was added after the cache warmed.
    map = await loadVaultMap(network);
    vaultMapCache.set(network, map);
    hit = map.shares.get(key);
  }
  if (!hit) {
    if (map.collateral.has(key)) {
      throw new Error(
        `${vault} is a vault collateral token, not a vault share token. Pass the vault's bech32 address (nibi1...) or its share-token (sharesERC20) EVM address - see sai_list_vaults.`,
      );
    }
    throw new Error(
      `No vault found with EVM share-token address ${vault}. Use sai_list_vaults to see each vault's bech32 address and sharesERC20 (0x).`,
    );
  }
  return hit;
}

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
  vault: z.string().min(1).describe(VAULT_ADDRESS_DESC),
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
  const vault = await resolveVaultAddress(args.vault, args.network);
  return graphqlRequest(query, { vault, range: args.range }, args.network);
}

export const getDepositHistorySchema = {
  network: NetworkSchema,
  depositor: z
    .string()
    .optional()
    .describe(
      "Optional depositor address filter: a Nibiru bech32 address (nibi1...) or an EVM hex address (0x...).",
    ),
  vault: z
    .string()
    .optional()
    .describe(
      "Optional vault filter: bech32 (nibi1...) or the vault's EVM share-token address (sharesERC20, 0x...).",
    ),
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
  if (args.depositor) where.depositor = normalizeTraderAddress(args.depositor);
  if (args.vault) where.vault = await resolveVaultAddress(args.vault, args.network);

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
  depositor: z
    .string()
    .optional()
    .describe(
      "Optional depositor address filter: a Nibiru bech32 address (nibi1...) or an EVM hex address (0x...).",
    ),
  vault: z
    .string()
    .optional()
    .describe(
      "Optional vault filter: bech32 (nibi1...) or the vault's EVM share-token address (sharesERC20, 0x...).",
    ),
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
  if (args.depositor) where.depositor = normalizeTraderAddress(args.depositor);
  if (args.vault) where.vault = await resolveVaultAddress(args.vault, args.network);

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
