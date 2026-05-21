import { z } from "zod";
import { graphqlRequest, type Network } from "../client.js";

export const rawQuerySchema = {
  network: z
    .enum(["mainnet", "testnet"])
    .default("mainnet")
    .describe("Network to query. Defaults to mainnet."),
  query: z
    .string()
    .describe(
      "Raw GraphQL query string. Use for queries not covered by the typed tools.",
    ),
  variables: z
    .record(z.unknown())
    .optional()
    .describe("Optional GraphQL variables object."),
};

export async function rawQuery(args: {
  network?: Network;
  query: string;
  variables?: Record<string, unknown>;
}) {
  return graphqlRequest(args.query, args.variables ?? {}, args.network);
}
