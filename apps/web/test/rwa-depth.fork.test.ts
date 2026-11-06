import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, it } from "vitest";
import { DEFAULT_FEE_TIERS, EXTERNAL_ADDRESSES, ONDO_TOKENS, buildPoolKey, poolIdOf as sdkPoolId } from "@varada/sdk";
import { sortByDepth } from "@varada/ui/components/varada/quote-order";
import { analyseRoute, type HopPool } from "@/lib/quote-markets";
import { describeQuoteAsset } from "@/lib/quote-assets";

/**
 * Real Ondo pools on a mainnet fork: for each Ondo stock / ETF, find its deepest hook-less pool to
 * USDC or WETH (the pools the quote registry routes through), price it from the pool, and order by
 * USD depth. Skipped unless FORK_RPC_URL points at an anvil fork (or any archive node):
 *   FORK_RPC_URL=http://127.0.0.1:<port> pnpm --filter @varada/web exec vitest run test/rwa-depth.fork.test.ts
 */
const RPC = process.env.FORK_RPC_URL;
const stateViewAbi = [
  { type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] },
  { type: "function", name: "getLiquidity", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }], outputs: [{ type: "uint128" }] },
] as const;

const { usdc, weth, stateView } = EXTERNAL_ADDRESSES;

async function deepestPool(client: PublicClient, a: Address, b: Address): Promise<HopPool | null> {
  const keys = DEFAULT_FEE_TIERS.map((t) => buildPoolKey({ currencyA: a, currencyB: b, fee: t.fee, tickSpacing: t.tickSpacing }));
  const calls = keys.flatMap((k) => [
    { address: stateView, abi: stateViewAbi, functionName: "getSlot0" as const, args: [sdkPoolId(k)] as const },
    { address: stateView, abi: stateViewAbi, functionName: "getLiquidity" as const, args: [sdkPoolId(k)] as const },
  ]);
  const res = await client.multicall({ allowFailure: true, contracts: calls });
  let best: HopPool | null = null;
  keys.forEach((k, i) => {
    const s = res[i * 2];
    const l = res[i * 2 + 1];
    if (s?.status !== "success" || l?.status !== "success") return;
    const sqrt = (s.result as readonly bigint[])[0]!;
    const liq = l.result as bigint;
    if (sqrt === 0n || liq === 0n) return;
    if (!best || liq > best.liquidity) best = { key: { currency0: k.currency0, currency1: k.currency1, fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: k.hooks }, sqrtPriceX96: sqrt, liquidity: liq };
  });
  return best;
}

describe.skipIf(!RPC)("Ondo pools on a fork, ordered by depth", () => {
  it("prices each RWA from its pool and orders by USD depth, unrouted last", async () => {
    const client = createPublicClient({ chain: mainnet, transport: http(RPC) }) as PublicClient;
    const decimals = (a: string) => (a.toLowerCase() === usdc.toLowerCase() ? 6 : 18);
    const symbolOf = (a: string) => describeQuoteAsset(a).symbol;
    const wethUsdc = await deepestPool(client, weth, usdc);
    expect(wethUsdc).not.toBeNull();

    const tokens = Object.entries(ONDO_TOKENS).filter(([, t]) => t.kind === "Stock" || t.kind === "ETF").slice(0, Number(process.env.FORK_LIMIT ?? 1000));
    const one = async ([symbol, t]: (typeof tokens)[number]) => {
      const direct = await deepestPool(client, t.address, usdc);
      const viaWeth = direct ? null : await deepestPool(client, t.address, weth);
      const hops = direct ? [direct] : viaWeth && wethUsdc ? [viaWeth, wethUsdc] : [];
      const a = hops.length ? analyseRoute(t.address, hops, usdc, weth, symbolOf, decimals) : null;
      return { symbol, depthUsd: a?.depthUsd ?? 0, routed: a !== null, priceUsd: a?.priceUsd, route: a?.route.join(" > ") };
    };
    const rows: Awaited<ReturnType<typeof one>>[] = [];
    for (let i = 0; i < tokens.length; i += 8) rows.push(...(await Promise.all(tokens.slice(i, i + 8).map(one))));
    const sorted = sortByDepth(rows);
    console.log(sorted.slice(0, 15).map((r) => `${r.symbol.padEnd(8)} ${String(Math.round(r.depthUsd)).padStart(10)}  $${r.priceUsd?.toFixed(2) ?? "-"}  ${r.route ?? "no route"}`).join("\n"));
    console.log(`routed ${sorted.filter((r) => r.routed).length} of ${sorted.length}`);
    const routed = sorted.filter((r) => r.routed);
    expect(routed.length).toBeGreaterThan(0);
    for (let i = 1; i < routed.length; i++) expect(routed[i - 1]!.depthUsd).toBeGreaterThanOrEqual(routed[i]!.depthUsd);
    // every unrouted asset sits after every routed one
    const firstUnrouted = sorted.findIndex((r) => !r.routed);
    if (firstUnrouted >= 0) expect(sorted.slice(firstUnrouted).every((r) => !r.routed)).toBe(true);
  }, 600_000);
});
