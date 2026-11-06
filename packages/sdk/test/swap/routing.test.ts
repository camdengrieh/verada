import { describe, expect, it } from "vitest";
import { ETH, NATIVE_CURRENCY, USDC, USDT, WETH, describeRoute, enumerateRoutes, estimateRoute, rankRoutes, poolHops, segmentRoute, varadaPoolKey, candidatePoolKeys, routingNodes, DEFAULT_FEE_TIERS, poolIdOf, type PoolState } from "../../src/index.js";
import { HOOK, OTHER, TOKEN, fakePool } from "./helpers.js";

const weth = WETH.address;
const tokenPool: PoolState = { ...fakePool(TOKEN, weth, 0x800000, 200, 10n ** 18n, { hooks: HOOK }) };

describe("enumerateRoutes", () => {
  it("buys a WETH-quoted token with ETH through the free wrap edge", () => {
    const routes = enumerateRoutes([tokenPool], NATIVE_CURRENCY, TOKEN, { weth });
    expect(routes).toHaveLength(1);
    expect(routes[0]!.steps.map((s) => s.kind)).toEqual(["wrap", "pool"]);
    expect(poolHops(routes[0]!)).toBe(1);
  });

  it("buys with WETH directly and sells back to ETH with an unwrap", () => {
    const buy = enumerateRoutes([tokenPool], weth, TOKEN, { weth });
    expect(buy[0]!.steps.map((s) => s.kind)).toEqual(["pool"]);
    const sell = enumerateRoutes([tokenPool], TOKEN, NATIVE_CURRENCY, { weth });
    expect(sell[0]!.steps.map((s) => s.kind)).toEqual(["pool", "unwrap"]);
  });

  it("finds multi-hop routes through hubs and sorts shortest first", () => {
    const ethUsdc = fakePool(NATIVE_CURRENCY, USDC.address, 500, 10, 5n * 10n ** 15n);
    const wethUsdc = fakePool(weth, USDC.address, 500, 10, 3n * 10n ** 15n);
    const routes = enumerateRoutes([tokenPool, ethUsdc, wethUsdc], USDC.address, TOKEN, { weth });
    // USDC -> WETH -> token  (1 + 1 hops) and USDC -> ETH -> wrap -> WETH -> token
    expect(routes.map((r) => poolHops(r))).toEqual([2, 2]);
    expect(routes[0]!.steps.map((s) => s.kind)).toEqual(["pool", "pool"]);
    expect(routes[1]!.steps.map((s) => s.kind)).toEqual(["pool", "wrap", "pool"]);
  });

  it("does not use pools without liquidity or uninitialized pools", () => {
    const dead = { ...fakePool(weth, USDC.address, 500, 10, 0n) };
    const uninit = { ...fakePool(weth, USDT.address, 500, 10, 10n), initialized: false };
    expect(enumerateRoutes([tokenPool, dead, uninit], USDC.address, TOKEN, { weth })).toEqual([]);
    expect(enumerateRoutes([tokenPool, dead, uninit], USDT.address, TOKEN, { weth })).toEqual([]);
  });

  it("limits routes to three pool hops and never revisits a currency", () => {
    const chain = [fakePool(USDC.address, USDT.address, 100, 1, 10n), fakePool(USDT.address, OTHER, 100, 1, 10n), fakePool(OTHER, weth, 100, 1, 10n), tokenPool];
    // USDC -> USDT -> OTHER -> WETH -> token is four pool hops
    expect(enumerateRoutes(chain, USDC.address, TOKEN, { weth })).toEqual([]);
    expect(enumerateRoutes(chain, USDC.address, TOKEN, { weth, maxHops: 4 })).toEqual([]); // capped at 3
    expect(enumerateRoutes(chain, USDT.address, TOKEN, { weth })).toHaveLength(1);
  });

  it("keeps only the deepest pools of a pair", () => {
    const a = fakePool(weth, USDC.address, 100, 1, 1n);
    const b = fakePool(weth, USDC.address, 500, 10, 30n);
    const c = fakePool(weth, USDC.address, 3000, 60, 20n);
    const routes = enumerateRoutes([tokenPool, a, b, c], USDC.address, TOKEN, { weth, poolsPerPair: 2 });
    const fees = routes.map((r) => (r.steps[0] as { key: { fee: number } }).key.fee).sort((x, y) => x - y);
    expect(fees).toEqual([500, 3000]);
  });

  it("returns nothing for identical endpoints", () => {
    expect(enumerateRoutes([tokenPool], weth, weth, { weth })).toEqual([]);
  });

  it("orients each pool step by currency order", () => {
    const [r] = enumerateRoutes([tokenPool], weth, TOKEN, { weth });
    const step = r!.steps[0]!;
    expect(step.kind === "pool" && step.zeroForOne).toBe(weth.toLowerCase() < TOKEN.toLowerCase());
    const [s] = enumerateRoutes([tokenPool], TOKEN, weth, { weth });
    expect(s!.steps[0]!.kind === "pool" && (s!.steps[0] as { zeroForOne: boolean }).zeroForOne).toBe(TOKEN.toLowerCase() < weth.toLowerCase());
  });
});

describe("segments, labels and candidates", () => {
  it("splits a route at wrap steps", () => {
    const ethUsdc = fakePool(NATIVE_CURRENCY, USDC.address, 500, 10, 10n);
    const wethUsdc = fakePool(weth, USDC.address, 500, 10, 10n);
    const routes = enumerateRoutes([tokenPool, ethUsdc, wethUsdc], USDC.address, TOKEN, { weth });
    const viaWrap = routes.find((r) => r.steps.some((s) => s.kind === "wrap"))!;
    expect(segmentRoute(viaWrap).map((s) => s.kind)).toEqual(["v4", "wrap", "v4"]);
  });

  it("describes a route with symbols", () => {
    const [r] = enumerateRoutes([tokenPool], NATIVE_CURRENCY, TOKEN, { weth });
    const sym = (a: string) => (a === NATIVE_CURRENCY ? "ETH" : a === weth ? "WETH" : "$TKN");
    expect(describeRoute(r!, sym)).toBe("ETH > WETH > $TKN");
  });

  it("generates every hub pair in every tier once", () => {
    const nodes = routingNodes({}, [USDC.address, ETH.address]);
    expect(nodes).toHaveLength(6); // endpoints are already hubs
    const keys = candidatePoolKeys(nodes);
    expect(keys).toHaveLength((6 * 5 / 2) * DEFAULT_FEE_TIERS.length);
    expect(new Set(keys.map(poolIdOf)).size).toBe(keys.length);
  });

  it("pairs satellites with the core hubs only, so reads stay linear", () => {
    const nodes = [USDC.address, weth, OTHER, TOKEN];
    const keys = candidatePoolKeys(nodes, DEFAULT_FEE_TIERS, [USDC.address, weth]);
    expect(keys).toHaveLength(5 * DEFAULT_FEE_TIERS.length); // USDC/WETH, USDC/x, WETH/x for two satellites
    const ids = new Set(keys.map(poolIdOf));
    expect(ids.has(poolIdOf(candidatePoolKeys([OTHER, TOKEN])[0]!))).toBe(false); // no satellite / satellite pool
    expect(candidatePoolKeys(nodes)).toHaveLength(6 * DEFAULT_FEE_TIERS.length); // without a core: every pair
  });

  it("builds the Varada pool key used by the engine", () => {
    expect(varadaPoolKey(TOKEN, weth, HOOK).hooks.toLowerCase()).toBe(HOOK);
  });
});

describe("estimateRoute and rankRoutes", () => {
  // price 1 (sqrtPrice 2^96): virtual reserves of a pool with liquidity L are L on each side
  const deep = fakePool(weth, USDC.address, 500, 10, 10n ** 12n, { lpFee: 0 });
  const shallow = fakePool(weth, USDC.address, 3000, 60, 10n ** 6n, { lpFee: 0 });
  const states = new Map([deep, shallow].map((p) => [p.poolId, p]));
  const routes = enumerateRoutes([deep, shallow], weth, USDC.address, { weth, poolsPerPair: 2 });

  it("matches constant product on the pool's virtual reserves", () => {
    const route = routes.find((r) => (r.steps[0] as { poolId: string }).poolId === deep.poolId)!;
    // reserves 1e12 each: swapping 1e11 gets 1e12 * 1e11 / (1e12 + 1e11)
    expect(estimateRoute(route, states, 10n ** 11n, "exactIn")).toBeCloseTo((1e12 * 1e11) / 1.1e12, 0);
    // exact-out inverse: to take 1e11 out you pay 1e12 * 1e11 / (1e12 - 1e11)
    expect(estimateRoute(route, states, 10n ** 11n, "exactOut")).toBeCloseTo((1e12 * 1e11) / 0.9e12, 0);
    expect(estimateRoute(route, states, 10n ** 12n, "exactOut")).toBe(Number.POSITIVE_INFINITY);
  });

  it("charges the pool fee, or the override for a hook pool", () => {
    const fee = fakePool(weth, USDC.address, 10_000, 200, 10n ** 12n, { lpFee: 10_000 }); // 1%
    const r = enumerateRoutes([fee], weth, USDC.address, { weth })[0]!;
    const st = new Map([[fee.poolId, fee]]);
    expect(estimateRoute(r, st, 10n ** 6n, "exactIn")).toBeCloseTo(0.99e6 * (1e12 / (1e12 + 0.99e6)), 0);
    expect(estimateRoute(r, st, 10n ** 6n, "exactIn", new Map([[fee.poolId, 0]]))).toBeCloseTo(1e6 * (1e12 / (1e12 + 1e6)), 0);
  });

  it("returns null when a pool is unknown", () => {
    expect(estimateRoute(routes[0]!, new Map(), 1000n, "exactIn")).toBeNull();
  });

  it("ranks the deep pool first for exact-in and exact-out, and keeps only the best", () => {
    const deepId = deep.poolId;
    const first = (r: typeof routes) => (r[0]!.steps[0] as { poolId: string }).poolId;
    expect(first(rankRoutes(routes, states, 10n ** 9n, "exactIn", 5))).toBe(deepId);
    expect(first(rankRoutes(routes, states, 10n ** 9n, "exactOut", 5))).toBe(deepId);
    expect(rankRoutes(routes, states, 10n ** 9n, "exactIn", 1)).toHaveLength(1);
    // unknown pools sort last instead of being dropped
    const mixed = rankRoutes(routes, new Map([[deep.poolId, deep]]), 10n ** 9n, "exactIn", 5);
    expect(mixed).toHaveLength(2);
    expect((mixed[0]!.steps[0] as { poolId: string }).poolId).toBe(deepId);
  });

  it("a multi-hop route through a shallow pool ranks below a direct deep one", () => {
    const usdt = fakePool(weth, USDT.address, 500, 10, 10n ** 6n, { lpFee: 0 });
    const usdtUsdc = fakePool(USDT.address, USDC.address, 100, 1, 10n ** 6n, { lpFee: 0 });
    const all = [deep, usdt, usdtUsdc];
    const st = new Map(all.map((p) => [p.poolId, p]));
    const rs = enumerateRoutes(all, weth, USDC.address, { weth });
    expect(rs).toHaveLength(2);
    const ranked = rankRoutes(rs, st, 10n ** 9n, "exactIn", 2);
    expect(ranked[0]!.steps).toHaveLength(1);
  });
});
