import type { Hex } from "viem";
import type { CatalogOrgResult } from "./catalog";

/** Money given to one cause (catalogue org), summed over weekly and live-donation gifts. USDC base units. */
export interface CauseTotalRow {
  causeId: Hex;
  donated: bigint;
  donations: number;
  /** Distinct tokens that gave to the cause. */
  tokens: number;
}

/** Read access for `GET /api/causes/leaderboard` (implemented over Ponder's db and by test fakes). */
export interface CauseTotalsRepo {
  /** One row per cause that received at least one donation, in no particular order. */
  totals(): Promise<CauseTotalRow[]>;
}

/**
 * Merges the weekly (`donation`) and live (`live_donation`) sources. A token is weekly or live,
 * never both, so summing the distinct-token counts per cause is exact.
 */
export function mergeCauseTotals(...sources: CauseTotalRow[][]): CauseTotalRow[] {
  const by = new Map<string, CauseTotalRow>();
  for (const rows of sources) {
    for (const r of rows) {
      const key = r.causeId.toLowerCase();
      const cur = by.get(key);
      if (cur) {
        cur.donated += r.donated;
        cur.donations += r.donations;
        cur.tokens += r.tokens;
      } else by.set(key, { ...r, causeId: key as Hex });
    }
  }
  return [...by.values()];
}

/** Largest donated amount first; ties by cause id so pages are stable. */
export function rankCauseTotals(rows: CauseTotalRow[]): CauseTotalRow[] {
  return [...rows].sort((a, b) => (a.donated !== b.donated ? (a.donated > b.donated ? -1 : 1) : a.causeId < b.causeId ? -1 : 1));
}

export interface CategoryTotal {
  slug: string;
  donated: bigint;
  donations: number;
  causes: number;
}

/** Donations per category slug through the catalogue orgs; an org in several categories counts in each. */
export function totalsByCategory(rows: CauseTotalRow[], orgOf: (causeId: Hex) => CatalogOrgResult | undefined): CategoryTotal[] {
  const by = new Map<string, CategoryTotal>();
  for (const r of rows) {
    for (const slug of orgOf(r.causeId)?.categories ?? []) {
      const cur = by.get(slug) ?? { slug, donated: 0n, donations: 0, causes: 0 };
      cur.donated += r.donated;
      cur.donations += r.donations;
      cur.causes += 1;
      by.set(slug, cur);
    }
  }
  return [...by.values()].sort((a, b) => (a.donated !== b.donated ? (a.donated > b.donated ? -1 : 1) : a.slug < b.slug ? -1 : 1));
}
