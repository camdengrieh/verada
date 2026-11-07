import { describe, expect, it } from "vitest";
import { EXTERNAL_ADDRESSES, ONDO_TOKENS, makeUsdQuote } from "@varada/sdk";
import { formatQuoteAsUsd, formatUsdValue } from "@/lib/format";
import { mergeUsdQuotes, ondoMarketClosed, registryUsdQuotes, stableUsdQuote } from "@/lib/usd-pricing";
import { formatUsdPrice, pressureWindows, tradeItems } from "@/lib/token-market";
import { quoteAmountText } from "@/lib/discover";
import { pairOrder } from "@/components/discover/filters";
import type { AppQuoteAsset } from "@/lib/quote-assets";
import type { MarketTrade } from "@/lib/indexer";

const WETH = EXTERNAL_ADDRESSES.weth;
const USDC = EXTERNAL_ADDRESSES.usdc;
const NVDA = ONDO_TOKENS.NVDAon.address;
// Wednesday 2026-11-04 15:00 UTC = 10:00 New York (open); Saturday 2026-11-07 15:00 UTC (closed)
const OPEN = new Date("2026-11-04T15:00:00Z");
const CLOSED = new Date("2026-11-07T15:00:00Z");

const asset = (p: Partial<AppQuoteAsset> & { address: string; symbol: string }): AppQuoteAsset => ({ name: p.symbol, kind: "crypto", decimals: 18, launchable: { ok: true }, ...p }) as AppQuoteAsset;

describe("registry quotes", () => {
  it("turns the route price and depth read onto the assets into USD quotes", () => {
    const m = registryUsdQuotes([
      asset({ address: WETH, symbol: "WETH", price: 3000, routeDepthUsd: 5_000_000, route: ["WETH", "USDC"] }),
      asset({ address: NVDA, symbol: "NVDAon", kind: "stock", price: 180, routeDepthUsd: 2_000 }),
      asset({ address: "0x00000000000000000000000000000000000000aa", symbol: "NOPRICE" }),
    ]);
    expect(m.get(WETH.toLowerCase())).toMatchObject({ priceUsd: 3000, confidence: "high", source: "registry" });
    expect(m.get(NVDA.toLowerCase())).toMatchObject({ priceUsd: 180, confidence: "low" });
    expect(m.size).toBe(2);
  });
});

describe("merge", () => {
  const reg = registryUsdQuotes([asset({ address: NVDA, symbol: "NVDAon", kind: "stock", price: 180, routeDepthUsd: 50_000 })]);

  it("stablecoins are $1 regardless of sources", () => {
    const m = mergeUsdQuotes([USDC], new Map(), new Map(), OPEN);
    expect(m.get(USDC.toLowerCase())).toMatchObject({ priceUsd: 1, source: "stable", confidence: "high" });
  });

  it("falls back to a discovered route when the registry has none", () => {
    const disc = new Map([[WETH.toLowerCase(), makeUsdQuote(WETH, "discovered", ["WETH", "USDC"], { priceUsd: 3000, depthUsd: 9e6 })]]);
    expect(mergeUsdQuotes([WETH], new Map(), disc, OPEN).get(WETH.toLowerCase())?.source).toBe("discovered");
  });

  it("flags an Ondo stock as market-closed outside the session, not during it", () => {
    expect(mergeUsdQuotes([NVDA], reg, new Map(), CLOSED).get(NVDA.toLowerCase())?.marketClosed).toBe(true);
    expect(mergeUsdQuotes([NVDA], reg, new Map(), OPEN).get(NVDA.toLowerCase())?.marketClosed).toBeUndefined();
    expect(ondoMarketClosed(WETH, CLOSED)).toBe(false);
  });

  it("leaves an unpriced asset unpriced", () => {
    expect(mergeUsdQuotes([NVDA], new Map(), new Map(), OPEN).get(NVDA.toLowerCase())?.priceUsd).toBeNull();
  });
});

describe("display", () => {
  const thin = makeUsdQuote(NVDA, "registry", [], { priceUsd: 200, depthUsd: 1_000 });
  const firm = makeUsdQuote(WETH, "registry", [], { priceUsd: 3000, depthUsd: 9e6 });

  it("formats dollars, with ~ for thin or closed prices", () => {
    expect(formatUsdValue(1200, false)).toBe("$1.2K");
    expect(formatUsdValue(1200, true)).toBe("~$1.2K");
    expect(formatQuoteAsUsd(2, "WETH", firm)).toBe("$6K");
    expect(formatQuoteAsUsd(2, "NVDAon", thin)).toBe("~$400");
    expect(formatQuoteAsUsd(2, "NVDAon", { ...firm, marketClosed: true })).toBe("~$6K");
    expect(formatQuoteAsUsd(2, "WETH", undefined)).toBe("2 WETH");
    expect(formatUsdPrice(0.00004213, true)).toBe("~$0.00004213");
    expect(formatUsdPrice(1.2345)).toBe("$1.23");
  });

  it("discover cards show dollars when the quote is priced and quote units when not", () => {
    const usd = (a: string | null | undefined) => (a?.toLowerCase() === WETH.toLowerCase() ? firm : undefined);
    expect(quoteAmountText(0.5, "WETH", WETH, { usd })).toBe("$1.5K");
    expect(quoteAmountText(0.5, "NVDAon", NVDA, { usd })).toBe("0.5 NVDAon");
  });

  it("trade rows and pressure windows use the quote's USD price (decimals 6 and 18)", () => {
    const trade = (id: string, quoteAmount: bigint, dec: number): MarketTrade => ({
      id,
      side: "buy",
      trader: "0x0000000000000000000000000000000000000001",
      tokenAmount: 10n ** 18n,
      quote: WETH,
      quoteAmount,
      quoteDecimals: dec,
      price: 1,
      timestamp: 1,
      txHash: "0x01",
    });
    const items = tradeItems([trade("a", 5n * 10n ** 17n, 18), trade("b", 2_500_000n, 6)], { tokenSymbol: "$X", quoteSymbol: "Q", quoteDecimals: 18, usdQuote: false, usd: thin });
    expect(items[0]!.usd).toBeCloseTo(100, 6);
    expect(items[0]!.usdApprox).toBe(true);
    expect(items[1]!.usd).toBeCloseTo(500, 6);
    const firmItems = tradeItems([trade("a", 10n ** 18n, 18)], { tokenSymbol: "$X", quoteSymbol: "WETH", quoteDecimals: 18, usdQuote: false, usd: firm });
    expect(firmItems[0]!.usd).toBe(3000);
    expect(firmItems[0]!.usdApprox).toBeUndefined();
    const usdc = tradeItems([trade("a", 2_500_000n, 6)], { tokenSymbol: "$X", quoteSymbol: "USDC", quoteDecimals: 6, usdQuote: true, usd: stableUsdQuote(USDC) });
    expect(usdc[0]!.usd).toBeCloseTo(2.5, 6);
    const w = pressureWindows([{ hour: 3600 * 100, buys: 1, sells: 0, buyQuote: 10n ** 18n, sellQuote: 0n } as never], 18, 3600 * 101, 3000);
    expect(w[0]!.buyVolumeUsd).toBe(3000);
  });
});

describe("pair order", () => {
  it("lists crypto first, then tokenized assets deepest pool first", () => {
    const list = [
      { kind: "stock" as const, symbol: "BBon", routeDepthUsd: 10 },
      { kind: "stock" as const, symbol: "AAon", routeDepthUsd: 900 },
      { kind: "crypto" as const, symbol: "WETH", routeDepthUsd: 1 },
      { kind: "etf" as const, symbol: "SPYon", routeDepthUsd: undefined },
    ];
    expect(pairOrder(list).map((a) => a.symbol)).toEqual(["WETH", "AAon", "BBon", "SPYon"]);
  });
});
