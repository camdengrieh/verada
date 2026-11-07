/**
 * Prices an asset in USD from the pools the swap engine can discover: the deepest route of existing
 * v4 pools that ends in USDC. This is the fallback when the QuoteRegistry has no fee route for the
 * asset (or a thinner one); see `usd.ts` for the math.
 */
import { getAddress, type Address } from "viem";
import { DAI, ETH, USDC, USDT, WETH } from "./constants.js";
import type { ReadClient } from "./pool.js";
import { discoverPools, enumerateRoutes, routingNodes, type RoutingConfig } from "./routing.js";
import type { PoolState, Route } from "./types.js";
import { makeUsdQuote, noUsdQuote, priceUsdcRoute, type UsdHop, type UsdQuote } from "./usd.js";

const lc = (a: string) => a.toLowerCase();

/** Dollar stablecoins priced at exactly $1. */
export const USD_STABLES: readonly Address[] = [USDC.address, USDT.address, DAI.address];
export const isUsdStable = (a: string): boolean => USD_STABLES.some((s) => lc(s) === lc(a));

/** The pool steps of `route` as price-walk hops. Null if a pool's state is missing. */
export function routeHops(route: Route, states: ReadonlyMap<string, PoolState>, decimalsOf: (a: string) => number): UsdHop[] | null {
  const hops: UsdHop[] = [];
  for (const s of route.steps) {
    if (s.kind !== "pool") continue;
    const st = states.get(s.poolId);
    if (!st || !st.initialized) return null;
    hops.push({ sqrtPriceX96: st.sqrtPriceX96, liquidity: st.liquidity, zeroForOne: s.zeroForOne, decimalsIn: decimalsOf(s.currencyIn), decimalsOut: decimalsOf(s.currencyOut) });
  }
  return hops;
}

/**
 * The deepest priced route from `asset` to USDC among `pools`. Wrap and unwrap steps are free, so ETH
 * and WETH share a price. `symbolOf` names the hops for display.
 */
export function usdQuoteFromPools(
  asset: Address,
  pools: readonly PoolState[],
  decimalsOf: (a: string) => number,
  symbolOf: (a: string) => string = (a) => a,
): UsdQuote {
  const states = new Map(pools.map((p) => [p.poolId, p]));
  let best: UsdQuote | null = null;
  for (const route of enumerateRoutes(pools, asset, USDC.address, { weth: WETH.address, maxHops: 3, maxCandidates: 12 })) {
    const hops = routeHops(route, states, decimalsOf);
    const p = hops && priceUsdcRoute(hops);
    if (!p) continue;
    const names = [symbolOf(asset), ...route.steps.filter((s) => s.kind === "pool").map((s) => symbolOf(s.currencyOut))];
    const q = makeUsdQuote(asset, "discovered", names, p);
    if (q.priceUsd !== null && (best === null || q.depthUsd > best.depthUsd)) best = q;
  }
  return best ?? noUsdQuote(asset);
}

/**
 * USD quotes for `assets` (address and decimals) by pool discovery: stablecoins at $1 with unbounded
 * depth, everything else by the deepest route to USDC. Public data.
 */
export async function loadUsdQuotes(
  client: ReadClient,
  assets: readonly { address: Address; decimals: number; symbol?: string }[],
  routing: RoutingConfig = {},
): Promise<Map<string, UsdQuote>> {
  const out = new Map<string, UsdQuote>();
  const targets = assets.filter((a) => !isUsdStable(a.address));
  for (const a of assets) if (isUsdStable(a.address)) out.set(lc(a.address), makeUsdQuote(a.address, "stable", [a.symbol ?? "USD"], { priceUsd: 1, depthUsd: Infinity }));
  if (targets.length === 0) return out;
  const pools = await discoverPools(client, routingNodes(routing, [USDC.address, ...targets.map((a) => a.address)]), routing);
  const decimals = new Map<string, number>([
    [lc(WETH.address), WETH.decimals],
    [lc(ETH.address), ETH.decimals],
    [lc(USDC.address), USDC.decimals],
    [lc(USDT.address), USDT.decimals],
    [lc(DAI.address), DAI.decimals],
    ...assets.map((a) => [lc(a.address), a.decimals] as const),
  ]);
  const symbols = new Map<string, string>([
    [lc(WETH.address), "WETH"],
    [lc(ETH.address), "ETH"],
    [lc(USDC.address), "USDC"],
    [lc(USDT.address), "USDT"],
    [lc(DAI.address), "DAI"],
    ...assets.flatMap((a) => (a.symbol ? [[lc(a.address), a.symbol] as const] : [])),
  ]);
  const decimalsOf = (a: string) => decimals.get(lc(a)) ?? 18;
  const symbolOf = (a: string) => symbols.get(lc(a)) ?? `${a.slice(0, 6)}…${a.slice(-4)}`;
  for (const a of targets) out.set(lc(a.address), usdQuoteFromPools(getAddress(a.address), pools, decimalsOf, symbolOf));
  return out;
}
