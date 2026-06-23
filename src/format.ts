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
