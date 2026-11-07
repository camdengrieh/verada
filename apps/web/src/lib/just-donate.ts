/**
 * "Just donate": pick an amount, optionally where in the world and which causes, and the gift goes
 * to the curator agents' vaults. What is trending comes from each agent's newest weekly report: an
 * agent weighs every region it covers by urgency (0-10000) from the news it read, and ranks the
 * charities it will give to there. A cause trends in the picked regions by its highest weight among
 * them. Everything here is pure; the page fetches the agents and reports and renders the result.
 */
import { CATEGORIES, REGIONS } from "@varada/sdk";
import type { AgentPick, AgentReport, AgentSummary } from "./agents";
import { pickKnownSlugs } from "./causes-client";

/** At most this many causes share one gift (each is an approve and a donate in the wallet). */
export const MAX_SPLIT = 3;

export const AMOUNT_PRESETS = [10, 25, 50, 100] as const;

export interface CauseTrend {
  agent: AgentSummary;
  /** Category slug. */
  slug: string;
  /** Highest urgency weight (0-10000) among the picked regions; 0 without a report. */
  weight: number;
  /** Region slug of that weight, or null without a report. */
  hottest: string | null;
  /** The report summary for the hottest region (untrusted text: render as text). */
  summary: string;
  /** Report epoch the weight comes from. */
  epoch: string | null;
}

export interface TrendingPick extends AgentPick {
  /** The agent that ranked it, and the region it was ranked in. */
  agentLabel: string;
  causeSlug: string;
  region: string;
  /** The region's urgency weight times the pick's score: how strongly it is pushed this week. */
  heat: number;
}

/** Regions a report is read for: the picked ones, or every region when none is picked. */
export function regionsInScope(picked: readonly string[]): string[] {
  return picked.length > 0 ? [...picked] : REGIONS.map((r) => r.slug);
}

const donatedOf = (a: AgentSummary) => (a.totals && /^\d+$/.test(a.totals.donated) ? BigInt(a.totals.donated) : 0n);

/**
 * Active agents with a vault, hottest first for the picked regions. Ties (and agents without a
 * report yet) fall back to what the vault has received, then to category order, so the list is
 * stable. `reports` is keyed by agent label; a missing or null report weighs 0.
 */
export function rankTrending(agents: readonly AgentSummary[], reports: ReadonlyMap<string, AgentReport | null>, picked: readonly string[]): CauseTrend[] {
  const scope = new Set(regionsInScope(picked));
  const order = (slug: string) => CATEGORIES.findIndex((c) => c.slug === slug);
  return agents
    .filter((a): a is AgentSummary & { category: string } => a.active && a.category !== null && /^0x[0-9a-fA-F]{40}$/.test(a.vault))
    .map((agent): CauseTrend => {
      const report = reports.get(agent.label) ?? null;
      let best: { weight: number; region: string; summary: string } | null = null;
      for (const r of report?.regions ?? []) {
        if (!scope.has(r.region)) continue;
        if (!best || r.weight > best.weight) best = { weight: r.weight, region: r.region, summary: r.summary };
      }
      return { agent, slug: agent.category, weight: best?.weight ?? 0, hottest: best?.region ?? null, summary: best?.summary ?? "", epoch: report?.epoch ?? null };
    })
    .sort((a, b) => b.weight - a.weight || (donatedOf(b.agent) > donatedOf(a.agent) ? 1 : donatedOf(b.agent) < donatedOf(a.agent) ? -1 : 0) || order(a.slug) - order(b.slug));
}

/**
 * The charities the agents push hardest in the picked regions: every pick of the given causes'
 * reports in scope, by heat, one entry per charity (its hottest), at most `limit`.
 */
export function trendingPicks(
  trends: readonly CauseTrend[],
  reports: ReadonlyMap<string, AgentReport | null>,
  picked: readonly string[],
  limit = 6,
): TrendingPick[] {
  const scope = new Set(regionsInScope(picked));
  const best = new Map<string, TrendingPick>();
  for (const t of trends) {
    for (const r of reports.get(t.agent.label)?.regions ?? []) {
      if (!scope.has(r.region)) continue;
      for (const p of r.picks) {
        const heat = Math.round((r.weight * Math.max(0, Math.min(100, p.score))) / 100);
        const key = p.orgId.toLowerCase();
        const prev = best.get(key);
        if (!prev || heat > prev.heat) best.set(key, { ...p, agentLabel: t.agent.label, causeSlug: t.slug, region: r.region, heat });
      }
    }
  }
  return [...best.values()].sort((a, b) => b.heat - a.heat || a.name.localeCompare(b.name)).slice(0, limit);
}

/**
 * The causes a gift goes to: the visitor's choice when they made one (in their order, at most
 * `MAX_SPLIT`, only causes that can take donations), else the single hottest cause.
 */
export function chosenCauses(trends: readonly CauseTrend[], chosen: readonly string[]): CauseTrend[] {
  if (chosen.length === 0) return trends.slice(0, 1);
  const out: CauseTrend[] = [];
  for (const slug of chosen) {
    const t = trends.find((x) => x.slug === slug);
    if (t && !out.includes(t)) out.push(t);
    if (out.length === MAX_SPLIT) break;
  }
  return out;
}

/** `total` split into `n` parts that add up exactly; the first parts take the remainder. */
export function splitAmount(total: bigint, n: number): bigint[] {
  if (n <= 0 || total <= 0n) return [];
  const each = total / BigInt(n);
  const rest = Number(total % BigInt(n));
  return Array.from({ length: n }, (_, i) => each + (i < rest ? 1n : 0n));
}

export interface DonateQuery {
  regions: string[];
  causes: string[];
  amount: string;
}

/** Reads `?region=&cause=&amount=`; unknown slugs are dropped and the amount kept only if numeric. */
export function parseDonateQuery(search: string): DonateQuery {
  const p = new URLSearchParams(search);
  const amount = (p.get("amount") ?? "").trim();
  return {
    regions: pickKnownSlugs(p.get("region"), REGIONS).filter((r) => r !== "global"),
    causes: pickKnownSlugs(p.get("cause"), CATEGORIES).slice(0, MAX_SPLIT),
    amount: /^\d{1,9}(\.\d{1,6})?$/.test(amount) ? amount : "",
  };
}

/** The query string (with `?`, or empty) for a donate state. */
export function donateQueryString(s: DonateQuery): string {
  const p = new URLSearchParams();
  if (s.amount.trim()) p.set("amount", s.amount.trim());
  if (s.regions.length) p.set("region", s.regions.join(","));
  if (s.causes.length) p.set("cause", s.causes.join(","));
  const out = p.toString();
  return out ? `?${out}` : "";
}

/** "Africa", "Africa and Asia", "Africa, Asia and Europe", or "everywhere". */
export function placeList(regions: readonly string[]): string {
  const names = regions.map((s) => REGIONS.find((r) => r.slug === s)?.label ?? s);
  if (names.length === 0) return "everywhere";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Urgency weight 0-10000 as a word, for the trend badge. */
export function heatWord(weight: number): "Urgent" | "Rising" | "Steady" | "Quiet" {
  if (weight >= 7000) return "Urgent";
  if (weight >= 4000) return "Rising";
  if (weight > 0) return "Steady";
  return "Quiet";
}
