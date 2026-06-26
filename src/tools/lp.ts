import { z } from "zod";
import { graphqlRequest, type Network } from "../client.js";
import { normalizeTraderAddress, normalizeEvmAddress } from "../chain.js";
import { microsToUnits } from "../format.js";

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
  // Fetch the vaults and the oracle prices in a single round-trip so each
  // vault's collateral-denominated amounts can be projected to USD below.
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
      oracle {
        tokenPricesUsd(limit: 500) {
          token { symbol }
          priceUsd
        }
      }
    }
  `;
  const data = await graphqlRequest<{
    lp: { vaults: Array<Record<string, any>> | null } | null;
    oracle: {
      tokenPricesUsd: Array<{ token: { symbol: string }; priceUsd: number }>;
    } | null;
  }>(query, {}, args.network);

  // Bug: a vault's `tvl` and `availableAssets` are NOT USD - they are the
  // collateral token in micro-units (6 decimals). For a USDC vault that is also
  // ~USD (USDC ~= $1), but for the stNIBI vaults a verbatim read overstates the
  // dollar value by ~440x (stNIBI ~= $0.0023). Reaching USD requires
  // `/1e6 * collateralPriceUsd`. So attach a units-explicit `human` projection
  // (token amount + USD) next to the raw fields, matching the pattern the perp
  // and oracle tools use. Non-breaking: the raw fields are preserved.
  const priceBySymbol = new Map<string, number>();
  for (const p of data?.oracle?.tokenPricesUsd ?? []) {
    if (p.token?.symbol) priceBySymbol.set(p.token.symbol, Number(p.priceUsd));
  }

  for (const v of data?.lp?.vaults ?? []) {
    const symbol: string | null = v.collateralToken?.symbol ?? null;
    const price = symbol ? priceBySymbol.get(symbol) ?? null : null;
    const tvlTokens = microsToUnits(v.tvl);
    const availableTokens = microsToUnits(v.availableAssets);
    v.human = {
      collateralToken: symbol,
      collateralPriceUsd: price,
      tvlTokens,
      tvlUsd: tvlTokens !== null && price !== null ? tvlTokens * price : null,
      availableAssetsTokens: availableTokens,
      availableAssetsUsd:
        availableTokens !== null && price !== null
          ? availableTokens * price
          : null,
      note: "Vault amounts are denominated in the collateral token, NOT USD. Raw tvl / availableAssets (and the revenueInfo.* fields) are micro-units of collateralToken: divide by 1e6 for token units, then multiply by collateralPriceUsd for USD. For USDC vaults that USD value ~= the token amount; for stNIBI vaults it differs ~440x.",
    };
  }

  // The oracle prices were fetched only to build the per-vault USD projection;
  // drop them so the response keeps its original `{ lp: ... }` shape.
  return { lp: data.lp };
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
  const data = await graphqlRequest<{
    lp: { depositHistory: Array<Record<string, any>> | null } | null;
  }>(query, { where, limit: args.limit, offset: args.offset }, args.network);

  // `amount` is micro-units of the vault's collateral token (NOT USD) and
  // `shares` is micro-units of the vault share token. Each row carries the
  // historical `collateralPrice` (plain USD at event time), so project both to
  // human units and `amount` on to USD. collateralPrice can be 0 on early rows
  // where it was not recorded - treat that as unknown (null USD), not $0.
  for (const d of data?.lp?.depositHistory ?? []) {
    const cp = Number(d.collateralPrice);
    const price = Number.isFinite(cp) && cp > 0 ? cp : null;
    const amountTokens = microsToUnits(d.amount);
    d.human = {
      collateralToken: d.vault?.collateralToken?.symbol ?? null,
      collateralPriceUsd: price,
      amountTokens,
      amountUsd:
        amountTokens !== null && price !== null ? amountTokens * price : null,
      sharesTokens: microsToUnits(d.shares),
      note: "amount is collateral-token micro-units (/1e6 for tokens, then * collateralPriceUsd for USD); shares are vault share-token micro-units (/1e6). collateralPriceUsd is the historical price at event time; null when the keeper did not record it.",
    };
  }

  return data;
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
