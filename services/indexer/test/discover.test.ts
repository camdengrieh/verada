import { describe, expect, it } from "vitest";
import { categoryMaskOf, regionMaskOf } from "@varada/sdk";
import type { Hex } from "viem";
import { readApiConfig } from "../src/api/config";
import {
  type DiscoverSource,
  changeFromTicks,
  filterAndPage,
  joinDiscover,
  priceOf,
} from "../src/api/discover";
import { createApi } from "../src/api/routes";
import type { Repo, TokenRow } from "../src/api/types";

const NOW = 1_800_000_000n;
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" as Hex;
const NVDA = "0x2d1f7226bd1f780af6b9a49dcc0ae00e8df4bdee" as Hex;
const A = "0x00000000000000000000000000000000000000a1" as Hex; // sorts below the quotes: currency0
const B = "0x00000000000000000000000000000000000000a2" as Hex;
const C = "0x00000000000000000000000000000000000000a3" as Hex;
const D = "0xf0000000000000000000000000000000000000a4" as Hex; // sorts above WETH: currency1
const Q96 = 2n ** 96n;
const E18 = 10n ** 18n;

const tok = (address: Hex, i: number, over: Partial<TokenRow> = {}): TokenRow => ({
  address,
  creator: "0x00000000000000000000000000000000000000c1",
  pool: "0x00000000000000000000000000000000000000c1",
  hook: "0x00000000000000000000000000000000000000c1",
  lpTokenId: BigInt(i),
  feeBps: 300,
  donationAsset: 0,
  metadataUri: "bzz://x",
  createdAt: 1_000n + BigInt(i) * 100n,
  createdBlock: BigInt(i),
  txHash: `0x${"0".repeat(63)}${i}` as Hex,
  name: `Coin ${i}`,
  symbol: `C${i}`,
  label: `coin${i}`,
  labelhash: null,
  controller: null,
  editor: null,
  logoRef: null,
  suppressed: false,
  registeredAt: null,
  categoryMask: null,
  regionMask: null,
  ...over,
});

const hour = (token: Hex, h: number, buys: number, sells: number, openTick: number) => ({
  token,
  hour: NOW - BigInt(h) * 3_600n,
  buys,
  sells,
  buyQuote: BigInt(buys) * E18,
  sellQuote: BigInt(sells) * E18,
  openTick,
  closeSqrtPriceX96: Q96,
});

const source = (): DiscoverSource => ({
  tokens: [
    tok(A, 1, { categoryMask: categoryMaskOf(["hunger"]), regionMask: regionMaskOf(["africa"]) }),
    tok(B, 2),
    tok(C, 3, { name: "Rocket Fuel", symbol: "ROCK", label: "rocket" }),
    tok(D, 4),
  ],
  fees: [
    { token: A, causeAmount: 90_000_000n, platformAmount: 10_000_000n, collections: 2 },
    { token: C, causeAmount: 9_000_000n, platformAmount: 1_000_000n, collections: 1 },
  ],
  markets: [
    { token: A, quote: WETH, tokenIsCurrency0: true },
    { token: B, quote: WETH, tokenIsCurrency0: true },
    { token: D, quote: WETH, tokenIsCurrency0: false },
  ],
  quoteDecimals: [
    { asset: WETH, decimals: 18 },
    { asset: NVDA, decimals: 18 },
  ],
  stats: [
    { token: A, trades: 30, lastSqrtPriceX96: Q96, lastTick: 200, lastTradeAt: NOW - 60n },
    { token: B, trades: 3, lastSqrtPriceX96: Q96, lastTick: -100, lastTradeAt: NOW - 3_000n },
    { token: D, trades: 1, lastSqrtPriceX96: Q96, lastTick: 0, lastTradeAt: NOW - 5_000n },
  ],
  hours: [hour(A, 1, 6, 2, 0), hour(A, 2, 4, 0, 100), hour(B, 5, 1, 1, 0)],
  flows: [
    { token: A, buyQuote: 10n * E18, sellQuote: 3n * E18 },
    { token: B, buyQuote: 1n * E18, sellQuote: 2n * E18 },
  ],
  holders: [{ token: A, holders: 12, supply: 100n * E18 }],
  live: [{ token: C, quote: NVDA, initialPeriod: 2 }],
  liveSchedules: [{ token: C, period: 3, hasPending: true, pendingPeriod: 0, switchAt: NOW + 1_000n }],
});

describe("price and change maths", () => {
  it("reads price from the sqrt price", () => {
    expect(priceOf(Q96, true, 18)).toBe(1);
    expect(priceOf(Q96 * 2n, true, 18)).toBeCloseTo(4);
    expect(priceOf(Q96 * 2n, false, 18)).toBeCloseTo(0.25);
    expect(priceOf(0n, true, 18)).toBe(0);
  });
  it("moves with the tick in the direction of the token side", () => {
    expect(changeFromTicks(0, 0, true)).toBe(0);
    expect(changeFromTicks(0, 200, true)).toBeCloseTo(2.02, 1);
    expect(changeFromTicks(0, 200, false)).toBeCloseTo(-1.98, 1);
  });
});

describe("joinDiscover", () => {
  const items = joinDiscover(source(), NOW);
  const by = (a: Hex) => items.find((i) => i.address === a)!;

  it("lists newest first", () => {
    expect(items.map((i) => i.address)).toEqual([D, C, B, A]);
  });
  it("summarises the last 24 hours", () => {
    expect(by(A).market).toMatchObject({ quote: WETH, trades24h: 12, buys24h: 10, sells24h: 2, tradesTotal: 30, holders: 12, volume24hQuote: 12n * E18, price: 1 });
    // first trade in the window opened at tick 100, now 200: +1%
    expect(by(A).market.change24h).toBeCloseTo(1.0, 0);
    expect(by(A).market.quoteInPool).toBe(7n * E18);
  });
  it("never reports a negative pool and leaves unknowns null", () => {
    expect(by(B).market.quoteInPool).toBe(0n);
    expect(by(B).market.holders).toBeNull();
    expect(by(D).market).toMatchObject({ trades24h: 0, change24h: null });
  });
  it("carries raised USDC and the focus", () => {
    expect(by(A).raised).toBe(90_000_000n);
    expect(by(A).focus).toMatchObject({ categories: ["hunger"], regions: ["africa"] });
    expect(by(B).focus).toBeNull();
    expect(by(B).raised).toBe(0n);
  });
  it("derives the mode and the live quote before any trade", () => {
    expect(by(A).mode).toEqual({ kind: "weekly" });
    expect(by(C).mode).toEqual({ kind: "live", period: 3, periodSeconds: 259_200 });
    expect(by(C).market.quote).toBe(NVDA);
    expect(by(C).market.price).toBeNull();
  });
  it("applies a pending period change once it has taken effect", () => {
    const later = joinDiscover(source(), NOW + 2_000n).find((i) => i.address === C)!;
    expect(later.mode).toEqual({ kind: "live", period: 0, periodSeconds: 3_600 });
  });
});

describe("filterAndPage", () => {
  const items = joinDiscover(source(), NOW);
  const base = { sort: "trending" as const, offset: 0, limit: 10 };
  const addrs = (q: Partial<Parameters<typeof filterAndPage>[1]>) => filterAndPage(items, { ...base, ...q }).items.map((i) => i.address);

  it("ranks trending by 24h trades, then buys, then newest", () => {
    expect(addrs({})).toEqual([A, B, D, C]);
  });
  it("sorts new, raised, holders and change", () => {
    expect(addrs({ sort: "new" })).toEqual([D, C, B, A]);
    expect(addrs({ sort: "raised" })).toEqual([A, C, D, B]);
    expect(addrs({ sort: "holders" })[0]).toBe(A);
    expect(addrs({ sort: "change" })[0]).toBe(A);
  });
  it("filters by mode and quote", () => {
    expect(addrs({ mode: "live" })).toEqual([C]);
    expect(addrs({ mode: "weekly" })).toHaveLength(3);
    expect(addrs({ periods: [3] })).toEqual([C]);
    expect(addrs({ periods: [0, 1] })).toEqual([]);
    expect(addrs({ quotes: [WETH] })).toEqual([A, B, D]);
    expect(addrs({ quotes: [NVDA] })).toEqual([C]);
  });
  it("filters by focus overlap; a token without a focus counts as any", () => {
    expect(addrs({ categoryMask: categoryMaskOf(["hunger"]) })).toEqual([A, B, D, C]);
    expect(addrs({ categoryMask: categoryMaskOf(["cancer-research"]) })).toEqual([B, D, C]);
    expect(addrs({ regionMask: regionMaskOf(["europe"]) })).toEqual([B, D, C]);
  });
  it("matches name, symbol and label, ignoring the dollar sign", () => {
    expect(addrs({ q: "rock" })).toEqual([C]);
    expect(addrs({ q: "$c2" })).toEqual([B]);
    expect(addrs({ q: "zzz" })).toEqual([]);
  });
  it("reads a bulk list of tokens", () => {
    expect(addrs({ tokens: [B, D] })).toEqual([B, D]);
  });
  it("pages with an offset and reports the total", () => {
    const p1 = filterAndPage(items, { ...base, limit: 3 });
    expect(p1).toMatchObject({ total: 4, nextOffset: 3 });
    const p2 = filterAndPage(items, { ...base, limit: 3, offset: 3 });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextOffset).toBeNull();
  });
});

describe("GET /api/discover", () => {
  const mk = (withDiscover = true) =>
    createApi({
      repo: {} as Repo,
      search: { search: async () => [] },
      config: readApiConfig({}),
      discover: withDiscover ? { items: async () => joinDiscover(source(), NOW) } : undefined,
      now: () => Number(NOW) * 1000,
    });

  it("returns items with string bigints, a cursor and a total", async () => {
    const body = await (await mk().request("/api/discover?sort=new&limit=2")).json();
    expect(body.total).toBe(4);
    expect(body.items.map((i: { address: string }) => i.address)).toEqual([D, C]);
    expect(body.items[1].market.volume24hQuote).toBe("0");
    const next = await (await mk().request(`/api/discover?sort=new&limit=2&cursor=${body.nextCursor}`)).json();
    expect(next.items.map((i: { address: string }) => i.address)).toEqual([B, A]);
    expect(next.nextCursor).toBeNull();
    const a = next.items[1];
    expect(a.raised).toBe("90000000");
    expect(a.market.quoteInPool).toBe((7n * E18).toString());
  });
  it("filters by category and region slugs, mode and quote", async () => {
    const r = await (await mk().request(`/api/discover?categories=cancer-research&regions=europe&mode=weekly&quotes=${WETH}`)).json();
    expect(r.items.map((i: { address: string }) => i.address)).toEqual([B, D]);
  });
  it("filters live tokens by rotation period", async () => {
    const r = await (await mk().request("/api/discover?mode=live&periods=3,4")).json();
    expect(r.items.map((i: { address: string }) => i.address)).toEqual([C]);
  });
  it("reads tokens in bulk", async () => {
    const r = await (await mk().request(`/api/discover?tokens=${A},${C}`)).json();
    expect(r.items.map((i: { address: string }) => i.address).sort()).toEqual([A, C]);
  });
  it("rejects bad input", async () => {
    const app = mk();
    expect((await app.request("/api/discover?sort=moon")).status).toBe(400);
    expect((await app.request("/api/discover?periods=7")).status).toBe(400);
    expect((await app.request("/api/discover?categories=nope")).status).toBe(400);
    expect((await app.request("/api/discover?quotes=0x12")).status).toBe(400);
    expect((await app.request("/api/discover?tokens=abc")).status).toBe(400);
    expect((await app.request("/api/discover?cursor=bad")).status).toBe(400);
    expect((await app.request("/api/discover?limit=500")).status).toBe(400);
  });
  it("answers 503 without a discover repo and never takes a viewer address", async () => {
    expect((await mk(false).request("/api/discover")).status).toBe(503);
    const r = await (await mk().request("/api/discover?trader=0x00000000000000000000000000000000000000b1&limit=1")).json();
    expect(r.total).toBe(4);
  });
});
