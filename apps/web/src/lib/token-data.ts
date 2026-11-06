/**
 * Token-page data that is not in `./indexer`: the live-donation view, donation history and the
 * mapping from catalogue categories to the library's cause names. Same conventions as the indexer
 * client: bigints arrive as decimal strings, rows that do not parse are dropped.
 */
import { CATEGORIES } from "@varada/sdk";
import type { CauseName } from "@varada/ui/components/varada/cause-icon";
import { isCauseName } from "@varada/ui/components/varada/cause-icon";
import type { Donation } from "@varada/ui/components/varada/donation-timeline";
import type { ImpactItem } from "@varada/ui/components/varada/impact-breakdown";
import type { LeaderboardEntry } from "@varada/ui/components/varada/cause-leaderboard";
import type { LiveCadence } from "@varada/ui/components/varada/mode-badge";
import { IndexerError, type CatalogOrg, type EpochDetail, type IndexerClient, type TokenFocus } from "./indexer";

export const USDC_DECIMALS = 6;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bigint = (v: unknown): bigint => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : 0n);
const seconds = (v: unknown): number | null => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : typeof v === "number" ? v : null);
const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** USDC base units to dollars. */
export function usdcToUsd(amount: bigint): number {
  return Number(amount / 10n ** BigInt(USDC_DECIMALS)) + Number(amount % 10n ** BigInt(USDC_DECIMALS)) / 10 ** USDC_DECIMALS;
}

/* ---------- cause names ---------- */

/** The library's cause name for a catalogue category slug (`disaster-relief` is `disaster`); `other` when unknown. */
export function causeNameOfSlug(slug: string | null | undefined): CauseName {
  const label = CATEGORIES.find((c) => c.slug === slug)?.ensLabel;
  return label && isCauseName(label) ? label : "other";
}

/** The cause an org belongs to (its first catalogue category). */
export function causeNameOfOrg(org: Pick<CatalogOrg, "categories"> | undefined): CauseName {
  return causeNameOfSlug(org?.categories[0]);
}

/** The cause names of a token's focus; empty when the focus is open to every category. */
export function focusCauseNames(focus: TokenFocus | null): CauseName[] {
  if (!focus || focus.categories.length === 0 || focus.categories.length >= CATEGORIES.length) return [];
  return [...new Set(focus.categories.map(causeNameOfSlug))];
}

/* ---------- live-donation tokens ---------- */

const CADENCE: Record<string, LiveCadence> = { OneHour: "1h", TwelveHours: "12h", OneDay: "24h", ThreeDays: "72h", OneWeek: "week" };

export interface LiveCauseTotal {
  causeId: string;
  gross: bigint;
  platform: bigint;
  credited: bigint;
  donated: bigint;
  pending: bigint;
  donations: number;
}

export interface LiveDonationRow {
  id: string;
  causeId: string;
  amount: bigint;
  timestamp: number;
  txHash: string;
}

/** `GET /api/live/:token`: a live-donation token's rotation, designated cause and per-cause totals (USDC). */
export interface LiveView {
  token: string;
  cadence: LiveCadence | null;
  /** USDC credited before a donation is sent. */
  threshold: bigint | null;
  quote: string | null;
  rotation: { startedAt: number; nextRotationAt: number } | null;
  designatedCause: string | null;
  nextCause: { causeId: string; startsAt: number } | null;
  totals: { gross: bigint; platform: bigint; credited: bigint; donated: bigint; pending: bigint };
  causes: LiveCauseTotal[];
  recentDonations: LiveDonationRow[];
}

export function toLive(v: unknown): LiveView | null {
  if (!isRecord(v) || typeof v.token !== "string") return null;
  const rot = isRecord(v.rotation) ? v.rotation : null;
  const des = isRecord(v.designatedCause) ? text(v.designatedCause.causeId) : null;
  const next = isRecord(v.nextCause) ? v.nextCause : null;
  const totals = isRecord(v.totals) ? v.totals : {};
  const period = text(rot?.period) ?? text(v.initialPeriod);
  const list = (x: unknown) => (Array.isArray(x) ? x.filter(isRecord) : []);
  return {
    token: v.token,
    cadence: period ? (CADENCE[period] ?? null) : null,
    threshold: v.threshold === null || v.threshold === undefined ? null : bigint(v.threshold),
    quote: text(v.quote),
    rotation: rot ? { startedAt: seconds(rot.startedAt) ?? 0, nextRotationAt: seconds(rot.nextRotationAt) ?? 0 } : null,
    designatedCause: des ?? text(v.initialCause),
    nextCause: next && text(next.causeId) ? { causeId: text(next.causeId)!, startsAt: seconds(next.startsAt) ?? 0 } : null,
    totals: { gross: bigint(totals.gross), platform: bigint(totals.platform), credited: bigint(totals.credited), donated: bigint(totals.donated), pending: bigint(totals.pending) },
    causes: list(v.causes).flatMap((c) => {
      const causeId = text(c.causeId);
      return causeId ? [{ causeId, gross: bigint(c.gross), platform: bigint(c.platform), credited: bigint(c.credited), donated: bigint(c.donated), pending: bigint(c.pending), donations: Number(c.donations) || 0 }] : [];
    }),
    recentDonations: list(v.recentDonations).flatMap((d) => {
      const causeId = text(d.causeId);
      const ts = seconds(d.timestamp);
      const txHash = text(d.txHash);
      return causeId && ts !== null && txHash ? [{ id: String(d.id ?? txHash), causeId, amount: bigint(d.amount), timestamp: ts, txHash }] : [];
    }),
  };
}

/** The live view, or null when the token is not a live-donation token (404) or the indexer has no live data (503). */
export async function loadLive(indexer: IndexerClient, token: string): Promise<LiveView | null> {
  try {
    return toLive(await indexer.get(`/api/live/${token}`));
  } catch (e) {
    if (e instanceof IndexerError && (e.status === 404 || e.status === 503)) return null;
    throw e;
  }
}

/* ---------- weekly pool ---------- */

export interface PoolFigures {
  /** Everything credited to this epoch's pool (USDC base units). */
  total: bigint;
  /** Earned in this epoch itself. */
  earned: bigint;
  /** Credited from earlier epochs that had no vote to settle them. */
  carriedIn: bigint;
  settled: bigint | null;
}

/** Pool figures of an epoch detail (the indexer's `causePool`); null when it reports none. */
export function poolFigures(detail: (Pick<EpochDetail, "epoch"> & Record<string, unknown>) | null): PoolFigures | null {
  const pool = detail && isRecord(detail.causePool) ? detail.causePool : null;
  if (!pool || !detail) return null;
  const accruals = Array.isArray(pool.accruals) ? pool.accruals.filter(isRecord) : [];
  let earned = 0n;
  let carriedIn = 0n;
  for (const a of accruals) {
    if (String(a.accrualEpoch) === detail.epoch) earned += bigint(a.causeAmount);
    else carriedIn += bigint(a.causeAmount);
  }
  return { total: bigint(pool.attributed), earned, carriedIn, settled: pool.settledAmount === null || pool.settledAmount === undefined ? null : bigint(pool.settledAmount) };
}

/* ---------- donations and impact ---------- */

export interface DonationRow {
  id: string;
  causeId: string;
  amount: bigint;
  timestamp: number;
  txHash: string | null;
  via: "pool" | "live";
}

/** Activity-stream `donation` rows of a token (weekly pool payouts). */
export async function loadPoolDonations(indexer: IndexerClient, token: string, limit = 50): Promise<DonationRow[]> {
  const page = await indexer.activity({ token, kind: "donation", limit });
  return page.items.flatMap((i) => {
    const causeId = text(i.data.causeId);
    if (!causeId || i.timestamp === undefined) return [];
    return [{ id: i.id, causeId, amount: bigint(i.data.amount), timestamp: i.timestamp, txHash: i.txHash ?? null, via: "pool" as const }];
  });
}

export function liveDonationRows(live: LiveView | null): DonationRow[] {
  return (live?.recentDonations ?? []).map((d) => ({ id: d.id, causeId: d.causeId, amount: d.amount, timestamp: d.timestamp, txHash: d.txHash, via: "live" as const }));
}

export interface CauseMeta {
  name: string;
  cause: CauseName;
}

export interface Impact {
  totalDonated: number;
  items: ImpactItem[];
  leaderboard: LeaderboardEntry[];
  timeline: Donation[];
}

/**
 * Donations grouped by cause category and by charity, and the newest as a timeline. `meta` names a
 * charity and its category by lowercase cause id; unknown ids fall back to the shortened id.
 */
export function buildImpact(
  rows: readonly DonationRow[],
  meta: (causeId: string) => CauseMeta,
  symbol: string,
  txUrl: (hash: string) => string,
  /** Per-cause totals that replace the sums over `rows` (a live token's credited amounts, which cover more than the recent donations). */
  totals?: readonly { causeId: string; amount: bigint }[],
): Impact {
  const byCategory = new Map<CauseName, { amount: number; charities: Set<string> }>();
  const byOrg = new Map<string, { name: string; cause: CauseName; amount: number }>();
  let total = 0;
  for (const r of totals ?? rows) {
    const usd = usdcToUsd(r.amount);
    total += usd;
    const m = meta(r.causeId.toLowerCase());
    const c = byCategory.get(m.cause) ?? { amount: 0, charities: new Set<string>() };
    c.amount += usd;
    c.charities.add(r.causeId.toLowerCase());
    byCategory.set(m.cause, c);
    const o = byOrg.get(r.causeId.toLowerCase()) ?? { name: m.name, cause: m.cause, amount: 0 };
    o.amount += usd;
    byOrg.set(r.causeId.toLowerCase(), o);
  }
  const sorted = [...rows].sort((a, b) => b.timestamp - a.timestamp);
  return {
    totalDonated: total,
    items: [...byCategory].map(([cause, v]) => ({ cause, amount: v.amount, charities: v.charities.size })),
    leaderboard: [...byOrg]
      .sort((a, b) => b[1].amount - a[1].amount)
      .map(([id, v]) => ({ id, name: v.name, cause: v.cause, raised: v.amount, moved: 0 })),
    timeline: sorted.map((r) => {
      const m = meta(r.causeId.toLowerCase());
      return { id: r.id, org: m.name, amount: usdcToUsd(r.amount), cause: m.cause, at: r.timestamp * 1000, coin: `$${symbol}`, via: r.via, txHref: r.txHash ? txUrl(r.txHash) : undefined };
    }),
  };
}

/** Shortened id for a charity the indexer has no name for. */
export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}
