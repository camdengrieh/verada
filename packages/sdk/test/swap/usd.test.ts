import { describe, expect, it } from "vitest";
import {
  confidenceFor,
  deepestUsdQuote,
  hopOutReserve,
  hopPriceOutPerIn,
  makeUsdQuote,
  pickUsdQuote,
  priceUsdcRoute,
  rankByDepth,
  usdNotes,
  usdValue,
  type UsdHop,
} from "../../src/index.js";

const Q96 = 2n ** 96n;
/** sqrtPriceX96 for a raw currency1/currency0 ratio. */
const sqrtX96 = (raw: number) => BigInt(Math.round(Math.sqrt(raw) * Number(Q96)));

describe("hop price", () => {
  it("prices an 18 -> 6 decimals hop on an inverted pool (USDC is currency0, WETH sold)", () => {
    const raw = 1e18 / 3000e6; // raw WETH (currency1) per raw USDC (currency0)
    const hop: UsdHop = { sqrtPriceX96: sqrtX96(raw), liquidity: 1n, zeroForOne: false, decimalsIn: 18, decimalsOut: 6 };
    expect(hopPriceOutPerIn(hop)).toBeCloseTo(3000, 3);
  });

  it("prices a forward hop (asset is currency0) with 8 decimals", () => {
    const raw = 60000e6 / 1e8;
    const hop: UsdHop = { sqrtPriceX96: sqrtX96(raw), liquidity: 1n, zeroForOne: true, decimalsIn: 8, decimalsOut: 6 };
    expect(hopPriceOutPerIn(hop)).toBeCloseTo(60000, 2);
  });

  it("prices a 6 -> 18 decimals hop (USDC into an 18-decimals token)", () => {
    // 1 USDC buys 0.5 token: raw token per raw USDC = 0.5e18 / 1e6; USDC is currency0
    const hop: UsdHop = { sqrtPriceX96: sqrtX96(0.5e18 / 1e6), liquidity: 1n, zeroForOne: true, decimalsIn: 6, decimalsOut: 18 };
    expect(hopPriceOutPerIn(hop)).toBeCloseTo(0.5, 6);
  });

  it("is NaN for an uninitialised pool", () => {
    expect(hopPriceOutPerIn({ sqrtPriceX96: 0n, zeroForOne: true, decimalsIn: 18, decimalsOut: 6 })).toBeNaN();
  });
});

describe("hop reserve", () => {
  it("out reserve of a forward hop is L * sqrtP in out units", () => {
    const raw = 2000e6 / 1e18;
    const L = 5e12;
    const hop = { sqrtPriceX96: sqrtX96(raw), liquidity: BigInt(L), zeroForOne: true, decimalsOut: 6 };
    expect(hopOutReserve(hop)).toBeCloseTo((L * Math.sqrt(raw)) / 1e6, 0);
  });
  it("is zero without liquidity", () => {
    expect(hopOutReserve({ sqrtPriceX96: Q96, liquidity: 0n, zeroForOne: true, decimalsOut: 6 })).toBe(0);
  });
});

describe("route", () => {
  const ethUsdcRaw = 1e18 / 3000e6; // USDC is currency0, WETH currency1
  const ethUsdc = (): UsdHop => {
    const r = Math.sqrt(ethUsdcRaw);
    // out is USDC = currency0 = L / r, so L = reserve * r; choose a 1,000,000 USDC reserve
    const L = BigInt(Math.round(1_000_000e6 * r));
    return { sqrtPriceX96: sqrtX96(ethUsdcRaw), liquidity: L, zeroForOne: false, decimalsIn: 18, decimalsOut: 6 };
  };

  it("prices one hop to USDC; depth is twice the output reserve", () => {
    const p = priceUsdcRoute([ethUsdc()])!;
    expect(p.priceUsd).toBeCloseTo(3000, 2);
    expect(p.hopReserveUsd[0]! / 1_000_000).toBeCloseTo(1, 3);
    expect(p.depthUsd / 2_000_000).toBeCloseTo(1, 3);
  });

  it("multiplies across hops and values reserves in USD (RWA -> WETH -> USDC)", () => {
    // RWA (18) is currency0, WETH currency1: 0.05 WETH per RWA = $150
    const L = 40n * 10n ** 18n;
    const rwaEth: UsdHop = { sqrtPriceX96: sqrtX96(0.05), liquidity: L, zeroForOne: true, decimalsIn: 18, decimalsOut: 18 };
    const p = priceUsdcRoute([rwaEth, ethUsdc()])!;
    expect(p.priceUsd).toBeCloseTo(150, 1);
    const wethReserve = 40 * Math.sqrt(0.05);
    expect(p.hopReserveUsd[0]! / (wethReserve * 3000)).toBeCloseTo(1, 3);
    expect(p.depthUsd / (2 * wethReserve * 3000)).toBeCloseTo(1, 3); // thinnest hop is RWA/WETH
  });

  it("returns null for an empty route or a hop without a price", () => {
    expect(priceUsdcRoute([])).toBeNull();
    expect(priceUsdcRoute([{ ...ethUsdc(), sqrtPriceX96: 0n }])).toBeNull();
  });
});

describe("confidence and selection", () => {
  it("flags thin depth and missing prices", () => {
    expect(confidenceFor(10, 1_000_000)).toBe("high");
    expect(confidenceFor(10, 500)).toBe("low");
    expect(confidenceFor(null, 1e9)).toBe("none");
    expect(confidenceFor(0, 1e9)).toBe("none");
    expect(confidenceFor(NaN, 1e9)).toBe("none");
  });

  it("the registry route wins at equal depth, the deeper discovered route wins otherwise", () => {
    const reg = makeUsdQuote("0xA", "registry", ["X", "USDC"], { priceUsd: 10, depthUsd: 50_000 });
    const disc = makeUsdQuote("0xA", "discovered", ["X", "WETH", "USDC"], { priceUsd: 10.1, depthUsd: 50_000 });
    expect(pickUsdQuote("0xA", reg, disc).source).toBe("registry");
    expect(pickUsdQuote("0xA", reg, { ...disc, depthUsd: 900_000 }).source).toBe("discovered");
    expect(pickUsdQuote("0xA", null, disc).source).toBe("discovered");
    expect(pickUsdQuote("0xA", null, null).confidence).toBe("none");
  });

  it("deepestUsdQuote ignores unpriced candidates", () => {
    const a = makeUsdQuote("0xA", "registry", [], { priceUsd: 1, depthUsd: 10 });
    expect(deepestUsdQuote("0xA", [null, undefined, a]).depthUsd).toBe(10);
  });
});

describe("value and notes", () => {
  it("marks thin or closed-market values approximate", () => {
    const firm = makeUsdQuote("0xA", "registry", [], { priceUsd: 2, depthUsd: 1e6 });
    expect(usdValue(5, firm)).toEqual({ usd: 10, approx: false });
    expect(usdValue(5, { ...firm, marketClosed: true })!.approx).toBe(true);
    expect(usdValue(5, makeUsdQuote("0xA", "registry", [], { priceUsd: 2, depthUsd: 10 }))!.approx).toBe(true);
    expect(usdValue(5, null)).toBeNull();
    expect(usdValue(5, makeUsdQuote("0xA", "registry", [], { priceUsd: NaN, depthUsd: 10 }))).toBeNull();
  });
  it("explains thin liquidity and a closed market", () => {
    const q = { ...makeUsdQuote("0xA", "registry", [], { priceUsd: 2, depthUsd: 10 }), marketClosed: true };
    expect(usdNotes(q)).toHaveLength(2);
    expect(usdNotes(makeUsdQuote("0xA", "registry", [], { priceUsd: 2, depthUsd: 1e6 }))).toEqual([]);
  });
});

describe("rankByDepth", () => {
  it("orders deepest first, unpriced last, ties by name", () => {
    const items = [{ n: "b", d: 5 }, { n: "z", d: null }, { n: "a", d: 5 }, { n: "c", d: 100 }];
    expect(rankByDepth(items, (i) => i.d, (i) => i.n).map((i) => i.n)).toEqual(["c", "a", "b", "z"]);
  });
});
