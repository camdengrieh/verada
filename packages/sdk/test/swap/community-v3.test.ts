import { decodeFunctionData, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_V3_FACTORY,
  COMMUNITY_V3_FACTORY,
  buildCommunitySwap,
  communityPoolAddress,
  discoverFactoryPools,
  minOutFromSpot,
  spotAmountOut,
  v3PoolSwapperAbi,
} from "../../src/index.js";

const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const TSLAON = getAddress("0xf6b1117ec07684D3958caD8BEb1b302bfD21103f");

describe("communityPoolAddress", () => {
  it("derives the live TSLAon 2% community pool and is order independent", () => {
    const pool = getAddress("0xF2006D44339E5C2c479d450a97884d4E20D028AD");
    expect(communityPoolAddress(COMMUNITY_V3_FACTORY, TSLAON, USDC, 20_000)).toBe(pool);
    expect(communityPoolAddress(COMMUNITY_V3_FACTORY, USDC, TSLAON, 20_000)).toBe(pool);
  });
  it("differs by factory and fee", () => {
    const a = communityPoolAddress(COMMUNITY_V3_FACTORY, TSLAON, USDC, 20_000);
    expect(communityPoolAddress(CANONICAL_V3_FACTORY, TSLAON, USDC, 20_000)).not.toBe(a);
    expect(communityPoolAddress(COMMUNITY_V3_FACTORY, TSLAON, USDC, 10_000)).not.toBe(a);
  });
});

describe("pricing helpers", () => {
  it("converts a sqrt price in both directions", () => {
    const sqrt = 1n << 96n; // price 1
    expect(spotAmountOut(sqrt, USDC, TSLAON, 1000n)).toBe(1000n);
    expect(spotAmountOut(sqrt * 2n, USDC, TSLAON, 1000n)).toBe(USDC.toLowerCase() < TSLAON.toLowerCase() ? 4000n : 250n);
  });
  it("takes the fee and slippage off spot", () => {
    expect(minOutFromSpot(1_000_000n, 20_000, 100)).toBe(970_000n); // 2% fee + 1%
    expect(minOutFromSpot(1_000_000n, 50_000, 0)).toBe(950_000n); // 5% fee tier
    expect(minOutFromSpot(1_000_000n, 20_000, 9_900)).toBe(0n);
  });
});

describe("buildCommunitySwap", () => {
  const base = { swapper: getAddress("0x0000000000000000000000000000000000002222"), factory: COMMUNITY_V3_FACTORY, tokenIn: TSLAON, tokenOut: USDC, fee: 20_000, amountIn: 10n ** 18n, minOut: 5n, recipient: getAddress("0x0000000000000000000000000000000000001111"), deadline: 1_800_000_000n };
  it("encodes swapExactIn and names the approval", () => {
    const tx = buildCommunitySwap(base);
    const d = decodeFunctionData({ abi: v3PoolSwapperAbi, data: tx.data });
    expect(d.functionName).toBe("swapExactIn");
    expect(d.args).toEqual([COMMUNITY_V3_FACTORY, TSLAON, USDC, 20_000, 10n ** 18n, 5n, 0n, base.recipient, 1_800_000_000n]);
    expect(tx.to).toBe(base.swapper);
    expect(tx.approval).toEqual({ token: TSLAON, spender: base.swapper, amount: 10n ** 18n });
  });
  it("refuses a zero minOut", () => {
    expect(() => buildCommunitySwap({ ...base, minOut: 0n })).toThrow();
  });
});

describe("discoverFactoryPools", () => {
  it("ranks live pools by liquidity and skips missing tiers", async () => {
    const pools: Record<number, string> = { 10_000: "0x00000000000000000000000000000000000000a1", 20_000: "0x00000000000000000000000000000000000000a2" };
    const client = {
      readContract: async ({ functionName, args, address }: { functionName: string; args?: readonly unknown[]; address: string }) => {
        if (functionName === "getPool") return pools[args![2] as number] ?? "0x0000000000000000000000000000000000000000";
        if (functionName === "liquidity") return address.endsWith("a2") ? 900n : 100n;
        return [1n << 96n, 0];
      },
    } as never;
    const found = await discoverFactoryPools(client, COMMUNITY_V3_FACTORY, TSLAON, USDC);
    expect(found.map((f) => f.fee)).toEqual([20_000, 10_000]);
  });
});
