import { describe, expect, it } from "vitest";
import { EXTERNAL_ADDRESSES, ONDO_TOKENS } from "@varada/sdk";
import { toDiscoverToken, discoverParams, type DiscoverToken } from "@/lib/discover-client";
import {
  buildQuery,
  cadenceOf,
  causeChipOf,
  causeNameOf,
  givingOf,
  maxRaisedOf,
  parseState,
  stateToSearch,
  stocksTabEmpty,
  toCardToken,
  DEFAULT_STATE,
  type CardContext,
} from "@/lib/discover";
import { quoteAssetsFromRows } from "@/lib/quote-assets";

const E18 = 10n ** 18n;
const assets = quoteAssetsFromRows(
  [
    { asset: EXTERNAL_ADDRESSES.weth, kind: 0, active: true, decimals: 18 },
    { asset: ONDO_TOKENS.NVDAon.address, kind: 1, active: true, decimals: 18 },
    { asset: ONDO_TOKENS.SPYon.address, kind: 1, active: true, decimals: 18 },
  ],
  () => undefined,
);

const raw = {
  address: "0x00000000000000000000000000000000000000a1",
  name: "Harambe",
  symbol: "HARAMBE",
  label: "harambe",
  logoRef: "0x" + "ab".repeat(32),
  createdAt: 1000,
  feeBps: 300,
  focus: { categories: ["endangered-species"], regions: ["africa"] },
  raised: "12400000",
  mode: { kind: "live", period: 2, periodSeconds: 86400 },
  market: {
    quote: EXTERNAL_ADDRESSES.weth,
    quoteDecimals: 18,
    price: 0.00000412,
    change24h: 18.42,
    volume24hQuote: (12n * E18).toString(),
    trades24h: 40,
    buys24h: 30,
    sells24h: 10,
    tradesTotal: 90,
    lastTradeAt: 1990,
    quoteInPool: (5n * E18).toString(),
    holders: 120,
    supply: (100_000_000_000n * E18).toString(),
  },
};

describe("toDiscoverToken", () => {
  it("maps the indexer item and keeps bigints exact", () => {
    const t = toDiscoverToken(raw)!;
    expect(t).toMatchObject({ name: "Harambe", label: "harambe", raised: 12_400_000n, mode: { kind: "live", periodSeconds: 86400 } });
    expect(t.market).toMatchObject({ price: 0.00000412, change24h: 18.42, volume24hQuote: 12n * E18, holders: 120, quoteInPool: 5n * E18 });
    expect(t.market!.supply).toBe(100_000_000_000n * E18);
  });
  it("tolerates missing parts and drops an all-zero logo", () => {
    const t = toDiscoverToken({ address: "0xabc", logoRef: "0x" + "0".repeat(64) })!;
    expect(t).toMatchObject({ name: "", label: null, logoRef: null, mode: { kind: "weekly" }, market: null, raised: 0n, focus: null });
    expect(toDiscoverToken({ name: "no address" })).toBeNull();
    expect(toDiscoverToken(null)).toBeNull();
  });
  it("writes request parameters", () => {
    expect(discoverParams({ sort: "new", quotes: ["0xa", "0xb"], categories: ["hunger"], q: " rock ", limit: 24 })).toEqual({
      sort: "new",
      mode: undefined,
      periods: undefined,
      quotes: "0xa,0xb",
      categories: "hunger",
      regions: undefined,
      q: "rock",
      tokens: undefined,
      cursor: undefined,
      limit: 24,
    });
  });
});

describe("URL state", () => {
  it("round-trips and omits defaults", () => {
    expect(stateToSearch(DEFAULT_STATE)).toBe("");
    const s = { tab: "stocks" as const, pair: "NVDAon", category: "hunger", region: "africa", mode: "weekly" as const, cadence: null, q: " moon " };
    expect(parseState(stateToSearch(s))).toEqual({ ...s, q: "moon" });
  });
  it("ignores unknown values", () => {
    expect(parseState("?tab=moon&category=nope&region=mars&mode=x")).toEqual(DEFAULT_STATE);
  });
  it("leaves mode out for the live tab, which implies it", () => {
    expect(stateToSearch({ ...DEFAULT_STATE, tab: "live", mode: "live" })).toBe("?tab=live");
    expect(parseState("?tab=live&cadence=12h").cadence).toBe("12h");
    expect(stateToSearch({ ...DEFAULT_STATE, tab: "live", cadence: "72h" })).toBe("?tab=live&cadence=72h");
  });
});

describe("buildQuery", () => {
  it("trending and new sort the whole list", () => {
    expect(buildQuery(DEFAULT_STATE, assets)).toMatchObject({ sort: "trending", limit: 24 });
    expect(buildQuery({ ...DEFAULT_STATE, tab: "new" }, assets).sort).toBe("new");
  });
  it("stocks lists every non-crypto pair, or the picked one", () => {
    const all = buildQuery({ ...DEFAULT_STATE, tab: "stocks" }, assets);
    expect(all.quotes).toEqual([ONDO_TOKENS.NVDAon.address, ONDO_TOKENS.SPYon.address]);
    const one = buildQuery({ ...DEFAULT_STATE, tab: "stocks", pair: "SPYon" }, assets);
    expect(one.quotes).toEqual([ONDO_TOKENS.SPYon.address]);
  });
  it("a crypto pair filters by that asset on any tab", () => {
    expect(buildQuery({ ...DEFAULT_STATE, pair: "WETH" }, assets).quotes).toEqual([EXTERNAL_ADDRESSES.weth]);
  });
  it("by cause ranks by raised until a category is picked, and live implies the mode", () => {
    expect(buildQuery({ ...DEFAULT_STATE, tab: "cause" }, assets).sort).toBe("raised");
    expect(buildQuery({ ...DEFAULT_STATE, tab: "cause", category: "hunger", region: "asia" }, assets)).toMatchObject({ sort: "trending", categories: ["hunger"], regions: ["asia"] });
    expect(buildQuery({ ...DEFAULT_STATE, tab: "live" }, assets).mode).toBe("live");
    expect(buildQuery({ ...DEFAULT_STATE, tab: "live", cadence: "24h" }, assets).periods).toEqual([2]);
    expect(buildQuery({ ...DEFAULT_STATE, mode: "weekly" }, assets).mode).toBe("weekly");
  });
  it("passes the page cursor", () => {
    expect(buildQuery(DEFAULT_STATE, assets, { cursor: "abc", limit: 12 })).toMatchObject({ cursor: "abc", limit: 12 });
  });
  it("flags a Stocks tab with no stock pair rather than matching every token", () => {
    expect(stocksTabEmpty({ ...DEFAULT_STATE, tab: "stocks" }, assets.filter((a) => a.kind === "crypto"))).toBe(true);
    expect(stocksTabEmpty({ ...DEFAULT_STATE, tab: "stocks" }, assets)).toBe(false);
  });
});

describe("card data", () => {
  const ctx: CardContext = { parent: "varada.eth", assets, logo: (ref) => (ref ? { src: `gw/${ref}` } : undefined), maxRaised: 24_800_000n };
  const t = toDiscoverToken(raw)!;
  it("names rows in the quote asset and USDC raised", () => {
    const c = toCardToken(t, ctx);
    expect(c).toMatchObject({
      name: "Harambe",
      symbol: "HARAMBE",
      ens: "harambe.varada.eth",
      change24h: 18.42,
      giving: { mode: "live", cadence: "24h" },
      quote: { symbol: "WETH", kind: "crypto" },
      cause: "wildlife",
      volume24h: "12 WETH",
      liquidity: "5 WETH",
      raised: "$12.4",
      raisedPct: 50,
    });
    expect(c.marketCap).toBe("412K WETH");
    expect(c.art?.src).toContain("gw/0x");
  });
  it("shows dashes instead of inventing numbers", () => {
    const bare = toDiscoverToken({ address: "0xabc", name: "New", symbol: "NEW" })!;
    const c = toCardToken(bare, { ...ctx, maxRaised: 0n });
    expect(c).toMatchObject({ change24h: null, marketCap: "–", volume24h: "–", liquidity: "–", raised: "$0", raisedPct: 0, ens: "0xabc" });
  });
  it("tones the card by pair kind", () => {
    const stock = toDiscoverToken({ ...raw, market: { ...raw.market, quote: ONDO_TOKENS.NVDAon.address } })!;
    expect(toCardToken(stock, ctx)).toMatchObject({ wash: "sky", quote: { symbol: "NVDAon", kind: "stock" } });
  });
});

describe("helpers", () => {
  it("maps rotation seconds to the library cadence", () => {
    expect([3600, 43200, 86400, 259200, 604800, 1].map(cadenceOf)).toEqual(["1h", "12h", "24h", "72h", "week", "week"]);
    expect(givingOf({ mode: { kind: "weekly" } })).toEqual({ mode: "weekly" });
  });
  it("maps catalogue slugs to the library's cause names", () => {
    expect(causeNameOf("disaster-relief")).toBe("disaster");
    expect(causeNameOf("endangered-species")).toBe("wildlife");
    expect(causeNameOf("nope")).toBe("other");
  });
  it("labels multi-category focus honestly", () => {
    expect(causeChipOf({ categories: ["hunger"], regions: [] })).toEqual({ cause: "hunger" });
    expect(causeChipOf({ categories: ["hunger", "cancer-research"], regions: [] })).toEqual({ cause: "hunger", label: "2 causes" });
    expect(causeChipOf({ categories: [], regions: [] })).toEqual({ cause: "other", label: "Any cause" });
    expect(causeChipOf(null)).toEqual({ cause: "other", label: "Any cause" });
  });
  it("finds the leader on a page", () => {
    const rows = [{ raised: 1n }, { raised: 7n }] as DiscoverToken[];
    expect(maxRaisedOf(rows)).toBe(7n);
    expect(maxRaisedOf([])).toBe(0n);
  });
});
