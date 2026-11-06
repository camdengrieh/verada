import { usdcScaled } from "./donation-asset";
import { CATEGORIES, REGIONS } from "@varada/sdk";
import { isCauseName, type CauseName } from "@varada/ui/components/varada/cause-icon";
import { IndexerError, type IndexerClient } from "./indexer";

/**
 * The UI's cause icons are keyed by the curator agent's ENS label (`hunger`, `homeless`), the SDK's
 * categories by slug (`hunger`, `homelessness`). Unknown slugs and the catch-all map to `other`.
 */
export function causeNameOfSlug(slug: string): CauseName {
  const label = CATEGORIES.find((c) => c.slug === slug)?.ensLabel;
  return label && isCauseName(label) ? label : "other";
}

/** The curator agent's ENS label for a category slug (the catch-all has none). */
export function agentLabelOfSlug(slug: string): string | undefined {
  return CATEGORIES.find((c) => c.slug === slug)?.ensLabel;
}

/** Slugs from a comma-separated list that exist in `known`, without repeats. */
export function pickKnownSlugs(csv: string | null | undefined, known: readonly { slug: string }[]): string[] {
  const out: string[] = [];
  for (const s of (csv ?? "").split(",")) {
    const slug = s.trim().toLowerCase();
    if (slug && known.some((k) => k.slug === slug) && !out.includes(slug)) out.push(slug);
  }
  return out;
}

export interface CausesQueryState {
  q: string;
  categories: string[];
  regions: string[];
}

/** Reads `?category=&region=&q=` (comma-separated slugs); unknown slugs are dropped. */
export function parseCausesQuery(search: string): CausesQueryState {
  const p = new URLSearchParams(search);
  return {
    q: (p.get("q") ?? "").slice(0, 100),
    categories: pickKnownSlugs(p.get("category"), CATEGORIES),
    regions: pickKnownSlugs(p.get("region"), REGIONS),
  };
}

/** The query string (with the leading `?`, or empty) for a filter state. */
export function causesQueryString(s: CausesQueryState): string {
  const p = new URLSearchParams();
  if (s.q.trim()) p.set("q", s.q.trim());
  if (s.categories.length) p.set("category", s.categories.join(","));
  if (s.regions.length) p.set("region", s.regions.join(","));
  const out = p.toString();
  return out ? `?${out}` : "";
}

export interface LeaderboardOrg {
  orgId: string;
  name: string;
  ein: string | null;
  country: string | null;
  categories: string[];
  regions: string[];
}

export interface LeaderboardRow {
  rank: number;
  causeId: string;
  /** USDC base units (6 decimals) from coins that donate in USDC. */
  donated: bigint;
  /** Wei from coins that donate in ETH. */
  donatedEth: bigint;
  donations: number;
  /** Coins that gave to this cause. */
  tokens: number;
  /** Null while the indexer has no catalogue loaded or the cause is not in it. */
  org: LeaderboardOrg | null;
}

export interface CategoryTotal {
  slug: string;
  donated: bigint;
  donatedEth: bigint;
  donations: number;
  causes: number;
}

export interface CauseLeaderboardPage {
  totals: { causes: number; donations: number; donated: bigint; donatedEth: bigint };
  items: LeaderboardRow[];
  byCategory: CategoryTotal[];
  nextCursor: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : null);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0);
const big = (v: unknown): bigint => {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
  return 0n;
};

function toRow(v: unknown): LeaderboardRow | null {
  if (!isRecord(v) || typeof v.causeId !== "string") return null;
  const o = v.org;
  return {
    rank: int(v.rank),
    causeId: v.causeId,
    donated: big(v.donated),
    donatedEth: big(v.donatedEth),
    donations: int(v.donations),
    tokens: int(v.tokens),
    org:
      isRecord(o) && typeof o.name === "string"
        ? { orgId: str(o.orgId) ?? "", name: o.name, ein: str(o.ein), country: str(o.country), categories: strs(o.categories), regions: strs(o.regions) }
        : null,
  };
}

export function toLeaderboardPage(v: unknown): CauseLeaderboardPage | null {
  if (!isRecord(v) || !Array.isArray(v.items)) return null;
  const t = isRecord(v.totals) ? v.totals : {};
  const cursor = v.nextCursor;
  return {
    totals: { causes: int(t.causes), donations: int(t.donations), donated: big(t.donated), donatedEth: big(t.donatedEth) },
    items: v.items.map(toRow).filter((r): r is LeaderboardRow => r !== null),
    byCategory: (Array.isArray(v.byCategory) ? v.byCategory : []).flatMap((c): CategoryTotal[] =>
      isRecord(c) && typeof c.slug === "string" ? [{ slug: c.slug, donated: big(c.donated), donatedEth: big(c.donatedEth), donations: int(c.donations), causes: int(c.causes) }] : [],
    ),
    nextCursor: typeof cursor === "string" && cursor !== "" ? cursor : null,
  };
}

/** Money given per cause, largest first; null when the indexer has no such route (older build or 503). */
export async function fetchCauseLeaderboard(client: Pick<IndexerClient, "get">, opts: { cursor?: string; limit?: number } = {}): Promise<CauseLeaderboardPage | null> {
  try {
    return toLeaderboardPage(await client.get("/api/causes/leaderboard", opts));
  } catch (e) {
    if (e instanceof IndexerError && (e.status === 503 || e.status === 404)) return null;
    throw e;
  }
}

/**
 * Folds the ETH-donation column into the USDC one at `ethUsd` (USD per ETH), so every figure
 * downstream is one number of USDC base units; re-ranks rows by the live price. With no price the
 * ETH part counts as zero.
 */
export function leaderboardInUsd(page: CauseLeaderboardPage, ethUsd: number | null | undefined): CauseLeaderboardPage {
  const fold = <T extends { donated: bigint; donatedEth: bigint }>(x: T): T => ({ ...x, donated: x.donated + usdcScaled(x.donatedEth, "eth", ethUsd), donatedEth: 0n });
  const items = page.items.map(fold).sort((a, b) => (a.donated === b.donated ? a.rank - b.rank : a.donated > b.donated ? -1 : 1));
  return { ...page, totals: fold(page.totals), items, byCategory: page.byCategory.map(fold).sort((a, b) => (a.donated === b.donated ? 0 : a.donated > b.donated ? -1 : 1)) };
}

/** USDC base units as a number of dollars (display only; amounts stay bigint elsewhere). */
export const usdcToNumber = (base: bigint): number => Number(base) / 1e6;
