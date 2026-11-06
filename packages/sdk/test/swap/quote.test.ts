import { describe, expect, it } from "vitest";
import { QUOTE_CONCURRENCY, SwapError, USDC, WETH, enumerateRoutes, pickBestQuote, quoteRoute, routeMidPrice, type PoolState } from "../../src/index.js";
import { fakePool } from "./helpers.js";

const weth = WETH.address;
const pools: PoolState[] = Array.from({ length: 10 }, (_, i) => fakePool(weth, USDC.address, 100 + i * 50, 1 + i, BigInt(10 + i)));
const routes = enumerateRoutes(pools, weth, USDC.address, { weth, poolsPerPair: 10, maxCandidates: 10 });
const states = new Map(pools.map((p) => [p.poolId, p]));
const ctx = { tokenIn: WETH, tokenOut: USDC, states };

describe("pickBestQuote", () => {
  it("quotes at most QUOTE_CONCURRENCY routes at once and keeps input order of results", async () => {
    let inFlight = 0;
    let peak = 0;
    const client = {
      readContract: async (a: { args: [{ poolKey: { fee: number } }] }) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return [BigInt(1_000_000 + a.args[0].poolKey.fee), 1n];
      },
    };
    expect(routes).toHaveLength(10);
    const { best, all } = await pickBestQuote(client as never, routes, "exactIn", 10n ** 18n, ctx);
    expect(peak).toBeLessThanOrEqual(QUOTE_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
    expect(all).toHaveLength(10);
    expect(best.amountOut).toBe(1_000_000n + 100n + 9n * 50n); // highest fee value wins in this fake
    expect(all.map((q) => q.amountOut)).toEqual([...all.map((q) => q.amountOut)].sort((a, b) => (a < b ? 1 : -1)));
  });

  it("picks the lowest input for exact-out", async () => {
    const client = { readContract: async (a: { args: [{ poolKey: { fee: number } }] }) => [BigInt(5_000 - a.args[0].poolKey.fee), 1n] };
    const { best } = await pickBestQuote(client as never, routes, "exactOut", 10n ** 6n, ctx);
    expect(best.amountIn).toBe(5_000n - (100n + 9n * 50n));
  });

  it("survives failing routes and reports the most specific error when all fail", async () => {
    const flaky = { readContract: async (a: { args: [{ poolKey: { fee: number } }] }) => { if (a.args[0].poolKey.fee > 200) throw new Error("revert 0x7a5ed734"); return [7n, 1n]; } };
    const ok = await pickBestQuote(flaky as never, routes, "exactIn", 1n, ctx);
    expect(ok.all.length).toBe(3);
    expect(ok.failures.length).toBe(7);
    expect(ok.failures[0]!.error.reason).toBe("insufficient-liquidity");

    const dead = { readContract: async () => { throw new Error("execution reverted: PoolNotInitialized 0x486aa307"); } };
    await expect(pickBestQuote(dead as never, routes, "exactIn", 1n, ctx)).rejects.toMatchObject({ reason: "pool-not-initialized" });
    await expect(pickBestQuote(dead as never, [], "exactIn", 1n, ctx)).rejects.toMatchObject({ reason: "no-route" });
  });
});

describe("quoteRoute", () => {
  it("rejects zero and oversized amounts before calling the quoter", async () => {
    const client = { readContract: async () => { throw new Error("must not be called"); } };
    await expect(quoteRoute(client as never, routes[0]!, "exactIn", 0n, ctx)).rejects.toMatchObject({ reason: "zero-amount" });
    await expect(quoteRoute(client as never, routes[0]!, "exactIn", 1n << 128n, ctx)).rejects.toBeInstanceOf(SwapError);
  });

  it("fails when a pool state is missing", async () => {
    const client = { readContract: async () => [5n, 1n] };
    await expect(quoteRoute(client as never, routes[0]!, "exactIn", 1000n, { ...ctx, states: new Map() })).rejects.toMatchObject({ reason: "pool-not-initialized" });
  });

  it("uses the pool's own lpFee when there is no override and the override when given", async () => {
    const client = { readContract: async () => [999_000n, 1n] };
    const route = routes[0]!;
    const poolId = (route.steps[0] as { poolId: `0x${string}` }).poolId;
    const a = await quoteRoute(client as never, route, "exactIn", 1_000_000n, ctx);
    const b = await quoteRoute(client as never, route, "exactIn", 1_000_000n, { ...ctx, feeBps: new Map([[poolId, 500]]) });
    expect(a.totalFeePct).toBeCloseTo((states.get(poolId)!.lpFee / 1_000_000) * 100, 8);
    expect(b.totalFeePct).toBeCloseTo(5, 8);
    // the same output shows less impact when more of the shortfall is explained by the fee
    expect(b.priceImpactPct).toBeLessThanOrEqual(a.priceImpactPct);
  });
});

describe("routeMidPrice", () => {
  it("multiplies the mids along the route and ignores wrap steps", () => {
    const [route] = enumerateRoutes(pools, weth, USDC.address, { weth });
    const mid = routeMidPrice(route!, states, 18, 6)!;
    expect(mid).toBeCloseTo(1e12, 0); // sqrtPrice 2^96 => raw price 1; 18 -> 6 decimals scales it by 10^12
    expect(routeMidPrice(route!, new Map(), 18, 6)).toBeNull();
  });
});
