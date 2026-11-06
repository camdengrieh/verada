import type { Stats } from "./indexer";

/** What the hero shows, read from `/api/stats` (USDC base units, 6 decimals; bigints arrive as strings). */
export interface PlatformTotals {
  /** Dollars raised for causes: weekly pools credited plus live-donation cause share. */
  raisedUsd: number;
  tokens: number;
  donations: number;
  causes: number;
}

function big(v: unknown): bigint {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
  return 0n;
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0);

/** Null when the response is missing or is not a stats object. */
export function platformTotals(stats: Stats | undefined | null): PlatformTotals | null {
  if (!stats || typeof stats !== "object" || !("tokens" in stats)) return null;
  const raised = big(stats.causeFees) + big(stats.liveCauseShare);
  return {
    raisedUsd: Number(raised / 10_000n) / 100,
    tokens: count(stats.tokens),
    donations: count(stats.donations) + count(stats.liveDonations),
    causes: count(stats.causes),
  };
}
