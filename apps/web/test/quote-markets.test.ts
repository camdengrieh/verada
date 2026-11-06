import { describe, expect, it } from "vitest";
import { zeroAddress, type Address } from "viem";
import { EXTERNAL_ADDRESSES, ONDO_TOKENS } from "@varada/sdk";
import { analyseRoute, impactLadder, poolIdOf, withQuoteMarkets, type HopPool, type PoolKey } from "@/lib/quote-markets";
import { quoteAssetsFromRows } from "@/lib/quote-assets";

const { weth, usdc } = EXTERNAL_ADDRESSES;
const NVDA = ONDO_TOKENS.NVDAon.address;
const Q96 = 2n ** 96n;

const sqrtOf = (raw: number) => BigInt(Math.round(Math.sqrt(raw) * Number(Q96)));
const key = (a: Address, b: Address, hooks: Address = zeroAddress): PoolKey => {
  const [currency0, currency1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return { currency0, currency1, fee: 500, tickSpacing: 10, hooks };
};
const symbolOf = (a: string) => (a === weth.toLowerCase() ? "WETH" : a === usdc.toLowerCase() ? "USDC" : a === NVDA.toLowerCase() ? "NVDAon" : a === zeroAddress ? "ETH" : a);
const decimalsOf = (a: string) => (a.toLowerCase() === usdc.toLowerCase() ? 6 : 18);

describe("poolIdOf", () => {
  it("is a stable 32-byte hash that depends on every field", () => {
    const k = key(weth, usdc);
    expect(poolIdOf(k)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(poolIdOf(k)).toBe(poolIdOf({ ...k }));
    expect(poolIdOf(k)).not.toBe(poolIdOf({ ...k, fee: 3000 }));
  });
});

describe("analyseRoute", () => {
  // WETH/USDC: USDC is currency0. 1 USDC (1e6 raw) buys 1/3000 WETH (1e18 raw): raw price 1e18/3000/1e6.
  const ethUsdc: HopPool = { key: key(weth, usdc), sqrtPriceX96: sqrtOf(1e18 / 3000 / 1e6), liquidity: BigInt(Math.round(1e12 * Math.sqrt(1e18 / 3000 / 1e6))) };

  it("prices WETH and reads depth from a direct USDC pool", () => {
    const a = analyseRoute(weth, [ethUsdc], usdc, weth, symbolOf, decimalsOf)!;
    expect(a.route).toEqual(["WETH", "USDC"]);
    expect(a.priceUsd).toBeCloseTo(3000, 0);
    expect(a.depthUsd).toBeCloseTo(2_000_000, -3); // 1M USDC reserve on each side
    expect(a.poolDepthUsd).toBeCloseTo(2_000_000, -3);
    expect(a.reserves?.quote.symbol).toBe("USDC");
    expect(a.reserves?.base.usd).toBeCloseTo(1_000_000, -3);
  });

  it("prices a stock through WETH and takes the shallowest hop as the route depth", () => {
    // NVDAon is currency0 against WETH: 0.05 WETH per share, 100 WETH of virtual reserve.
    const raw = 0.05;
    const stock: HopPool = { key: key(NVDA, weth), sqrtPriceX96: sqrtOf(raw), liquidity: BigInt(Math.round((100e18 / Math.sqrt(raw)))) };
    const a = analyseRoute(NVDA, [stock, ethUsdc], usdc, weth, symbolOf, decimalsOf)!;
    expect(a.route).toEqual(["NVDAon", "WETH", "USDC"]);
    expect(a.priceUsd).toBeCloseTo(150, 0);
    // hop 1: 100 WETH * $3000 = $300K per side; hop 2: $1M per side
    expect(a.hopReserveUsd[0]).toBeCloseTo(300_000, -3);
    expect(a.depthUsd).toBeCloseTo(600_000, -3);
    expect(a.reserves?.base.symbol).toBe("NVDAon");
    expect(a.reserves?.base.usd).toBeCloseTo(a.reserves!.quote.usd, -2);
  });

  it("treats a native ETH pool after WETH as the same currency", () => {
    const native: HopPool = { ...ethUsdc, key: { ...key(weth, usdc), currency0: zeroAddress, currency1: usdc } };
    // USDC (0xA0b8…) vs the zero address: zero is currency0, USDC currency1; raw price flips.
    const flipped: HopPool = { ...native, sqrtPriceX96: sqrtOf(1e6 / (1e18 / 3000)) , liquidity: BigInt(Math.round(1e18 * 333.33 * Math.sqrt(1e6 / (1e18 / 3000)) / 1)) };
    const a = analyseRoute(weth, [flipped], usdc, weth, symbolOf, decimalsOf)!;
    expect(a.priceUsd).toBeCloseTo(3000, 0);
    expect(a.route).toEqual(["WETH", "USDC"]);
  });

  it("returns null for a broken route", () => {
    expect(analyseRoute(weth, [], usdc, weth, symbolOf, decimalsOf)).toBeNull();
    expect(analyseRoute(NVDA, [ethUsdc], usdc, weth, symbolOf, decimalsOf)).toBeNull(); // first pool lacks the asset
    const dead: HopPool = { ...ethUsdc, sqrtPriceX96: 0n };
    expect(analyseRoute(weth, [dead], usdc, weth, symbolOf, decimalsOf)).toBeNull();
    const toWeth: HopPool = { key: key(NVDA, weth), sqrtPriceX96: sqrtOf(0.05), liquidity: 10n ** 20n };
    expect(analyseRoute(NVDA, [toWeth], usdc, weth, symbolOf, decimalsOf)).toBeNull(); // does not end in USDC
  });
});

describe("impactLadder", () => {
  it("adds constant-product impact per hop and withholds sizes past half the depth", () => {
    const steps = impactLadder([1_000_000]);
    expect(steps.map((s) => s.size)).toEqual([100, 1000, 10000, 50000]);
    expect(steps[0]!.impact).toBeCloseTo(0.01, 2);
    expect(steps[2]!.impact).toBeCloseTo(0.99, 1);
    const shallow = impactLadder([10_000]);
    expect(shallow[3]!.impact).toBeNull();
    expect(shallow[2]!.impact).toBeNull();
    expect(shallow[1]!.impact).toBeCloseTo(9.09, 1);
    expect(impactLadder([]).every((s) => s.impact === null)).toBe(true);
  });
});

describe("withQuoteMarkets", () => {
  const assets = quoteAssetsFromRows(
    [
      { asset: weth, kind: 0, active: true, decimals: 18 },
      { asset: NVDA, kind: 1, active: true, decimals: 18 },
    ],
    () => undefined,
  );
  it("layers data by address and marks a missing route not launchable", () => {
    const out = withQuoteMarkets(
      assets,
      new Map([
        [weth.toLowerCase(), { priceUsd: 3000, routeDepthUsd: 2e6, route: ["WETH", "USDC"] }],
        [NVDA.toLowerCase(), { paused: true, noRoute: true }],
      ]),
    );
    expect(out[0]).toMatchObject({ price: 3000, routeDepthUsd: 2e6, route: ["WETH", "USDC"], launchable: { ok: true } });
    expect(out[1]).toMatchObject({ paused: true, launchable: { ok: false } });
  });
  it("passes assets through without data", () => {
    expect(withQuoteMarkets(assets, undefined)).toEqual(assets);
  });
});
