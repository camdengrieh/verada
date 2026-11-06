import { ALL_CATEGORIES_MASK, ALL_REGIONS_MASK, categorySlugs, donationAssetOrDefault, regionSlugs, type DonationAsset } from "@varada/sdk";
import type { Hex } from "viem";
import { periodLength } from "../rotation-schedule";
import type { TokenRow } from "./types";

/**
 * One request for everything a token card needs: the token, its fee total, giving mode and a
 * market summary (price, 24h change, volume, trades, holders, quote in the pool). Built from a few
 * bulk table reads, so listing N tokens costs a constant number of queries, not N.
 */

export const DISCOVER_SORTS = ["trending", "new", "raised", "holders", "change"] as const;
export type DiscoverSort = (typeof DISCOVER_SORTS)[number];

export interface DiscoverQuery {
  sort: DiscoverSort;
  mode?: "weekly" | "live";
  /** Rotation periods (0 = 1h, 1 = 12h, 2 = 1d, 3 = 3d, 4 = 1w) of live tokens; weekly tokens never match. */
  periods?: number[];
  /** Quote asset addresses (lowercase); a token matches when its pool quote is one of them. */
  quotes?: Hex[];
  /** Focus filters: a token matches when its cause focus overlaps (a token with no focus indexed counts as any). */
  categoryMask?: bigint;
  regionMask?: number;
  /** Case-insensitive match on name, symbol or ENS label. */
  q?: string;
  /** Restrict to these tokens (a bulk read by address). */
  tokens?: Hex[];
  offset: number;
  limit: number;
}

export interface DiscoverHourRow {
  token: Hex;
  hour: bigint;
  buys: number;
  sells: number;
  buyQuote: bigint;
  sellQuote: bigint;
  openTick: number;
  closeSqrtPriceX96: bigint;
}

/** Raw rows, one bulk read per table; `buildDiscover` joins them. */
export interface DiscoverSource {
  tokens: TokenRow[];
  fees: { token: Hex; causeAmount: bigint; platformAmount: bigint; collections: number }[];
  markets: { token: Hex; quote: Hex; tokenIsCurrency0: boolean }[];
  quoteDecimals: { asset: Hex; decimals: number }[];
  stats: { token: Hex; trades: number; lastSqrtPriceX96: bigint; lastTick: number; lastTradeAt: bigint }[];
  /** Hour rows inside the 24h window (any order). */
  hours: DiscoverHourRow[];
  /** Lifetime quote paid in by buyers and out to sellers, per token. */
  flows: { token: Hex; buyQuote: bigint; sellQuote: bigint }[];
  holders: { token: Hex; holders: number; supply: bigint }[];
  live: { token: Hex; quote: Hex | null; initialPeriod: number | null }[];
  liveSchedules: { token: Hex; period: number; hasPending: boolean; pendingPeriod: number; switchAt: bigint | null }[];
}

export type DiscoverMode = { kind: "weekly" } | { kind: "live"; period: number; periodSeconds: number };

export interface DiscoverMarket {
  quote: Hex | null;
  quoteDecimals: number | null;
  /** Quote per whole token at the last trade; null before the first trade. */
  price: number | null;
  /** Percent change from the first trade price in the last 24 hours; null without trades in the window. */
  change24h: number | null;
  /** Quote paid in and out over the last 24h, base units of the quote asset. */
  volume24hQuote: bigint;
  trades24h: number;
  buys24h: number;
  sells24h: number;
  tradesTotal: number;
  lastTradeAt: bigint | null;
  /**
   * Quote asset the pool holds, estimated as all quote buyers paid in minus all sellers took out,
   * base units. Launch liquidity is tokens only, so this is the quote side of the pool (before hook fees).
   */
  quoteInPool: bigint;
  holders: number | null;
  supply: bigint | null;
}

export interface DiscoverItem {
  address: Hex;
  name: string;
  symbol: string;
  label: string | null;
  logoRef: Hex | null;
  creator: Hex;
  feeBps: number;
  /** Asset `raised`, `platformFees` and every donation are in: 'usdc' (6 decimals) or 'eth' (18). */
  donationAsset: DonationAsset;
  createdAt: bigint;
  focus: { categoryMask: bigint; regionMask: number; categories: string[]; regions: string[] } | null;
  /** Donation-asset units credited to causes so far. */
  raised: bigint;
  platformFees: bigint;
  mode: DiscoverMode;
  market: DiscoverMarket;
}

const tickRatio = (ticks: number) => 1.0001 ** ticks;

/** Price move in percent between two ticks of a pool whose price rises with the tick when the token is currency0. */
export function changeFromTicks(openTick: number, lastTick: number, tokenIsCurrency0: boolean): number {
  const d = tokenIsCurrency0 ? lastTick - openTick : openTick - lastTick;
  return Math.round((tickRatio(d) - 1) * 100 * 100) / 100;
}

const Q96 = 2n ** 96n;
/** Quote per whole token (18 decimals) from a pool sqrt price. Display precision only. */
export function priceOf(sqrtPriceX96: bigint, tokenIsCurrency0: boolean, quoteDecimals: number): number {
  if (sqrtPriceX96 === 0n) return 0;
  const r = Number(sqrtPriceX96) / Number(Q96);
  const raw = r * r;
  return (tokenIsCurrency0 ? raw : 1 / raw) * 10 ** (18 - quoteDecimals);
}

const lc = (a: string) => a.toLowerCase();

function index<T extends { token: Hex }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((r) => [lc(r.token), r]));
}

/** Joins the bulk rows into items (unfiltered, newest first). */
export function joinDiscover(src: DiscoverSource, nowSec: bigint): DiscoverItem[] {
  const fees = index(src.fees);
  const markets = index(src.markets);
  const stats = index(src.stats);
  const flows = index(src.flows);
  const holders = index(src.holders);
  const live = index(src.live);
  const schedules = index(src.liveSchedules);
  const decimals = new Map(src.quoteDecimals.map((q) => [lc(q.asset), q.decimals]));
  const hoursBy = new Map<string, DiscoverHourRow[]>();
  for (const h of src.hours) {
    const k = lc(h.token);
    const list = hoursBy.get(k);
    if (list) list.push(h);
    else hoursBy.set(k, [h]);
  }

  return src.tokens
    .map((t): DiscoverItem => {
      const k = lc(t.address);
      const m = markets.get(k);
      const l = live.get(k);
      const s = schedules.get(k);
      const quote = m?.quote ?? l?.quote ?? null;
      const qd = quote ? (decimals.get(lc(quote)) ?? null) : null;
      const stat = stats.get(k);
      const isC0 = m?.tokenIsCurrency0 ?? (quote ? lc(t.address) < lc(quote) : null);
      const hrs = (hoursBy.get(k) ?? []).sort((a, b) => (a.hour < b.hour ? -1 : 1));
      const buys24h = hrs.reduce((n, h) => n + h.buys, 0);
      const sells24h = hrs.reduce((n, h) => n + h.sells, 0);
      const volume24hQuote = hrs.reduce((n, h) => n + h.buyQuote + h.sellQuote, 0n);
      const flow = flows.get(k);
      const h = holders.get(k);
      const fee = fees.get(k);
      const period = s ? (s.hasPending && s.switchAt !== null && s.switchAt <= nowSec ? s.pendingPeriod : s.period) : (l?.initialPeriod ?? 4);
      const first = hrs[0];
      return {
        address: t.address,
        name: t.name,
        symbol: t.symbol,
        label: t.label,
        logoRef: t.logoRef,
        creator: t.creator,
        feeBps: t.feeBps,
        donationAsset: donationAssetOrDefault(t.donationAsset),
        createdAt: t.createdAt,
        focus:
          t.categoryMask !== null && t.regionMask !== null
            ? { categoryMask: t.categoryMask, regionMask: t.regionMask, categories: categorySlugs(t.categoryMask), regions: regionSlugs(t.regionMask) }
            : null,
        raised: fee?.causeAmount ?? 0n,
        platformFees: fee?.platformAmount ?? 0n,
        mode: l ? { kind: "live", period, periodSeconds: Number(periodLength(period)) } : { kind: "weekly" },
        market: {
          quote,
          quoteDecimals: qd,
          price: stat && qd !== null && isC0 !== null ? priceOf(stat.lastSqrtPriceX96, isC0, qd) : null,
          change24h: stat && first && isC0 !== null ? changeFromTicks(first.openTick, stat.lastTick, isC0) : null,
          volume24hQuote,
          trades24h: buys24h + sells24h,
          buys24h,
          sells24h,
          tradesTotal: stat?.trades ?? 0,
          lastTradeAt: stat?.lastTradeAt ?? null,
          quoteInPool: flow ? (flow.buyQuote > flow.sellQuote ? flow.buyQuote - flow.sellQuote : 0n) : 0n,
          holders: h?.holders ?? null,
          supply: h?.supply ?? null,
        },
      };
    })
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.address < b.address ? 1 : -1) : a.createdAt > b.createdAt ? -1 : 1));
}

function matches(i: DiscoverItem, q: DiscoverQuery): boolean {
  if (q.tokens && !q.tokens.some((t) => lc(t) === lc(i.address))) return false;
  if (q.mode && i.mode.kind !== q.mode) return false;
  if (q.periods?.length && !(i.mode.kind === "live" && q.periods.includes(i.mode.period))) return false;
  if (q.quotes?.length && !(i.market.quote && q.quotes.some((x) => lc(x) === lc(i.market.quote!)))) return false;
  if (q.categoryMask !== undefined && q.categoryMask !== ALL_CATEGORIES_MASK) {
    if (i.focus && (i.focus.categoryMask & q.categoryMask) === 0n) return false;
  }
  if (q.regionMask !== undefined && q.regionMask !== ALL_REGIONS_MASK) {
    if (i.focus && (i.focus.regionMask & q.regionMask) === 0) return false;
  }
  if (q.q) {
    const needle = q.q.toLowerCase().replace(/^\$/, "");
    const hay = [i.name, i.symbol, i.label ?? "", i.address].map((s) => s.toLowerCase());
    if (!hay.some((s) => s.includes(needle))) return false;
  }
  return true;
}

const byNew = (a: DiscoverItem, b: DiscoverItem) => (a.createdAt === b.createdAt ? 0 : a.createdAt > b.createdAt ? -1 : 1);

/** Sort order of each tab; newest first breaks every tie. */
function compare(sort: DiscoverSort): (a: DiscoverItem, b: DiscoverItem) => number {
  switch (sort) {
    case "new":
      return byNew;
    case "raised":
      return (a, b) => (a.raised === b.raised ? byNew(a, b) : a.raised > b.raised ? -1 : 1);
    case "holders":
      return (a, b) => (b.market.holders ?? 0) - (a.market.holders ?? 0) || byNew(a, b);
    case "change":
      return (a, b) => (b.market.change24h ?? -Infinity) - (a.market.change24h ?? -Infinity) || byNew(a, b);
    default:
      // Trending: most trades in the last 24 hours (a count, so it compares across quote assets), then the most buys.
      return (a, b) => b.market.trades24h - a.market.trades24h || b.market.buys24h - a.market.buys24h || byNew(a, b);
  }
}

export function filterAndPage(items: readonly DiscoverItem[], q: DiscoverQuery): { items: DiscoverItem[]; total: number; nextOffset: number | null } {
  const rows = items.filter((i) => matches(i, q)).sort(compare(q.sort));
  const page = rows.slice(q.offset, q.offset + q.limit);
  const end = q.offset + page.length;
  return { items: page, total: rows.length, nextOffset: end < rows.length ? end : null };
}

/** Read access for `GET /api/discover`; implemented over Ponder's db and by test fixtures. */
export interface DiscoverRepo {
  /** Every non-suppressed token with its market summary (newest first). Implementations may cache for a few seconds. */
  items(): Promise<DiscoverItem[]>;
}
