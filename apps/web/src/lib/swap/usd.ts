import {
  DAI,
  USDC,
  USDT,
  WETH,
  discoverPools,
  enumerateRoutes,
  routeMidPrice,
  routingNodes,
  ETH,
  type ReadClient,
  type RoutingConfig,
  type SwapAsset,
} from "@varada/sdk";

const STABLES = new Set([USDC.address, USDT.address, DAI.address].map((a) => a.toLowerCase()));

/** Dollar-pegged assets are priced at $1; the others are priced from the deepest-first route to USDC. */
export const isStable = (a: SwapAsset): boolean => STABLES.has(a.address.toLowerCase());

/**
 * USD price of each asset: stablecoins at $1, everything else the mid price of the shortest route
 * of existing v4 pools to USDC (no fees, no slippage). Assets with no route are left out.
 * Public data, so it goes through the public client.
 */
export async function loadUsdPrices(client: ReadClient, assets: readonly SwapAsset[], routing: RoutingConfig = {}): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const volatile = assets.filter((a) => !isStable(a));
  for (const a of assets) if (isStable(a)) out.set(a.address.toLowerCase(), 1);
  if (volatile.length === 0) return out;

  // ETH and WETH are the same price; price one and copy it
  const needEth = volatile.some((a) => a.address.toLowerCase() === ETH.address || a.address.toLowerCase() === WETH.address.toLowerCase());
  const targets = volatile.filter((a) => a.address.toLowerCase() !== WETH.address.toLowerCase() && a.address.toLowerCase() !== ETH.address);
  if (needEth) targets.push(ETH);

  const pools = await discoverPools(client, routingNodes(routing, [USDC.address, ...targets.map((a) => a.address)]), routing);
  const states = new Map(pools.map((p) => [p.poolId, p]));
  for (const a of targets) {
    const routes = enumerateRoutes(pools, a.address, USDC.address, { weth: WETH.address, maxHops: 3 });
    const route = routes[0];
    if (!route) continue;
    const price = routeMidPrice(route, states, a.decimals, USDC.decimals);
    if (price !== null && Number.isFinite(price) && price > 0) out.set(a.address.toLowerCase(), price);
  }
  const eth = out.get(ETH.address);
  if (eth !== undefined) out.set(WETH.address.toLowerCase(), eth);
  return out;
}
