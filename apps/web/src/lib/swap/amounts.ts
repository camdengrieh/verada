import { formatUnits, parseUnits } from "viem";

/** "1.5" -> 1500000000000000000n; null for empty, malformed or zero input. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const t = text.trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [whole = "0", frac = ""] = t.split(".");
  // extra precision cannot be sent: truncate instead of rejecting a paste
  const v = parseUnits(`${whole || "0"}.${frac.slice(0, decimals)}`, decimals);
  return v > 0n ? v : null;
}

const trim = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

/** Plain decimal text of a raw amount, trimmed of trailing zeros, at most `maxFraction` digits (rounded down). */
export function formatRaw(raw: bigint, decimals: number, maxFraction = 8): string {
  const s = formatUnits(raw, decimals);
  const [w = "0", f = ""] = s.split(".");
  return trim(f ? `${w}.${f.slice(0, maxFraction)}` : w);
}

/** Display text with thousands separators and a sensible number of digits for the magnitude. */
export function formatDisplay(raw: bigint, decimals: number): string {
  const n = Number(formatUnits(raw, decimals));
  if (!Number.isFinite(n)) return "0";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.0001 ? 6 : 8;
  if (abs < 10 ** -digits) return `<${(10 ** -digits).toFixed(digits)}`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(n);
}

export const formatUsd = (n: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n >= 100 ? 0 : 2 }).format(n);

export const formatPercent = (pct: number): string => `${pct >= 10 ? pct.toFixed(1) : pct.toFixed(2)}%`;

/** Slippage tolerance in percent (UI) to basis points (engine). */
export const slippageToBps = (pct: number): number => Math.max(0, Math.min(9999, Math.round(pct * 100)));
