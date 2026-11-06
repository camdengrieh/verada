import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_PRICE_IMPACT_PCT, SwapError } from "@varada/sdk";

const pick = vi.hoisted(() => vi.fn());
vi.mock("@varada/sdk", async (orig) => ({
  ...(await orig<typeof import("@varada/sdk")>()),
  discoverPools: async () => [{ poolId: "0x1" }],
  enumerateRoutes: () => [{ steps: [] }],
  pickBestQuote: pick,
}));

const { loadQuoteRouteDepth } = await import("@/lib/swap/depth");
const quote = { address: "0x00000000000000000000000000000000000000cc", symbol: "Q", decimals: 18 } as never;
const run = () => loadQuoteRouteDepth({} as never, quote, 1);

describe("loadQuoteRouteDepth", () => {
  it("returns the impact of a fillable size", async () => {
    pick.mockResolvedValue({ best: { priceImpactPct: 2.5 } });
    expect(await run()).toEqual({ sizeUsd: 10_000, impactPct: 2.5 });
  });

  it("says it cannot fill when the impact reaches the engine's block threshold (nothing throws for it)", async () => {
    pick.mockResolvedValue({ best: { priceImpactPct: DEFAULT_MAX_PRICE_IMPACT_PCT } });
    expect(await run()).toEqual({ sizeUsd: 10_000, impactPct: null });
  });

  it("says it cannot fill on insufficient liquidity, and gives no depth on other failures", async () => {
    pick.mockRejectedValue(new SwapError("insufficient-liquidity"));
    expect(await run()).toEqual({ sizeUsd: 10_000, impactPct: null });
    pick.mockRejectedValue(new Error("rpc"));
    expect(await run()).toBeNull();
  });
});
