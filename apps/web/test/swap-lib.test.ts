import { describe, expect, it } from "vitest";
import { ETH, ONDO_TOKENS, USDC, WETH, type SwapAsset } from "@varada/sdk";
import { formatDisplay, formatPercent, formatRaw, formatUsd, parseAmount, slippageToBps } from "@/lib/swap/amounts";
import { knownAsset, resolveMarketToken, tradeAssets } from "@/lib/swap/tokens";
import { loadPoolMarket } from "@/lib/swap/market";
import { isStable } from "@/lib/swap/usd";
import { payAmountRaw } from "@/lib/swap/trade";

describe("amounts", () => {
  it("parses decimal text into raw units and rejects junk and zero", () => {
    expect(parseAmount("1.5", 18)).toBe(1_500_000_000_000_000_000n);
    expect(parseAmount("1,000.25", 6)).toBe(1_000_250_000n);
    expect(parseAmount(".5", 6)).toBe(500_000n);
    expect(parseAmount("0", 18)).toBeNull();
    expect(parseAmount("", 18)).toBeNull();
    expect(parseAmount(".", 18)).toBeNull();
    expect(parseAmount("abc", 18)).toBeNull();
    expect(parseAmount("-1", 18)).toBeNull();
  });
  it("truncates precision a token cannot hold instead of rejecting a paste", () => {
    expect(parseAmount("1.1234567", 6)).toBe(1_123_456n);
    expect(parseAmount("0.0000001", 6)).toBeNull();
  });
  it("formats raw amounts", () => {
    expect(formatRaw(1_500_000_000_000_000_000n, 18)).toBe("1.5");
    expect(formatRaw(1_000_000n, 6)).toBe("1");
    expect(formatRaw(123_456_789n, 8, 4)).toBe("1.2345");
    expect(formatDisplay(1_234_567_000_000_000_000_000n, 18)).toBe("1,234.57");
    expect(formatDisplay(0n, 18)).toBe("0");
    expect(formatDisplay(1n, 18)).toBe("<0.00000001");
    expect(formatUsd(1234.5)).toBe("$1,235");
    expect(formatUsd(12.345)).toBe("$12.35");
    expect(formatPercent(0.034)).toBe("0.03%");
    expect(formatPercent(12.34)).toBe("12.3%");
  });
  it("converts slippage percent to bps within the engine's bounds", () => {
    expect(slippageToBps(0.5)).toBe(50);
    expect(slippageToBps(1)).toBe(100);
    expect(slippageToBps(250)).toBe(9999);
    expect(slippageToBps(-1)).toBe(0);
  });
});

const TOKEN = "0x1111111111111111111111111111111111111111";
const HOOK = "0x2222222222222222222222222222222222222222";
const LIVE = "0x3333333333333333333333333333333333333333";
const FACTORY = "0x4444444444444444444444444444444444444444";

describe("assets", () => {
  it("knows the hubs and Ondo tokens without a read", () => {
    expect(knownAsset(USDC.address)).toEqual(USDC);
    expect(knownAsset(WETH.address.toLowerCase())).toEqual(WETH);
    expect(knownAsset(ONDO_TOKENS.AMZNon.address)).toEqual({ address: ONDO_TOKENS.AMZNon.address, symbol: "AMZNon", decimals: 18 });
    expect(knownAsset(TOKEN)).toBeNull();
    expect(knownAsset("nope")).toBeNull();
  });
  it("offers the hubs plus the quote asset once", () => {
    const amzn: SwapAsset = { address: ONDO_TOKENS.AMZNon.address, symbol: "AMZNon", decimals: 18 };
    expect(tradeAssets(WETH).map((a) => a.symbol)).toEqual(["ETH", "WETH", "USDC", "USDT", "DAI", "WBTC"]);
    expect(tradeAssets(amzn).map((a) => a.symbol).at(-1)).toBe("AMZNon");
    expect(tradeAssets(amzn)).toHaveLength(7);
  });
  it("treats dollar stablecoins as stable", () => {
    expect(isStable(USDC)).toBe(true);
    expect(isStable(ETH)).toBe(false);
  });
});

describe("resolveMarketToken", () => {
  const chainWith = (answers: Record<string, unknown>) =>
    ({
      readContract: async (a: { functionName: string; address: string }) => {
        const v = answers[`${a.address.toLowerCase()}:${a.functionName}`] ?? answers[a.functionName];
        if (v instanceof Error) throw v;
        if (v === undefined) throw new Error(`unexpected read ${a.functionName}`);
        return v;
      },
    }) as never;

  it("uses what the token page passes and detects the mode from the hook", async () => {
    const t = await resolveMarketToken({ chain: chainWith({ vault: new Error("revert") }), cfg: {} }, { address: TOKEN, symbol: "TKN", hook: HOOK, quote: WETH.address });
    expect(t).toMatchObject({ symbol: "TKN", quote: WETH, mode: "weekly", decimals: 18 });
    expect(t.hook.toLowerCase()).toBe(HOOK);
    const live = await resolveMarketToken({ chain: chainWith({ vault: LIVE }), cfg: {} }, { address: TOKEN, symbol: "TKN", hook: HOOK, quote: WETH.address });
    expect(live.mode).toBe("live");
  });

  it("falls back to the indexer row for the hook", async () => {
    const indexer = { get: async (path: string) => (path.endsWith(TOKEN) ? { address: TOKEN, hook: HOOK, quote: ONDO_TOKENS.AAPLon.address } : null) };
    const t = await resolveMarketToken({ chain: chainWith({ vault: new Error("x") }), indexer, cfg: {} }, { address: TOKEN, symbol: "TKN" });
    expect(t.hook.toLowerCase()).toBe(HOOK);
    expect(t.quote.symbol).toBe("AAPLon");
  });

  it("falls back to the chain: quoteAssetOf and the hook that configured the token", async () => {
    const chain = chainWith({
      quoteAssetOf: WETH.address,
      [`${FACTORY}:hook`]: HOOK,
      [`${FACTORY}:liveHook`]: LIVE,
      [`${HOOK}:configured`]: false,
      [`${LIVE}:configured`]: true,
      [`${LIVE}:vault`]: "0x5555555555555555555555555555555555555555",
    });
    const indexer = { get: async () => { throw new Error("down"); } };
    const t = await resolveMarketToken({ chain, indexer, cfg: { factoryAddress: FACTORY } }, { address: TOKEN, symbol: "TKN" });
    expect(t.hook.toLowerCase()).toBe(LIVE);
    expect(t.mode).toBe("live");
    expect(t.quote).toEqual(WETH);
  });

  it("fails clearly without data", async () => {
    await expect(resolveMarketToken({ chain: chainWith({}), cfg: {} }, { address: TOKEN, symbol: "TKN" })).rejects.toThrow(/quote asset/);
    await expect(resolveMarketToken({ chain: chainWith({}), cfg: {} }, { address: "nope", symbol: "TKN" })).rejects.toThrow(/token address/);
    const chain = chainWith({ [`${FACTORY}:hook`]: HOOK, [`${FACTORY}:liveHook`]: LIVE, configured: false });
    await expect(resolveMarketToken({ chain, cfg: { factoryAddress: FACTORY } }, { address: TOKEN, symbol: "TKN", quote: WETH.address })).rejects.toThrow(/not configured/);
  });
});

describe("payAmountRaw", () => {
  const token = { address: TOKEN as `0x${string}`, symbol: "T", hook: HOOK as `0x${string}`, quote: WETH };
  it("uses the pay asset's decimals when buying and 18 when selling", () => {
    expect(payAmountRaw({ token, side: "buy", asset: USDC, amountText: "2.5" })).toBe(2_500_000n);
    expect(payAmountRaw({ token, side: "sell", asset: USDC, amountText: "2.5" })).toBe(2_500_000_000_000_000_000n);
    expect(payAmountRaw({ token, side: "buy", asset: USDC, amountText: "" })).toBeNull();
  });
});

describe("loadPoolMarket", () => {
  const sqrt = (p: number) => BigInt(Math.floor(Math.sqrt(p) * 2 ** 96));
  it("derives price, reserves, TVL and the 24 h change", async () => {
    const token = { address: TOKEN as `0x${string}`, symbol: "T", hook: HOOK as `0x${string}`, quote: WETH, decimals: 18 };
    // token (0x11..) sorts below WETH: currency0. price 0.002 WETH per token.
    const L = 10n ** 24n;
    const chain = {
      readContract: async (a: { functionName: string }) => {
        if (a.functionName === "getSlot0") return [sqrt(0.002), 0, 0, 0];
        if (a.functionName === "getLiquidity") return L;
        if (a.functionName === "totalSupply") return 10n ** 27n;
        throw new Error("unexpected");
      },
    } as never;
    const indexer = {
      market: async () => ({
        quote: WETH.address,
        quoteDecimals: 18,
        price: 0.002,
        lastTradeAt: 1_700_000_000,
        window: { hours: 24, trades: 12, buys: 8, sells: 4, buyQuote: 5n * 10n ** 18n, sellQuote: 10n ** 18n, volumeQuote: 6n * 10n ** 18n, buyShare: 0.8 },
        hourly: [
          { hour: 1, buys: 1, sells: 0, buyQuote: 0n, sellQuote: 0n, closePrice: 0.001 },
          { hour: 2, buys: 1, sells: 0, buyQuote: 0n, sellQuote: 0n, closePrice: 0.002 },
        ],
      }),
    };
    const m = await loadPoolMarket({ chain, indexer, token, quoteUsd: 2500 });
    expect(m.priceInQuote).toBeCloseTo(0.002, 9);
    expect(m.priceUsd).toBeCloseTo(5, 6);
    expect(m.change24hPct).toBeCloseTo(100, 6);
    expect(m.volume24hQuote).toBeCloseTo(6, 9);
    expect(m.volume24hUsd).toBeCloseTo(15_000, 3);
    expect(m.trades24h).toBe(12);
    expect(m.reserves).not.toBeNull();
    expect(m.tvlUsd).toBeGreaterThan(0);
    expect(m.marketCapUsd).toBeCloseTo(1e9 * 5, -3);
    expect(m.source.stats).toBe("indexer");
  });

  it("still returns the pool numbers when the indexer is down", async () => {
    const token = { address: TOKEN as `0x${string}`, symbol: "T", hook: HOOK as `0x${string}`, quote: WETH, decimals: 18 };
    const chain = { readContract: async (a: { functionName: string }) => (a.functionName === "getSlot0" ? [sqrt(0.002), 0, 0, 0] : a.functionName === "getLiquidity" ? 10n ** 24n : (() => { throw new Error("no supply"); })()) } as never;
    const m = await loadPoolMarket({ chain, indexer: { market: async () => { throw new Error("down"); } }, token, quoteUsd: null });
    expect(m.priceInQuote).toBeCloseTo(0.002, 9);
    expect(m.priceUsd).toBeNull();
    expect(m.change24hPct).toBeNull();
    expect(m.reserves).toBeNull();
    expect(m.source.stats).toBe("none");
  });
});
