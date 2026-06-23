import { z } from "zod";
import { graphqlRequest, type Network } from "../client.js";

const NetworkSchema = z
  .enum(["mainnet", "testnet"])
  .default("mainnet")
  .describe("Network to query. Defaults to mainnet.");

// Each board maps to a distinct root field on `perp` with its own row shape.
const BOARDS = {
  pnl: {
    field: "leaderboard",
    paged: true,
    selection: `
      rank
      reward
      trader
      traderEvmAddress
      realizedPnlTotalUsd
      roiTotal
      capitalUsedUsd
      volumeTotalUsd
    `,
  },
  volume: {
    field: "volumeLeaderboard",
    paged: false,
    selection: `
      rank
      reward
      trader
      traderEvmAddress
      volumeTotalUsd
      thresholdBlock
      thresholdBlockTs
    `,
  },
  volumeMarathon: {
    field: "volumeMarathonLeaderboard",
    paged: false,
    selection: `
      rank
      reward
      trader
      traderEvmAddress
      volumeTotalUsd
    `,
  },
  cookout: {
    field: "cookoutLeaderboard",
    paged: true,
    selection: `
      rank
      reward
      trader
      traderEvmAddress
      positivePnlUsd
      netPnlUsd
      volumeUsd
      totalCollateralUsd
      totalTradesCount
      daysOfActivity
    `,
  },
} as const;

type BoardKey = keyof typeof BOARDS;

export const getLeaderboardSchema = {
  network: NetworkSchema,
  board: z
    .enum(["pnl", "volume", "volumeMarathon", "cookout"])
    .default("pnl")
    .describe(
      "Which leaderboard: 'pnl' (realized PnL + rewards), 'volume' (trading volume race), 'volumeMarathon' (long-running volume campaign), or 'cookout' (event leaderboard). Defaults to 'pnl'.",
    ),
  limit: z.number().int().positive().max(500).default(25),
  offset: z.number().int().nonnegative().default(0),
};

export async function getLeaderboard(args: {
  network: Network;
  board: BoardKey;
  limit: number;
  offset: number;
}) {
  const board = BOARDS[args.board];
  const query = board.paged
    ? `query Leaderboard($limit: Int, $offset: Int) {
        perp { ${board.field}(limit: $limit, offset: $offset) { ${board.selection} } }
      }`
    : `query Leaderboard {
        perp { ${board.field} { ${board.selection} } }
      }`;
  const variables = board.paged ? { limit: args.limit, offset: args.offset } : {};
  return graphqlRequest(query, variables, args.network);
}
