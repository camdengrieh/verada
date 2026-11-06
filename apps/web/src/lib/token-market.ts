/**
 * Pure mappers from the indexer's market data to what the token page draws. Prices are quote asset
 * per whole token, derived the way services/indexer/src/api/market.ts `priceFromSqrt` does.
 */
import type { PriceCandle, PricePoint } from "@varada/ui/components/data/price-chart";
import type { PressureWindow } from "@varada/ui/components/varada/buy-sell-pressure";
import type { TradeItem } from "@varada/ui/components/varada/trade-feed";
import type { VolumeBar } from "@varada/ui/components/varada/volume-bars";
import type { ActivityItem, MarketHour, MarketSnapshot, MarketTrade } from "./indexer";

export const HOUR = 3600;
export const TOKEN_DECIMALS = 18;

/** Chart ranges: 1H is drawn from the individual trades, 24H and 7D from the hourly candles. */
export const RANGES = ["1H", "24H", "7D"] as const;
export type Range = (typeof RANGES)[number];

/** Hours of hourly rows each range needs. */
export const RANGE_HOURS: Record<Range, number> = { "1H": 1, "24H": 24, "7D": 168 };

/** Uniswap sorts a pool's currencies by address, so the token is currency0 when its address is lower. */
export function tokenIsCurrency0(token: string, quote: string): boolean {
  return token.toLowerCase() < quote.toLowerCase();
}

/** Quote per whole token at a pool tick (price of currency1 in currency0 is 1.0001^tick, in raw units). */
export function tickPrice(tick: number, isCurrency0: boolean, quoteDecimals: number): number {
  const raw = Math.pow(1.0001, tick);
  const perRaw = isCurrency0 ? raw : 1 / raw;
  return perRaw * Math.pow(10, TOKEN_DECIMALS - quoteDecimals);
}

/** A bigint amount of base units as a float in whole units (display precision only). */
export function toUnits(amount: bigint, decimals: number): number {
  if (decimals <= 0) return Number(amount);
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = amount % base;
  return Number(whole) + Number(frac) / Number(base);
}

const finitePositive = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * Hourly OHLC candles from the market snapshot's tick rows. Hours with no trade carry the previous
 * close flat, up to `nowSec`'s hour, so the time axis is continuous. Empty before the first trade.
 */
export function candlesFromHours(snapshot: Pick<MarketSnapshot, "quote" | "quoteDecimals" | "hourly">, token: string, nowSec: number): PriceCandle[] {
  const { quote, quoteDecimals, hourly } = snapshot;
  if (!quote || quoteDecimals === null) return [];
  const c0 = tokenIsCurrency0(token, quote);
  const rows = [...hourly].sort((a, b) => a.hour - b.hour);
  const out: PriceCandle[] = [];
  const nowHour = nowSec - (nowSec % HOUR);
  for (const r of rows) {
    const ticks = [r.openTick, r.highTick, r.lowTick, r.closeTick];
    if (ticks.some((t) => t === null)) continue;
    const [open, a, b, close] = ticks.map((t) => tickPrice(t as number, c0, quoteDecimals)) as [number, number, number, number];
    const prev = out[out.length - 1];
    if (prev) {
      for (let t = prev.time + HOUR; t < r.hour; t += HOUR) out.push({ time: t, open: prev.close, high: prev.close, low: prev.close, close: prev.close, volume: 0 });
    }
    out.push({
      time: r.hour,
      open,
      high: Math.max(open, a, b, close),
      low: Math.min(open, a, b, close),
      close,
      volume: toUnits(r.buyQuote + r.sellQuote, quoteDecimals),
    });
  }
  const last = out[out.length - 1];
  if (last) for (let t = last.time + HOUR; t <= nowHour; t += HOUR) out.push({ time: t, open: last.close, high: last.close, low: last.close, close: last.close, volume: 0 });
  return out;
}

/** The last price of every trade inside the last hour, oldest first, one point per second at most. */
export function tradePoints(trades: readonly MarketTrade[], nowSec: number, windowSec = HOUR): PricePoint[] {
  const byTime = new Map<number, number>();
  for (const t of [...trades].sort((a, b) => a.timestamp - b.timestamp)) {
    if (t.price === null || !finitePositive(t.price) || t.timestamp < nowSec - windowSec) continue;
    byTime.set(t.timestamp, t.price);
  }
  return [...byTime].map(([time, value]) => ({ time, value }));
}

export interface MarketStats {
  /** Quote per token now; null before the first trade or while the quote's decimals are unknown. */
  price: number | null;
  /** Percent change over the last 24 hours (or since the first trade, for a younger token). */
  change24h: number | null;
  changeSince: "24h" | "first trade";
  /** Quote volume of the last 24 hourly buckets. */
  volume24h: number;
  /** Volume of the 24 hours before those, for the delta; null when the snapshot does not reach back that far. */
  volumePrior24h: number | null;
  buys24h: number;
  sells24h: number;
  trades24h: number;
}

/** 24-hour figures from `hourly` (needs at least 24 hours of rows to say anything about the prior day). */
export function marketStats(snapshot: Pick<MarketSnapshot, "quote" | "quoteDecimals" | "price" | "hourly">, token: string, nowSec: number): MarketStats {
  const candles = snapshot.quote ? candlesFromHours({ ...snapshot, quote: snapshot.quote }, token, nowSec) : [];
  const dec = snapshot.quoteDecimals ?? 0;
  const cutoff = nowSec - 24 * HOUR;
  const prior = nowSec - 48 * HOUR;
  let volume24h = 0;
  let volumePrior = 0;
  let buys = 0;
  let sells = 0;
  for (const h of snapshot.hourly) {
    const v = toUnits(h.buyQuote + h.sellQuote, dec);
    if (h.hour + HOUR > cutoff) {
      volume24h += v;
      buys += h.buys;
      sells += h.sells;
    } else if (h.hour + HOUR > prior) volumePrior += v;
  }
  const price = snapshot.price !== null && finitePositive(snapshot.price) ? snapshot.price : null;
  let change: number | null = null;
  let since: MarketStats["changeSince"] = "24h";
  if (price !== null && candles.length > 0) {
    const before = [...candles].reverse().find((c) => c.time + HOUR <= cutoff);
    const base = before ? before.close : candles[0]!.open;
    since = before ? "24h" : "first trade";
    change = base > 0 ? ((price - base) / base) * 100 : null;
  }
  const reachesBack = snapshot.hourly.some((h) => h.hour + HOUR <= cutoff);
  return {
    price,
    change24h: change,
    changeSince: since,
    volume24h,
    volumePrior24h: reachesBack ? volumePrior : null,
    buys24h: buys,
    sells24h: sells,
    trades24h: buys + sells,
  };
}

/** Percent change of `now` over `before`; undefined when there is nothing to compare. */
export function percentChange(now: number, before: number | null | undefined): number | undefined {
  if (before === null || before === undefined || !(before > 0)) return undefined;
  return ((now - before) / before) * 100;
}

/** Buy and sell counts over the last 6 hours, 24 hours and 7 days, for the pressure gauge. */
/** Volumes are set only for a dollar quote: the gauge prints them as dollars. */
export function pressureWindows(hourly: readonly MarketHour[], quoteDecimals: number | null, nowSec: number, usdQuote = false): PressureWindow[] {
  const spans: [string, number][] = [["6h", 6], ["24h", 24], ["7d", 168]];
  return spans.map(([key, hours]) => {
    const cutoff = nowSec - hours * HOUR;
    let buys = 0;
    let sells = 0;
    let buyQuote = 0n;
    let sellQuote = 0n;
    for (const h of hourly) {
      if (h.hour + HOUR <= cutoff) continue;
      buys += h.buys;
      sells += h.sells;
      buyQuote += h.buyQuote;
      sellQuote += h.sellQuote;
    }
    const w: PressureWindow = { key, buys, sells };
    if (usdQuote && quoteDecimals !== null) {
      w.buyVolumeUsd = toUnits(buyQuote, quoteDecimals);
      w.sellVolumeUsd = toUnits(sellQuote, quoteDecimals);
    }
    return w;
  });
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** One bar per hour (24H, labelled HH:00 UTC) or per UTC day (7D, labelled by weekday), oldest first. Quote units. */
export function volumeBars(hourly: readonly MarketHour[], quoteDecimals: number | null, nowSec: number, range: "24H" | "7D"): VolumeBar[] {
  const dec = quoteDecimals ?? 0;
  const byHour = new Map(hourly.map((h) => [h.hour, toUnits(h.buyQuote + h.sellQuote, dec)]));
  const nowHour = nowSec - (nowSec % HOUR);
  if (range === "24H") {
    return Array.from({ length: 24 }, (_, i) => {
      const t = nowHour - (23 - i) * HOUR;
      return { label: `${pad(new Date(t * 1000).getUTCHours())}:00`, value: byHour.get(t) ?? 0 };
    });
  }
  const nowDay = nowSec - (nowSec % 86_400);
  return Array.from({ length: 7 }, (_, i) => {
    const day = nowDay - (6 - i) * 86_400;
    let value = 0;
    for (let h = 0; h < 24; h++) value += byHour.get(day + h * HOUR) ?? 0;
    return { label: DAY_NAMES[new Date(day * 1000).getUTCDay()]!, value };
  });
}

/** Activity-stream `trade` item to the shape of `GET /api/tokens/:address/trades`. */
export function tradeFromActivity(item: ActivityItem, token: string, isCurrency0: boolean, quoteDecimals: number | null): MarketTrade | null {
  if (item.kind !== "trade" || !item.txHash || item.timestamp === undefined) return null;
  const d = item.data;
  const side = d.side;
  if (side !== "buy" && side !== "sell") return null;
  const big = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : 0n);
  const tick = typeof d.tick === "number" ? d.tick : null;
  return {
    id: item.id.replace(/^trade:/, ""),
    side,
    trader: typeof d.trader === "string" ? d.trader : "",
    tokenAmount: big(d.tokenAmount),
    quote: typeof d.quote === "string" ? d.quote : "",
    quoteAmount: big(d.quoteAmount),
    quoteDecimals,
    price: tick !== null && quoteDecimals !== null ? tickPrice(tick, isCurrency0, quoteDecimals) : null,
    timestamp: item.timestamp,
    txHash: item.txHash,
  };
}

/** Newest first, one row per id; later lists win ties so fresher data replaces older. */
export function mergeTrades(...lists: readonly (readonly MarketTrade[])[]): MarketTrade[] {
  const byId = new Map<string, MarketTrade>();
  for (const list of lists) for (const t of list) byId.set(t.id, t);
  return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? 1 : -1));
}

/** Keeps the connected account's own swaps. The comparison happens in the browser; the address never leaves it. */
export function mine(trades: readonly MarketTrade[], account: string | undefined): MarketTrade[] {
  if (!account) return [];
  const a = account.toLowerCase();
  return trades.filter((t) => t.trader.toLowerCase() === a);
}

/**
 * Library rows for the trade tape. `usd` is only set when the quote is a USD stablecoin (the
 * quote amount is then the dollar value); other quotes show their own amounts.
 */
export function tradeItems(trades: readonly MarketTrade[], opts: { tokenSymbol: string; quoteSymbol: string; quoteDecimals: number | null; usdQuote: boolean }): TradeItem[] {
  return trades.map((t) => {
    const dec = t.quoteDecimals ?? opts.quoteDecimals ?? 0;
    const quoteAmount = toUnits(t.quoteAmount, dec);
    return {
      id: t.id,
      side: t.side,
      trader: { address: t.trader as `0x${string}` },
      tokenAmount: toUnits(t.tokenAmount, TOKEN_DECIMALS),
      tokenSymbol: opts.tokenSymbol,
      quoteAmount,
      quoteSymbol: opts.quoteSymbol,
      usd: opts.usdQuote ? quoteAmount : undefined,
      timestamp: t.timestamp,
      txHash: t.txHash as `0x${string}`,
    };
  });
}

/** Price text in the quote asset: 0.00004213 WETH, 1.27 USDC. */
export function formatQuotePrice(price: number, symbol: string): string {
  const opts: Intl.NumberFormatOptions = price >= 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { minimumSignificantDigits: 2, maximumSignificantDigits: 4 };
  return `${price.toLocaleString("en-US", opts)} ${symbol}`;
}

/** Intl options for a price in the quote asset's units (no currency symbol). */
export function quoteNumberFormat(price: number): Intl.NumberFormatOptions {
  return price >= 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { minimumSignificantDigits: 2, maximumSignificantDigits: 4 };
}
