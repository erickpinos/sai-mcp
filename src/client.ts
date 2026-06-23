const ENDPOINTS = {
  mainnet: "https://sai-keeper.nibiru.fi/query",
  testnet: "https://sai-keeper.testnet-2.nibiru.fi/query",
} as const;

// REST stats ("dexpal") API — exchange-wide aggregates (volume, OI, TVL, fees,
// users) and yield opportunities. Served by the keeper's `-api` process on a
// different host than the GraphQL endpoint, so it has its own base URL.
const REST_ENDPOINTS = {
  mainnet: "https://sai-api.nibiru.fi",
  testnet: "https://sai-api.testnet-2.nibiru.fi",
} as const;

// TradingView UDF candle (OHLCV) API — served by the keeper's candles process.
const CANDLES_ENDPOINTS = {
  mainnet: "https://sai-candles.nibiru.fi",
  testnet: "https://sai-candles.testnet-2.nibiru.fi",
} as const;

export type Network = keyof typeof ENDPOINTS;

export function getEndpoint(network: Network = "mainnet"): string {
  return process.env.SAI_KEEPER_ENDPOINT ?? ENDPOINTS[network];
}

export function getRestEndpoint(network: Network = "mainnet"): string {
  return process.env.SAI_API_ENDPOINT ?? REST_ENDPOINTS[network];
}

export function getCandlesEndpoint(network: Network = "mainnet"): string {
  return process.env.SAI_CANDLES_ENDPOINT ?? CANDLES_ENDPOINTS[network];
}

export async function restRequest<T = unknown>(
  path: string,
  network: Network = "mainnet",
  base: string = getRestEndpoint(network),
): Promise<T> {
  const url = `${base}${path}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`sai REST HTTP ${res.status} (${url}): ${await res.text()}`);
  }
  return (await res.json()) as T;
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
