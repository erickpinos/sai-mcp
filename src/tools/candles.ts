import { z } from "zod";
import { getCandlesEndpoint, restRequest, type Network } from "../client.js";

const NetworkSchema = z
  .enum(["mainnet", "testnet"])
  .default("mainnet")
  .describe("Network to query. Defaults to mainnet.");

// TradingView UDF resolutions accepted by the candles service.
const RESOLUTIONS = ["1", "5", "15", "60", "240", "360", "720", "1D", "1W", "1M"] as const;

export const getCandlesSchema = {
  network: NetworkSchema,
  symbol: z
    .string()
    .min(1)
    .describe(
      "Market base symbol, e.g. 'BTC', 'ETH', 'SOL', 'NVDA'. Use the baseToken symbol from sai_list_markets.",
    ),
  resolution: z
    .enum(RESOLUTIONS)
    .default("60")
    .describe(
      "Candle resolution in minutes, or 1D/1W/1M. One of: 1, 5, 15, 60, 240, 360, 720, 1D, 1W, 1M. Defaults to 60 (1h).",
    ),
  from: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Range start as a Unix timestamp in seconds. Defaults to `to` minus `countback` bars."),
  to: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Range end as a Unix timestamp in seconds. Defaults to now."),
  countback: z
    .number()
    .int()
    .positive()
    .max(5000)
    .default(200)
    .describe("Number of bars to return ending at `to` when `from` is omitted. Defaults to 200."),
};

// Approximate seconds-per-bar for each resolution, used only to derive a default
// `from` when the caller gives a countback instead of an explicit range.
function resolutionSeconds(resolution: string): number {
  if (resolution === "1D") return 86_400;
  if (resolution === "1W") return 7 * 86_400;
  if (resolution === "1M") return 30 * 86_400;
  return Number(resolution) * 60;
}

type UdfHistory = {
  s: string; // "ok" | "no_data" | "error"
  t?: number[];
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
  v?: number[];
  nextTime?: number;
  errmsg?: string;
};

export async function getCandles(args: {
  network: Network;
  symbol: string;
  resolution: (typeof RESOLUTIONS)[number];
  from?: number;
  to?: number;
  countback: number;
}) {
  const to = args.to ?? Math.floor(Date.now() / 1000);
  const from =
    args.from ?? to - args.countback * resolutionSeconds(args.resolution);

  const params = new URLSearchParams({
    symbol: args.symbol,
    resolution: args.resolution,
    from: String(from),
    to: String(to),
  });

  const data = await restRequest<UdfHistory>(
    `/candles/udf/history?${params.toString()}`,
    args.network,
    getCandlesEndpoint(args.network),
  );

  if (data.s === "no_data") {
    return {
      symbol: args.symbol,
      resolution: args.resolution,
      from,
      to,
      status: "no_data",
      nextTime: data.nextTime ?? null,
      candles: [],
    };
  }
  if (data.s !== "ok") {
    throw new Error(`candles API returned status '${data.s}': ${data.errmsg ?? "unknown error"}`);
  }

  // UDF history is columnar (parallel arrays); zip into bar objects so the
  // result is self-describing for an LLM client.
  const t = data.t ?? [];
  const candles = t.map((ts, i) => ({
    time: ts,
    iso: new Date(ts * 1000).toISOString(),
    open: data.o?.[i] ?? null,
    high: data.h?.[i] ?? null,
    low: data.l?.[i] ?? null,
    close: data.c?.[i] ?? null,
    volume: data.v?.[i] ?? null,
  }));

  return {
    symbol: args.symbol,
    resolution: args.resolution,
    from,
    to,
    status: "ok",
    count: candles.length,
    candles,
  };
}
