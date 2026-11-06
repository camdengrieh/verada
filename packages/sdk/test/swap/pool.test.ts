import { describe, expect, it } from "vitest";
import { DYNAMIC_FEE_FLAG, USDC, WETH, VARADA_TICK_SPACING, buildPoolKey, isDynamicFee, poolIdOf, rawMidPrice, sortCurrencies, varadaPoolKey, adjustPrice, NATIVE_CURRENCY } from "../../src/index.js";

describe("pool keys", () => {
  it("sorts currencies by address with native ETH first", () => {
    expect(sortCurrencies(USDC.address, NATIVE_CURRENCY)).toEqual([NATIVE_CURRENCY, USDC.address]);
    expect(sortCurrencies(WETH.address, USDC.address)).toEqual([USDC.address, WETH.address]);
    expect(() => sortCurrencies(USDC.address, USDC.address.toLowerCase() as `0x${string}`)).toThrow();
  });

  it("derives the well-known ETH/USDC 0.05% pool id", () => {
    const key = buildPoolKey({ currencyA: USDC.address, currencyB: NATIVE_CURRENCY, fee: 500, tickSpacing: 10 });
    expect(poolIdOf(key)).toBe("0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27");
  });

  it("builds a Varada pool key with the dynamic fee flag and tick spacing 200", () => {
    const token = "0x1111111111111111111111111111111111111111";
    const hook = "0x2222222222222222222222222222222222222222";
    const key = varadaPoolKey(token, WETH.address, hook);
    expect(key.fee).toBe(DYNAMIC_FEE_FLAG);
    expect(key.fee).toBe(0x800000);
    expect(isDynamicFee(key.fee)).toBe(true);
    expect(isDynamicFee(3000)).toBe(false);
    expect(key.tickSpacing).toBe(VARADA_TICK_SPACING);
    expect(key.currency0.toLowerCase()).toBe(token); // token < WETH
    expect(key.currency1).toBe(WETH.address);
    expect(key.hooks.toLowerCase()).toBe(hook);
    // order of the arguments does not matter
    expect(poolIdOf(varadaPoolKey(WETH.address, token, hook))).toBe(poolIdOf(key));
  });
});

describe("prices", () => {
  it("reads the mid price in both directions", () => {
    const sqrtPriceX96 = 2n ** 96n * 2n; // price 4 of currency1 per currency0
    expect(rawMidPrice({ sqrtPriceX96 }, true)).toBeCloseTo(4, 10);
    expect(rawMidPrice({ sqrtPriceX96 }, false)).toBeCloseTo(0.25, 10);
  });
  it("adjusts for decimals", () => {
    // 1 raw ETH-wei buys 2e-9 raw USDC units per wei at $2000/ETH: 2000e6 / 1e18 = 2e-9
    expect(adjustPrice(2e-9, 18, 6)).toBeCloseTo(2000, 6);
  });
});
