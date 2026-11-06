/**
 * Mainnet-fork check of the on-chain USD pricing: real Uniswap v4 pools, no oracle. Read-only, so
 * FORK_RPC_URL may be an anvil fork (see test/swap.fork.test.ts) or any mainnet RPC; the suite is
 * skipped without it. To run:
 *   FORK_RPC_URL=http://127.0.0.1:8546 pnpm --filter @varada/sdk exec vitest run test/usd.fork.test.ts
 * It prints a table of every Ondo token that has a route to USDC: price, depth, route.
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { beforeAll, describe, expect, it } from "vitest";
import { ONDO_TOKENS, USDC, WETH, clearDiscoveryCache, loadUsdQuotes, rankByDepth, type UsdQuote } from "../src/index.js";

const RPC = process.env.FORK_RPC_URL;
const describeFork = RPC ? describe : describe.skip;
const client = createPublicClient({ chain: mainnet, transport: http(RPC ?? "http://127.0.0.1:8546", { timeout: 180_000 }) }) as PublicClient;

describeFork("on-chain USD pricing (mainnet pools)", () => {
  let base: Map<string, UsdQuote>;
  const ondo = Object.entries(ONDO_TOKENS).map(([symbol, t]) => ({ symbol, address: t.address, decimals: 18 }));
  let priced: { symbol: string; q: UsdQuote }[] = [];

  beforeAll(async () => {
    clearDiscoveryCache();
    base = await loadUsdQuotes(client, [{ ...WETH, symbol: "WETH" }, { ...USDC }]);
    const quotes = new Map<string, UsdQuote>();
    // chunks keep the batched pool read small
    for (let i = 0; i < ondo.length; i += 25) {
      for (const [k, v] of await loadUsdQuotes(client, ondo.slice(i, i + 25))) quotes.set(k, v);
    }
    priced = ondo.flatMap((o) => {
      const q = quotes.get(o.address.toLowerCase());
      return q && q.priceUsd !== null ? [{ symbol: o.symbol, q }] : [];
    });
    const ranked = rankByDepth(priced, (p) => p.q.depthUsd, (p) => p.symbol);
    console.log(
      ["symbol price(USD) depth(USD) confidence route", ...ranked.map((p) => `${p.symbol} ${p.q.priceUsd!.toFixed(4)} ${Math.round(p.q.depthUsd)} ${p.q.confidence} ${p.q.route.join(">")}`)].join("\n"),
    );
  }, 600_000);

  it("USDC is exactly one dollar with unbounded depth", () => {
    const q = base.get(USDC.address.toLowerCase())!;
    expect(q.priceUsd).toBe(1);
    expect(q.source).toBe("stable");
    expect(q.depthUsd).toBe(Infinity);
  });

  it("WETH is priced from the ETH/USDC pools, deep, in a sane range", () => {
    const q = base.get(WETH.address.toLowerCase())!;
    expect(q.priceUsd).not.toBeNull();
    expect(q.priceUsd!).toBeGreaterThan(300);
    expect(q.priceUsd!).toBeLessThan(50_000);
    expect(q.depthUsd).toBeGreaterThan(1_000_000);
    expect(q.confidence).toBe("high");
    expect(q.route.at(-1)).toBe("USDC");
  });

  it("prices the Ondo tokens that have pools, and orders them deepest first", () => {
    for (const p of priced) {
      expect(p.q.priceUsd!).toBeGreaterThan(0);
      expect(Number.isFinite(p.q.priceUsd!)).toBe(true);
      expect(p.q.depthUsd).toBeGreaterThan(0);
      expect(p.q.route.at(-1)).toBe("USDC");
    }
    const ranked = rankByDepth(priced, (p) => p.q.depthUsd, (p) => p.symbol);
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1]!.q.depthUsd).toBeGreaterThanOrEqual(ranked[i]!.q.depthUsd);
  });
});
