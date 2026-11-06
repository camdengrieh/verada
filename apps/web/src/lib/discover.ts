import { CATEGORIES, REGIONS } from "@varada/sdk";
import { isCauseName, type CauseName } from "@varada/ui/components/varada/cause-icon";
import type { GivingMode, LiveCadence } from "@varada/ui/components/varada/mode-badge";
import type { ImageSource, WashTone } from "@varada/ui/components/varada/shared";
import type { QuoteKind } from "@varada/ui/components/varada/stock-logo";
import type { TokenSummary as CardToken } from "@varada/ui/components/varada/token-card";
import type { DiscoverQuery, DiscoverToken } from "./discover-client";
import { usdValue, type UsdQuote, type UsdValue } from "@varada/sdk";
import { formatQuote, formatUsdc, formatUsdValue, unitsToNumber } from "./format";
import type { AppQuoteAsset } from "./quote-assets";
import { describeQuoteAsset, findQuote } from "./quote-assets";

/**
 * State and mapping for the home page's discovery lists: tabs and filters in the URL, the request
 * each tab makes, and token rows turned into the library's card data. Pure, so the pieces are tested.
 */

export const TABS = ["trending", "new", "stocks", "cause", "live"] as const;
export type DiscoverTab = (typeof TABS)[number];

export const TAB_LABELS: Record<DiscoverTab, string> = {
  trending: "Trending",
  new: "New",
  stocks: "Stocks & RWA",
  cause: "By cause",
  live: "Live donation",
};

export type LaunchMode = "weekly" | "live";

export interface DiscoverState {
  tab: DiscoverTab;
  /** Quote asset symbol (a pair filter), e.g. `WETH` or `NVDAon`. */
  pair: string | null;
  /** Catalogue category slug. */
  category: string | null;
  /** Catalogue region slug. */
  region: string | null;
  /** Launch mode filter; the Live tab implies `live`. */
  mode: LaunchMode | null;
  /** Live tab: only this rotation cadence. */
  cadence: LiveCadence | null;
  /** Free-text search (name, symbol or ENS label). */
  q: string;
}

export const CADENCES = ["1h", "12h", "24h", "72h", "week"] as const satisfies readonly LiveCadence[];

export const DEFAULT_STATE: DiscoverState = { tab: "trending", pair: null, category: null, region: null, mode: null, cadence: null, q: "" };

const CATEGORY_SLUGS: ReadonlySet<string> = new Set(CATEGORIES.map((c) => c.slug));
const REGION_SLUGS: ReadonlySet<string> = new Set(REGIONS.map((r) => r.slug));

/** The state a query string describes; anything unknown is ignored. */
export function parseState(search: string): DiscoverState {
  const p = new URLSearchParams(search);
  const tab = p.get("tab");
  const category = p.get("category");
  const region = p.get("region");
  const mode = p.get("mode");
  const cadence = p.get("cadence");
  return {
    tab: (TABS as readonly string[]).includes(tab ?? "") ? (tab as DiscoverTab) : "trending",
    pair: p.get("pair")?.slice(0, 32) || null,
    category: category && CATEGORY_SLUGS.has(category) ? category : null,
    region: region && REGION_SLUGS.has(region) ? region : null,
    mode: mode === "weekly" || mode === "live" ? mode : null,
    cadence: (CADENCES as readonly string[]).includes(cadence ?? "") ? (cadence as LiveCadence) : null,
    q: (p.get("q") ?? "").slice(0, 100),
  };
}

/** Query string for a state, omitting defaults ("" for the default state). */
export function stateToSearch(s: DiscoverState): string {
  const p = new URLSearchParams();
  if (s.tab !== "trending") p.set("tab", s.tab);
  if (s.pair) p.set("pair", s.pair);
  if (s.category) p.set("category", s.category);
  if (s.region) p.set("region", s.region);
  if (s.mode && s.tab !== "live") p.set("mode", s.mode);
  if (s.cadence && s.tab === "live") p.set("cadence", s.cadence);
  if (s.q.trim()) p.set("q", s.q.trim());
  const out = p.toString();
  return out ? `?${out}` : "";
}

export const isCryptoKind = (kind: QuoteKind) => kind === "crypto";

/**
 * The request a state makes. `assets` are the registry's allowlisted pairs: the Stocks & RWA tab
 * lists every non-crypto pair unless one is picked; a picked pair always filters by that asset.
 */
export function buildQuery(s: DiscoverState, assets: readonly Pick<AppQuoteAsset, "symbol" | "kind" | "address">[], page: { cursor?: string; limit?: number } = {}): DiscoverQuery {
  const pair = s.pair ? assets.find((a) => a.symbol === s.pair) : undefined;
  let quotes: string[] | undefined;
  if (pair) quotes = [pair.address];
  else if (s.tab === "stocks") quotes = assets.filter((a) => !isCryptoKind(a.kind)).map((a) => a.address);
  return {
    sort: s.tab === "new" ? "new" : s.tab === "cause" && !s.category ? "raised" : "trending",
    mode: s.tab === "live" ? "live" : (s.mode ?? undefined),
    periods: s.tab === "live" && s.cadence ? [CADENCES.indexOf(s.cadence)] : undefined,
    quotes,
    categories: s.category ? [s.category] : undefined,
    regions: s.region ? [s.region] : undefined,
    q: s.q.trim() || undefined,
    cursor: page.cursor,
    limit: page.limit ?? 24,
  };
}

/** True when the Stocks & RWA tab has no allowlisted non-crypto pair, so its query would match every token. */
export function stocksTabEmpty(s: DiscoverState, assets: readonly Pick<AppQuoteAsset, "kind">[]): boolean {
  return s.tab === "stocks" && !s.pair && !assets.some((a) => !isCryptoKind(a.kind));
}

/* ---------- card data ---------- */

const CADENCE: readonly [number, LiveCadence][] = [
  [3_600, "1h"],
  [43_200, "12h"],
  [86_400, "24h"],
  [259_200, "72h"],
];

export function cadenceOf(periodSeconds: number): LiveCadence {
  return CADENCE.find(([s]) => s === periodSeconds)?.[1] ?? "week";
}

export function givingOf(t: Pick<DiscoverToken, "mode">): GivingMode {
  return t.mode.kind === "live" ? { mode: "live", cadence: cadenceOf(t.mode.periodSeconds) } : { mode: "weekly" };
}

const CATEGORY_NAME = new Map<string, CauseName>(CATEGORIES.map((c) => [c.slug, (c.ensLabel && isCauseName(c.ensLabel) ? c.ensLabel : "other") as CauseName]));

/** The library's cause name for a catalogue slug (`disaster-relief` becomes `disaster`). */
export function causeNameOf(slug: string): CauseName {
  return CATEGORY_NAME.get(slug) ?? "other";
}

/** The category chip: one category by name, otherwise "N causes" or "Any cause". */
export function causeChipOf(focus: DiscoverToken["focus"]): { cause: CauseName; label?: string } {
  const cats = focus?.categories ?? [];
  if (cats.length === 1) return { cause: causeNameOf(cats[0]!) };
  if (cats.length === 0 || cats.length === CATEGORIES.length) return { cause: "other", label: "Any cause" };
  return { cause: causeNameOf(cats[0]!), label: `${cats.length} causes` };
}

const WASH: Record<QuoteKind, WashTone> = { crypto: "ochre", stock: "sky", etf: "etf", rwa: "sage" };

export interface CardContext {
  /** ENS parent, `varada.eth`. */
  parent: string;
  assets: readonly AppQuoteAsset[];
  /** Logo of a token from its Swarm reference. */
  logo(ref: string | null): ImageSource | undefined;
  /** Largest `raised` on the page; the bar shows each token against it. */
  maxRaised: bigint;
  /** USD per quote asset from the shared pricing layer; absent or unpriced assets show in their own units. */
  usd?: (quote: string | null | undefined) => UsdQuote | undefined;
}

/** USD value of `units` whole units of the quote asset, with the "~" flag; null without a price. */
export function quoteUsdValue(units: number, quote: string | null | undefined, ctx: Pick<CardContext, "usd">): UsdValue | null {
  return usdValue(units, quote ? ctx.usd?.(quote) : undefined);
}

/** A quote-asset amount for display: dollars ("~$1.2K") when the quote is priced, its own units otherwise. */
export function quoteAmountText(units: number, symbol: string, quote: string | null | undefined, ctx: Pick<CardContext, "usd">): string {
  const v = quoteUsdValue(units, quote, ctx);
  return v ? formatUsdValue(v.usd, v.approx) : formatQuote(units, symbol);
}

export function quoteOf(address: string | null | undefined, assets: readonly AppQuoteAsset[]) {
  if (!address) return null;
  const known = findQuote(assets, address);
  if (known) return { symbol: known.symbol, kind: known.kind, logo: known.logo };
  const d = describeQuoteAsset(address);
  return { symbol: d.symbol, kind: d.kind, logo: undefined };
}

/** Whole-token market cap in the quote asset: price times supply. */
export function marketCapQuote(t: DiscoverToken): number | null {
  const m = t.market;
  if (!m || m.price === null || m.supply === null) return null;
  return m.price * unitsToNumber(m.supply, 18);
}

const DASH = "–";

/** The library's card data for a token. Money is in dollars at the quote asset's on-chain price (no oracle), in the quote asset's own units when it has no price. */
export function toCardToken(t: DiscoverToken, ctx: CardContext): CardToken {
  const m = t.market;
  const q = quoteOf(m?.quote, ctx.assets) ?? { symbol: "–", kind: "crypto" as QuoteKind, logo: undefined };
  const qd = m?.quoteDecimals ?? 18;
  const cap = marketCapQuote(t);
  const chip = causeChipOf(t.focus);
  return {
    name: t.name || t.symbol || shortAddr(t.address),
    symbol: t.symbol,
    ens: t.label ? `${t.label}.${ctx.parent}` : shortAddr(t.address),
    art: ctx.logo(t.logoRef),
    artAlt: t.name ? `${t.name} logo` : undefined,
    wash: WASH[q.kind],
    giving: givingOf(t),
    change24h: m?.change24h ?? null,
    quote: { symbol: q.symbol, kind: q.kind, logo: q.logo },
    cause: chip.cause,
    causeLabel: chip.label,
    marketCap: cap === null ? DASH : quoteAmountText(cap, q.symbol, m?.quote, ctx),
    volume24h: m?.quote ? quoteAmountText(unitsToNumber(m.volume24hQuote, qd), q.symbol, m.quote, ctx) : DASH,
    liquidity: m?.quote ? quoteAmountText(unitsToNumber(m.quoteInPool, qd), q.symbol, m.quote, ctx) : DASH,
    raised: formatUsdc(t.raised),
    raisedPct: ctx.maxRaised > 0n ? Number((t.raised * 100n) / ctx.maxRaised) : 0,
  };
}

export const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** The token's page, relative to the site root. */
export const tokenPath = (address: string) => `token/?address=${address}`;

export function maxRaisedOf(tokens: readonly Pick<DiscoverToken, "raised">[]): bigint {
  return tokens.reduce((m, t) => (t.raised > m ? t.raised : m), 0n);
}
