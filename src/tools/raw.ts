import { z } from "zod";
import { graphqlRequest, type Network } from "../client.js";

const MAX_QUERY_BYTES = 100_000;

export const rawQuerySchema = {
  network: z
    .enum(["mainnet", "testnet"])
    .default("mainnet")
    .describe("Network to query. Defaults to mainnet."),
  query: z
    .string()
    .min(1, "query must not be empty")
    .max(MAX_QUERY_BYTES, `query must be ≤ ${MAX_QUERY_BYTES} bytes`)
    .describe(
      "Raw GraphQL query string. Read-only — mutations and subscriptions are rejected.",
    ),
  variables: z
    .record(z.unknown())
    .optional()
    .describe("Optional GraphQL variables object."),
};

// Strip string literals and # comments so we can scan for operation keywords
// without false positives inside payload values.
function stripStringsAndComments(query: string): string {
  return query
    .replace(/#[^\n]*/g, "")
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function assertReadOnly(query: string): void {
  const scrubbed = stripStringsAndComments(query);
  if (/\b(?:mutation|subscription)\b/i.test(scrubbed)) {
    throw new Error(
      "sai_graphql_query is read-only: mutation and subscription operations are not allowed. Use the typed write tools (e.g. sai_open_trade) instead.",
    );
  }
}

export async function rawQuery(args: {
  network?: Network;
  query: string;
  variables?: Record<string, unknown>;
}) {
  assertReadOnly(args.query);
  return graphqlRequest(args.query, args.variables ?? {}, args.network);
}
