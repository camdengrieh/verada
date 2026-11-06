/** Number and time formatting shared by the discover views. Locale-independent (en-US) so output is stable. */

const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const SUB = "₀₁₂₃₄₅₆₇₈₉";

function trim(n: number, decimals: number): string {
  return Number(n.toFixed(decimals)).toLocaleString("en-US", { maximumFractionDigits: decimals });
}

/** "1.2K", "3.4M", "950". */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs < 1000) return trim(n, abs >= 100 ? 0 : abs >= 10 ? 1 : 2);
  return compactFmt.format(n);
}

/** A base-unit amount as a plain float (display only). */
export function unitsToNumber(raw: bigint, decimals: number): number {
  const base = 10n ** BigInt(Math.max(0, decimals));
  const whole = raw / base;
  const frac = raw % base;
  return Number(whole) + Number(frac) / Number(base);
}

/** USDC base units (6 decimals) as dollars: "$0", "$0.45", "$12.4", "$1.2K". */
export function formatUsdc(raw: bigint): string {
  const n = unitsToNumber(raw, 6);
  if (n === 0) return "$0";
  if (n < 1) return `$${n.toFixed(2)}`;
  if (n < 1000) return `$${trim(n, 2)}`;
  return `$${compactFmt.format(n)}`;
}

/** USD as a float, same style as {@link formatUsdc}. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 1000) return `$${trim(n, n < 1 ? 4 : 2)}`;
  return `$${compactFmt.format(n)}`;
}

/** Tiny prices with a subscript for the run of zeros: 0.00000412 becomes "0.0₅412". */
export function formatSmallNumber(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1) return trim(n, abs >= 1000 ? 0 : 4);
  if (abs >= 0.001) return trim(n, 5);
  const m = /^0\.(0+)(\d{1,3})/.exec(abs.toFixed(20));
  if (!m) return abs.toExponential(2);
  const sub = String(m[1]!.length)
    .split("")
    .map((d) => SUB[Number(d)])
    .join("");
  return `${n < 0 ? "-" : ""}0.0${sub}${m[2]}`;
}

/** An amount of a quote asset: "12.4K WETH", "0.0₅412 WETH". */
export function formatQuote(n: number, symbol: string): string {
  return `${n >= 1 ? compact(n) : formatSmallNumber(n)} ${symbol}`;
}

/** "just now", "4 min ago", "3 h ago", "2 d ago". */
export function timeAgo(seconds: number | undefined, nowSeconds: number): string {
  if (seconds === undefined) return "";
  const d = Math.max(0, nowSeconds - seconds);
  if (d < 45) return "just now";
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} min ago`;
  if (d < 86_400) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86_400)} d ago`;
}
