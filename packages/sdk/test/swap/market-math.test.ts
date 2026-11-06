import { describe, expect, it } from "vitest";
import { maxUsableTick, positionReserves, sqrtPriceAtTick, tokenPriceInQuote } from "../../src/index.js";

describe("position reserves", () => {
  it("max usable tick matches TickMath for spacing 200", () => {
    expect(maxUsableTick(200)).toBe(887_200);
  });

  it("holds the whole supply and no quote at the start price (token is currency0)", () => {
    // build a position: L chosen, start tick -69_000 (quote per token 0.001), supply S = L (1/sqrtA - 1/sqrtB)
    const L = 1e24;
    const sqrtA = sqrtPriceAtTick(-69_000);
    const sqrtB = sqrtPriceAtTick(887_200);
    const S = L * (1 / sqrtA - 1 / sqrtB);
    const r = positionReserves({ sqrtPrice: sqrtA, liquidity: L, supply: S, tokenIsCurrency0: true })!;
    expect(r.quote).toBeCloseTo(0, 3);
    expect(r.token / S).toBeCloseTo(1, 9);
  });

  it("moves value from token to quote as the price rises (token is currency0)", () => {
    const L = 1e24;
    const sqrtA = sqrtPriceAtTick(-69_000);
    const sqrtB = sqrtPriceAtTick(887_200);
    const S = L * (1 / sqrtA - 1 / sqrtB);
    const s2 = sqrtPriceAtTick(-69_000 + 4000); // price up e^0.4
    const r = positionReserves({ sqrtPrice: s2, liquidity: L, supply: S, tokenIsCurrency0: true })!;
    expect(r.quote).toBeCloseTo(L * (s2 - sqrtA), -10);
    expect(r.token).toBeLessThan(S);
    // value conservation of the constant-product piece: token * price + quote is positive and finite
    expect(r.token).toBeGreaterThan(0);
  });

  it("mirrors for a token that is currency1", () => {
    const L = 1e24;
    const sqrtA = sqrtPriceAtTick(-887_200);
    const startTick = 69_000; // price of currency1 token in currency0 quote ... token sold as price falls
    const sqrtB = sqrtPriceAtTick(startTick);
    const S = L * (sqrtB - sqrtA);
    const atStart = positionReserves({ sqrtPrice: sqrtB, liquidity: L, supply: S, tokenIsCurrency0: false })!;
    expect(atStart.quote).toBeCloseTo(0, 3);
    expect(atStart.token / S).toBeCloseTo(1, 9);
    const later = positionReserves({ sqrtPrice: sqrtPriceAtTick(startTick - 4000), liquidity: L, supply: S, tokenIsCurrency0: false })!;
    expect(later.quote).toBeGreaterThan(0);
    expect(later.token).toBeLessThan(S);
  });

  it("returns null for degenerate input", () => {
    expect(positionReserves({ sqrtPrice: 0, liquidity: 1, supply: 1, tokenIsCurrency0: true })).toBeNull();
    expect(positionReserves({ sqrtPrice: 1, liquidity: 0, supply: 1, tokenIsCurrency0: true })).toBeNull();
  });
});

describe("tokenPriceInQuote", () => {
  it("adjusts for decimals and direction", () => {
    // WETH (18) quote; token is currency0; raw price 1e-3 -> 0.001 WETH per token
    expect(tokenPriceInQuote({ sqrtPrice: Math.sqrt(1e-3), tokenIsCurrency0: true, tokenDecimals: 18, quoteDecimals: 18 })).toBeCloseTo(1e-3, 12);
    // token is currency1: quote per token = 1 / raw
    expect(tokenPriceInQuote({ sqrtPrice: Math.sqrt(1000), tokenIsCurrency0: false, tokenDecimals: 18, quoteDecimals: 18 })).toBeCloseTo(1e-3, 12);
    // USDC quote (6 decimals): raw 1e-9 currency1/currency0 with token as currency0 => 1e-9 * 1e12 = 1e3 ... per-token price
    expect(tokenPriceInQuote({ sqrtPrice: Math.sqrt(1e-9), tokenIsCurrency0: true, tokenDecimals: 18, quoteDecimals: 6 })).toBeCloseTo(1e-9 * 1e12, 6);
  });
});
