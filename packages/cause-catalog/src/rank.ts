import type { HarvestedOrg } from "./harvest.js";

/**
 * A 0-1000 popularity / readiness score from the Endaoment search listing. It orders browsing and
 * search results; it is not used on-chain. Missing fields (older harvests) count as zero.
 *
 *   contributions  450 * min(1, log10(1 + usd) / 7)        $10M lifetime saturates
 *   donations      150 * min(1, log10(1 + donations) / 4)  10,000 donations saturate
 *   grants         100 * min(1, log10(1 + grants) / 3)     1,000 grants saturate
 *   claimed        200 when the org claimed its Endaoment profile (can receive and withdraw)
 *   featured        50 when featuredIndex > 0
 *   website         25 when a website is listed
 *   description     25 when a description is listed
 */
export const RANK_WEIGHTS = {
  contributions: 450,
  donations: 150,
  grants: 100,
  claimed: 200,
  featured: 50,
  website: 25,
  description: 25,
} as const;

export const MAX_RANK = Object.values(RANK_WEIGHTS).reduce((a, b) => a + b, 0);

export interface RankSignals {
  /** Lifetime contributions in USD (`lifetimeContributionsUsdc` is in 6-decimal base units). */
  contributionsUsd: number;
  donations: number;
  grants: number;
  claimed: boolean;
  featured: boolean;
  website: boolean;
  description: boolean;
}

type RankInput = Pick<HarvestedOrg, "claimed" | "donationsReceived" | "description"> &
  Partial<Pick<HarvestedOrg, "lifetimeContributionsUsdc" | "grantsReceived" | "featuredIndex" | "website">>;

const num = (x: unknown): number => {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const logScore = (x: number, saturateLog10: number) => Math.min(1, Math.log10(1 + x) / saturateLog10);

export function rankSignals(o: RankInput): RankSignals {
  return {
    contributionsUsd: num(o.lifetimeContributionsUsdc) / 1e6,
    donations: num(o.donationsReceived),
    grants: num(o.grantsReceived),
    claimed: o.claimed === true,
    featured: num(o.featuredIndex) > 0,
    website: Boolean(o.website?.trim()),
    description: Boolean(o.description?.trim()),
  };
}

export function rankScore(s: RankSignals): number {
  const w = RANK_WEIGHTS;
  const score =
    w.contributions * logScore(s.contributionsUsd, 7) +
    w.donations * logScore(s.donations, 4) +
    w.grants * logScore(s.grants, 3) +
    (s.claimed ? w.claimed : 0) +
    (s.featured ? w.featured : 0) +
    (s.website ? w.website : 0) +
    (s.description ? w.description : 0);
  return Math.max(0, Math.min(MAX_RANK, Math.round(score)));
}

export function rankOrg(o: RankInput): { rank: number; rankSignals: RankSignals } {
  const signals = rankSignals(o);
  return { rank: rankScore(signals), rankSignals: signals };
}
