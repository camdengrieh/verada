import { describe, expect, it, vi } from "vitest";
import { IndexerClient, toHolderSummary, toMarketSnapshot, toMarketTrade, toTokenDetail } from "@/lib/indexer";

const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const T = "0x00000000000000000000000000000000000000a1";
const A = "0x00000000000000000000000000000000000000b1";
const tx = `0x${"ab".repeat(32)}`;

describe("market client", () => {
  it("reads trades with bigint amounts and passes only token and side", async () => {
    const fn = vi.fn(async (_url: string) =>
      res({
        quote: "0xq",
        quoteDecimals: 18,
        items: [
          { id: `${tx}-3`, side: "buy", trader: A, tokenAmount: "10000000000000000000", quote: "0xq", quoteAmount: "5", quoteDecimals: 18, price: 0.5, timestamp: "1700", txHash: tx },
          { id: "bad", side: "swap", trader: A, timestamp: "1", txHash: tx },
        ],
        nextCursor: "c2",
      }),
    );
    const c = new IndexerClient(["https://a.test"], { fetchImpl: fn as unknown as typeof fetch });
    const page = await c.trades(T, { side: "buy", limit: 10 });
    expect(fn.mock.calls[0]![0]).toBe(`https://a.test/api/tokens/${T}/trades?side=buy&limit=10`);
    expect(page.nextCursor).toBe("c2");
    expect(page.items).toEqual([
      expect.objectContaining({ side: "buy", tokenAmount: 10n ** 19n, quoteAmount: 5n, price: 0.5, timestamp: 1700 }),
    ]);
  });

  it("reads holders, summary and market", async () => {
    const bodies: Record<string, unknown> = {
      holders: { holders: 4, supply: "1000", items: [{ rank: 1, account: A, balance: "600", share: 60, label: "pool" }, { rank: 2, account: T, balance: "1", share: 0.1, label: "whale" }] },
      summary: { holders: 4, newHolders24h: 1, supply: "1000", poolShare: 60, creatorShare: 3, contractShare: 60, top10Share: 40, buckets: [{ label: "1% or more", holders: 3, share: 40 }], history: [{ day: "86400", holders: 3 }] },
      market: { quote: "0xq", quoteDecimals: 6, price: 0.002, lastTradeAt: "99", window: { hours: 24, trades: 4, buys: 3, sells: 1, buyQuote: "30", sellQuote: "10", volumeQuote: "40", buyShare: 75 }, hourly: [{ hour: "0", buys: 3, sells: 1, buyQuote: "30", sellQuote: "10", closePrice: 0.002 }] },
    };
    const fn = vi.fn(async (url: string) =>
      url.includes("/summary") ? res(bodies.summary) : url.includes("/holders") ? res(bodies.holders) : res(bodies.market),
    );
    const c = new IndexerClient(["https://a.test"], { fetchImpl: fn as unknown as typeof fetch });
    const h = await c.holders(T, { exclude: "contracts" });
    expect(h.supply).toBe(1000n);
    expect(h.items.map((x) => x.label)).toEqual(["pool", null]);
    const s = await c.holderSummary(T);
    expect(s).toMatchObject({ holders: 4, top10Share: 40, history: [{ day: 86400, holders: 3 }] });
    const m = await c.market(T, 48);
    expect(fn.mock.calls.at(-1)![0]).toBe(`https://a.test/api/tokens/${T}/market?hours=48`);
    expect(m).toMatchObject({ price: 0.002, window: { buyShare: 75, volumeQuote: 40n }, hourly: [{ hour: 0, buyQuote: 30n }] });
  });

  it("returns null for a token with no holders yet and rejects malformed rows", async () => {
    const c = new IndexerClient(["https://a.test"], { fetchImpl: (async () => res({ error: "not_found" }, 404)) as unknown as typeof fetch });
    expect(await c.holderSummary(T)).toBeNull();
    expect(toMarketTrade({ id: "x", side: "buy" })).toBeNull();
    expect(toHolderSummary({})).toBeNull();
  });

  it("keeps each hour's ticks and the lifetime totals for the chart", () => {
    const m = toMarketSnapshot({
      quote: "0xq",
      quoteDecimals: 18,
      price: 0.5,
      lastTradeAt: "99",
      lifetime: { trades: 7, buys: 5, sells: 2, volumeQuote: "900" },
      window: { hours: 24, trades: 0, buys: 0, sells: 0, buyQuote: "0", sellQuote: "0", volumeQuote: "0", buyShare: null },
      hourly: [
        { hour: "3600", buys: 1, sells: 0, buyQuote: "5", sellQuote: "0", openTick: -69000, highTick: -68900, lowTick: -69000, closeTick: -68900, closePrice: 0.5 },
        { hour: "7200", buys: 1, sells: 0, buyQuote: "5", sellQuote: "0" },
      ],
    });
    expect(m!.lifetime).toEqual({ trades: 7, buys: 5, sells: 2, volumeQuote: 900n });
    expect(m!.hourly[0]).toMatchObject({ hour: 3600, openTick: -69000, highTick: -68900, lowTick: -69000, closeTick: -68900 });
    // Rows from an older indexer carry no ticks.
    expect(m!.hourly[1]).toMatchObject({ openTick: null, closeTick: null });
    expect(toMarketSnapshot({ window: {}, hourly: [] })!.lifetime).toBeNull();
  });

  it("reads a token's fee totals", () => {
    const d = toTokenDetail({ address: T, name: "A", symbol: "A", feeTotals: { token: T, settlementAsset: "0xu", platformAmount: "100", causeAmount: "900", collections: 3, lastCollectedAt: "1700" } });
    expect(d!.feeTotals).toEqual({ platformAmount: "100", causeAmount: "900", collections: 3, lastCollectedAt: 1700 });
    expect(toTokenDetail({ address: T, feeTotals: null })!.feeTotals).toBeNull();
    expect(toTokenDetail({ address: T })!.feeTotals).toBeNull();
  });
});
