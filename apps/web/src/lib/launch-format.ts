import { formatEther } from "viem";

/** A quote-asset amount for people: 1,250 / 12.5 / 0.0125; very small values as 1.00e-10. */
export function formatQuoteAmount(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e15 || abs < 1e-4) return n.toExponential(2).replace("e+", "e");
  if (abs >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (abs >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toPrecision(3).replace(/\.?0+$/, "");
}

/** "0.0123 ETH" for a wei amount, with at most 4 significant decimals. */
export function formatEth(wei: bigint): string {
  const n = Number(formatEther(wei));
  if (n === 0) return "0 ETH";
  if (n < 0.0001) return "< 0.0001 ETH";
  return `${n.toPrecision(3).replace(/\.?0+$/, "")} ETH`;
}

/** "12.3 gwei" for a wei gas price. */
export function formatGwei(wei: bigint): string {
  const n = Number(wei) / 1e9;
  return `${n >= 10 ? n.toFixed(1) : n.toFixed(2)} gwei`;
}

/** "5m", "1h", "24h" for a number of seconds. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/** "1.2K", "34K", "1.5M" for counts. */
export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
