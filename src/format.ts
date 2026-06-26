// Number → on-chain string formatting helpers.
//
// JS `Number.toString()` emits scientific notation for small/large magnitudes
// (e.g. `(0.0000001).toString()` === "1e-7"). That notation is rejected both by
// the CosmWasm `Decimal` parser inside the perp contract and by
// `ethers.parseUnits`, so every price / amount that crosses the wire must be
// formatted as a plain decimal string instead of via bare `.toString()`.

/**
 * Format a finite JS number as a plain decimal string with no exponential
 * notation. Used for oracle prices, TP/SL targets, leverage, and slippage that
 * are embedded in the wasm message.
 */
export function toPlainDecimalString(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`Expected a finite number, got ${n}`);
  }
  const s = n.toString();
  if (!/e/i.test(s)) return s;
  if (Math.abs(n) >= 1) {
    // Large-magnitude exponential (|n| >= 1e21). Not a realistic price or
    // amount on Sai — refuse rather than emit a lossy/invalid string.
    throw new Error(
      `Number ${n} is too large to format as a plain decimal without precision loss`,
    );
  }
  // Small-magnitude exponential (e.g. 1e-7). Expand to a fixed-point string and
  // trim the trailing zeros toFixed pads with. 20 fractional digits covers
  // every price magnitude Sai lists.
  return n.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Format a human token amount as a plain decimal string, rejecting values with
 * more fractional digits than the token supports on chain. Replaces the prior
 * `indexOf(".")` check, which exponential notation (no ".") silently bypassed.
 */
export function toTokenAmountString(n: number, decimals: number): string {
  const s = toPlainDecimalString(n);
  const dot = s.indexOf(".");
  if (dot !== -1 && s.length - dot - 1 > decimals) {
    throw new Error(
      `amount ${n} has more than ${decimals} fractional digits; this token only supports ${decimals} decimals on chain`,
    );
  }
  return s;
}

// ----- read-side unit helpers -------------------------------------------------
//
// The keeper returns collateral-denominated amounts (pnl, fees, position value)
// as integers in micro-units (6 decimals for USDC and stNIBI), and percentages
// as RAW RATIOS (-0.011 means -1.1%), under fields whose names give no hint of
// either convention (e.g. `pnlCollateral`, `pnlPct`). Surfacing both verbatim in
// the same object invites 6-orders-of-magnitude misreads, so the read tools use
// these to build an explicit, human-labelled projection alongside the raw fields.

/** Micro-units integer -> human token units (e.g. 99415 -> 0.099415 at 6 decimals). */
export function microsToUnits(micro: number | string | null | undefined, decimals = 6): number | null {
  if (micro === null || micro === undefined) return null;
  const n = Number(micro);
  if (!Number.isFinite(n)) return null;
  return n / 10 ** decimals;
}

/** Raw ratio -> a human percent string (e.g. -0.011013 -> "-1.1013%"). */
export function ratioToPctString(r: number | string | null | undefined): string | null {
  if (r === null || r === undefined) return null;
  const n = Number(r);
  if (!Number.isFinite(n)) return null;
  // Up to 4 decimal places, trailing zeros trimmed.
  const pct = (n * 100).toFixed(4).replace(/\.?0+$/, "");
  return `${pct === "" || pct === "-0" ? "0" : pct}%`;
}

/**
 * Compact human age of a timestamp relative to now (e.g. "5s", "3m", "2h",
 * "166d"). Returns null for an unparseable input. Used to make a stale oracle
 * price or a lagging indexed value obvious at a glance.
 */
export function humanAge(fromMs: number, nowMs: number = Date.now()): string | null {
  if (!Number.isFinite(fromMs)) return null;
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}
