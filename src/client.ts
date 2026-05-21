const ENDPOINTS = {
  mainnet: "https://sai-keeper.nibiru.fi/query",
  testnet: "https://sai-keeper.testnet-2.nibiru.fi/query",
} as const;

export type Network = keyof typeof ENDPOINTS;

export function getEndpoint(network: Network = "mainnet"): string {
  return process.env.SAI_KEEPER_ENDPOINT ?? ENDPOINTS[network];
}

export interface GraphQLError {
  message: string;
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
}

export async function graphqlRequest<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
  network: Network = "mainnet",
): Promise<T> {
  const endpoint = getEndpoint(network);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`sai-keeper HTTP ${res.status}: ${await res.text()}`);
  }

  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors?.length) {
    throw new Error(
      `sai-keeper GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (body.data === undefined) {
    throw new Error("sai-keeper returned no data");
  }
  return body.data;
}
