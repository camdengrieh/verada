import { describe, expect, it } from "vitest";
import { priceFromSqrt } from "../../../services/indexer/src/api/market";
import type { ActivityItem, MarketHour, MarketTrade } from "@/lib/indexer";
import {
  candlesFromHours,
  formatQuotePrice,
  HOUR,
  marketStats,
  mergeTrades,
  mine,
  percentChange,
  pressureWindows,
  tickPrice,
  tokenIsCurrency0,
  toUnits,
  tradeFromActivity,
  tradeItems,
  tradePoints,
  volumeBars,
} from "@/lib/token-market";

const TOKEN = "0x00000000000000000000000000000000000000a1";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const NOW = 1_700_000_000 - (1_700_000_000 % HOUR) + 600; // ten minutes into an hour
const H0 = NOW - (NOW % HOUR);

const Q96 = 2n ** 96n;
/** The pool's sqrt price at a tick, as a Q64.96 bigint (float precision is enough for the comparison). */
const sqrtAt = (tick: number) => BigInt(Math.round(Math.pow(1.0001, tick / 2) * Number(Q96)));

const hour = (h: number, o: Partial<MarketHour> = {}): MarketHour => ({
  hour: h,
  buys: 1,
  sells: 0,
  buyQuote: 10n ** 16n,
  sellQuote: 0n,
  openTick: -69_000,
  highTick: -68_900,
  lowTick: -69_000,
  closeTick: -68_900,
  closePrice: null,
  ...o,
});

describe("tickPrice", () => {
  it("agrees with the indexer's priceFromSqrt for both pool orientations and any quote decimals", () => {
    for (const tick of [-207_000, -69_000, -1, 0, 1, 69_000, 120_000]) {
      for (const c0 of [true, false]) {
        for (const dec of [6, 18]) {
          const fromTick = tickPrice(tick, c0, dec);
          const fromSqrt = priceFromSqrt(sqrtAt(tick), c0, dec);
          expect(fromTick / fromSqrt).toBeCloseTo(1, 6);
        }
      }
    }
  });

  it("orders currencies by address like Uniswap", () => {
    expect(tokenIsCurrency0(TOKEN, WETH)).toBe(true);
    expect(tokenIsCurrency0("0xffffffffffffffffffffffffffffffffffffffff", WETH)).toBe(false);
    expect(tokenIsCurrency0(TOKEN.toUpperCase().replace("0X", "0x"), WETH)).toBe(true);
  });

  it("converts base units to whole units", () => {
    expect(toUnits(1_500_000n, 6)).toBe(1.5);
    expect(toUnits(2n * 10n ** 18n + 5n * 10n ** 17n, 18)).toBe(2.5);
    expect(toUnits(7n, 0)).toBe(7);
  });
});

describe("candlesFromHours", () => {
  const snap = (hourly: MarketHour[]) => ({ quote: WETH, quoteDecimals: 18, hourly });

  it("builds OHLC candles from the tick rows, with volume in quote units", () => {
    const [c] = candlesFromHours(snap([hour(H0 - 3 * HOUR)]), TOKEN, H0 - 3 * HOUR);
    expect(c).toMatchObject({ time: H0 - 3 * HOUR, volume: 0.01 });
    expect(c!.open).toBeCloseTo(tickPrice(-69_000, true, 18), 12);
    expect(c!.close).toBeCloseTo(tickPrice(-68_900, true, 18), 12);
    expect(c!.high).toBeGreaterThan(c!.open);
    expect(c!.low).toBeCloseTo(c!.open, 12);
  });

  it("flips high and low when the token is currency1", () => {
    const below = "0xffffffffffffffffffffffffffffffffffffffff";
    const [c] = candlesFromHours(snap([hour(H0)]), below, H0);
    // A rising tick is a falling token price in that orientation.
    expect(c!.close).toBeLessThan(c!.open);
    expect(c!.high).toBeCloseTo(c!.open, 12);
    expect(c!.low).toBeCloseTo(c!.close, 12);
    expect(c!.high).toBeGreaterThanOrEqual(c!.low);
  });

  it("carries the last close flat through hours without trades, up to the current hour", () => {
    const candles = candlesFromHours(snap([hour(H0 - 4 * HOUR), hour(H0 - 1 * HOUR, { openTick: -68_800, highTick: -68_700, lowTick: -68_800, closeTick: -68_700 })]), TOKEN, NOW);
    expect(candles.map((c) => c.time)).toEqual([H0 - 4 * HOUR, H0 - 3 * HOUR, H0 - 2 * HOUR, H0 - HOUR, H0]);
    const gap = candles[1]!;
    expect(gap).toMatchObject({ volume: 0, open: candles[0]!.close, high: candles[0]!.close, low: candles[0]!.close, close: candles[0]!.close });
    // After the last trade the price holds up to now.
    expect(candles[4]!.close).toBe(candles[3]!.close);
  });

  it("is empty without a quote, decimals or ticks", () => {
    expect(candlesFromHours({ quote: null, quoteDecimals: null, hourly: [hour(H0)] }, TOKEN, NOW)).toEqual([]);
    expect(candlesFromHours(snap([hour(H0, { openTick: null })]), TOKEN, NOW)).toEqual([]);
    expect(candlesFromHours(snap([]), TOKEN, NOW)).toEqual([]);
  });
});

describe("marketStats", () => {
  it("measures the 24h change against the close before the window and sums the window's volume", () => {
    const price = tickPrice(-68_000, true, 18);
    const rows = [
      hour(H0 - 30 * HOUR, { closeTick: -69_000, buyQuote: 5n * 10n ** 16n }),
      hour(H0 - 5 * HOUR, { openTick: -69_000, closeTick: -68_500, buys: 2, buyQuote: 2n * 10n ** 17n }),
      hour(H0, { openTick: -68_500, closeTick: -68_000, sells: 1, buys: 0, buyQuote: 0n, sellQuote: 10n ** 17n }),
    ];
    const s = marketStats({ quote: WETH, quoteDecimals: 18, price, hourly: rows }, TOKEN, NOW);
    expect(s.price).toBe(price);
    expect(s.changeSince).toBe("24h");
    expect(s.change24h).toBeCloseTo(((price - tickPrice(-69_000, true, 18)) / tickPrice(-69_000, true, 18)) * 100, 6);
    expect(s.volume24h).toBeCloseTo(0.3, 9);
    expect(s.volumePrior24h).toBeCloseTo(0.05, 9);
    expect(s.trades24h).toBe(3);
    expect(s.buys24h).toBe(2);
    expect(s.sells24h).toBe(1);
  });

  it("measures a young token from its first trade and has no prior volume to compare", () => {
    const price = tickPrice(-68_900, true, 18);
    const s = marketStats({ quote: WETH, quoteDecimals: 18, price, hourly: [hour(H0 - 2 * HOUR)] }, TOKEN, NOW);
    expect(s.changeSince).toBe("first trade");
    expect(s.change24h).toBeCloseTo(((price - tickPrice(-69_000, true, 18)) / tickPrice(-69_000, true, 18)) * 100, 6);
    expect(s.volumePrior24h).toBeNull();
  });

  it("has no price or change before the first trade", () => {
    const s = marketStats({ quote: null, quoteDecimals: null, price: null, hourly: [] }, TOKEN, NOW);
    expect(s).toMatchObject({ price: null, change24h: null, volume24h: 0, trades24h: 0, volumePrior24h: null });
  });

  it("computes percent change only against a positive base", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(50, 100)).toBe(-50);
    expect(percentChange(1, 0)).toBeUndefined();
    expect(percentChange(1, null)).toBeUndefined();
  });
});

describe("pressure and volume", () => {
  const rows = [
    hour(H0 - 8 * HOUR, { buys: 4, sells: 1, buyQuote: 4n * 10n ** 18n, sellQuote: 10n ** 18n }),
    hour(H0 - 2 * HOUR, { buys: 1, sells: 3, buyQuote: 10n ** 18n, sellQuote: 3n * 10n ** 18n }),
    hour(H0, { buys: 2, sells: 0, buyQuote: 2n * 10n ** 18n, sellQuote: 0n }),
  ];

  it("counts buys and sells over 6h, 24h and 7d", () => {
    const [h6, h24, d7] = pressureWindows(rows, 18, NOW);
    expect(h6).toMatchObject({ key: "6h", buys: 3, sells: 3, buyVolumeUsd: 3, sellVolumeUsd: 3 });
    expect(h24).toMatchObject({ key: "24h", buys: 7, sells: 4 });
    expect(d7).toMatchObject({ key: "7d", buys: 7, sells: 4 });
  });

  it("leaves volumes out when the quote's decimals are unknown", () => {
    const [h6] = pressureWindows(rows, null, NOW);
    expect(h6!.buyVolumeUsd).toBeUndefined();
  });

  it("draws 24 hourly bars ending now and 7 daily bars, in UTC", () => {
    const bars = volumeBars(rows, 18, NOW, "24H");
    expect(bars).toHaveLength(24);
    expect(bars[23]).toEqual({ label: `${String(new Date(H0 * 1000).getUTCHours()).padStart(2, "0")}:00`, value: 2 });
    expect(bars.reduce((s, b) => s + b.value, 0)).toBe(2 + 4 + 5);
    const days = volumeBars(rows, 18, NOW, "7D");
    expect(days).toHaveLength(7);
    expect(days.reduce((s, b) => s + b.value, 0)).toBe(11);
  });
});

const trade = (id: string, o: Partial<MarketTrade> = {}): MarketTrade => ({
  id,
  side: "buy",
  trader: "0x00000000000000000000000000000000000000b2",
  tokenAmount: 5n * 10n ** 18n,
  quote: WETH,
  quoteAmount: 10n ** 16n,
  quoteDecimals: 18,
  price: 0.002,
  timestamp: NOW - 100,
  txHash: `0x${"ab".repeat(32)}`,
  ...o,
});

describe("trades", () => {
  it("plots one point per trade of the last hour, oldest first, and skips unpriced or older trades", () => {
    const pts = tradePoints([trade("a", { timestamp: NOW - 10 }), trade("b", { timestamp: NOW - 500, price: 0.003 }), trade("c", { timestamp: NOW - 4_000 }), trade("d", { price: null })], NOW);
    expect(pts).toEqual([
      { time: NOW - 500, value: 0.003 },
      { time: NOW - 10, value: 0.002 },
    ]);
  });

  it("merges lists newest first without duplicates, later lists winning", () => {
    const merged = mergeTrades([trade("a", { timestamp: 1 }), trade("b", { timestamp: 3 })], [trade("a", { timestamp: 1, price: 9 }), trade("c", { timestamp: 2 })]);
    expect(merged.map((t) => t.id)).toEqual(["b", "c", "a"]);
    expect(merged[2]!.price).toBe(9);
  });

  it("keeps only the connected account's trades, case-insensitively, and none without an account", () => {
    const list = [trade("a"), trade("b", { trader: "0x00000000000000000000000000000000000000C3" })];
    expect(mine(list, "0x00000000000000000000000000000000000000B2").map((t) => t.id)).toEqual(["a"]);
    expect(mine(list, undefined)).toEqual([]);
  });

  it("maps a live activity item to a trade, deriving the price from the tick", () => {
    const item: ActivityItem = {
      id: `trade:0x${"cd".repeat(32)}-4`,
      kind: "trade",
      token: TOKEN,
      timestamp: NOW,
      txHash: `0x${"cd".repeat(32)}`,
      data: { side: "sell", trader: "0x00000000000000000000000000000000000000b2", tokenAmount: "5000000000000000000", quote: WETH, quoteAmount: "10000000000000000", tick: -69_000 },
    };
    const t = tradeFromActivity(item, TOKEN, true, 18)!;
    expect(t.id).toBe(`0x${"cd".repeat(32)}-4`);
    expect(t).toMatchObject({ side: "sell", tokenAmount: 5n * 10n ** 18n, quoteAmount: 10n ** 16n, timestamp: NOW });
    expect(t.price).toBeCloseTo(tickPrice(-69_000, true, 18), 12);
    expect(tradeFromActivity(item, TOKEN, true, null)!.price).toBeNull();
    expect(tradeFromActivity({ ...item, kind: "donation" }, TOKEN, true, 18)).toBeNull();
    expect(tradeFromActivity({ ...item, data: { ...item.data, side: "hold" } }, TOKEN, true, 18)).toBeNull();
    expect(tradeFromActivity({ ...item, txHash: undefined }, TOKEN, true, 18)).toBeNull();
  });

  it("gives USD values only for a dollar quote", () => {
    const [row] = tradeItems([trade("a")], { tokenSymbol: "$MCAT", quoteSymbol: "WETH", quoteDecimals: 18, usdQuote: false });
    expect(row).toMatchObject({ id: "a", side: "buy", tokenAmount: 5, quoteAmount: 0.01, quoteSymbol: "WETH", tokenSymbol: "$MCAT" });
    expect(row!.usd).toBeUndefined();
    const [usd] = tradeItems([trade("a", { quote: "0xa0b8", quoteAmount: 2_500_000n, quoteDecimals: 6 })], { tokenSymbol: "$MCAT", quoteSymbol: "USDC", quoteDecimals: 6, usdQuote: true });
    expect(usd).toMatchObject({ quoteAmount: 2.5, usd: 2.5 });
  });

  it("formats prices in the quote asset with readable precision", () => {
    expect(formatQuotePrice(0.00004213, "WETH")).toBe("0.00004213 WETH");
    expect(formatQuotePrice(1.274, "USDC")).toBe("1.27 USDC");
    expect(formatQuotePrice(3412.5, "USDC")).toBe("3,412.50 USDC");
  });
});
