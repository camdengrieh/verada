import { encodeAbiParameters, keccak256, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { EXTERNAL_ADDRESSES, ONDO_INFRA, isOndoToken } from "@varada/sdk";
import { quoteRegistryAbi, varadaFactoryAbi } from "@varada/sdk/abis";
import type { ImpactStep } from "@varada/ui/components/varada/price-impact-ladder";
import type { AppConfig } from "./config";
import { describeQuoteAsset, type AppQuoteAsset } from "./quote-assets";

/**
 * On-chain market data for the allowlisted quote assets, read without any oracle: the fee route
 * from `QuoteRegistry.routeOf`, each hop's price and liquidity from the v4 StateView, and Ondo's
 * pause manager. USD figures come from the pools themselves (the last hop ends in USDC), so they are
 * what the route would actually convert at, not a quoted price from elsewhere.
 */

const pauseManagerAbi = parseAbi(["function isTokenPaused(address token) view returns (bool)", "function allTokensPaused() view returns (bool)"]);
const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** `PoolId.toId`: keccak256 of the ABI-encoded key. */
export function poolIdOf(k: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );
}

export interface HopPool {
  key: PoolKey;
  sqrtPriceX96: bigint;
  liquidity: bigint;
}

export interface RouteAnalysis {
  /** Hops from the asset to USDC: ["NVDAon", "WETH", "USDC"]. */
  route: string[];
  /** USD per whole token of the asset along this route. */
  priceUsd: number;
  /** Smallest hop depth (both sides of the pool at the current price, in USD). */
  depthUsd: number;
  /** Depth of the asset's own first pool. */
  poolDepthUsd: number;
  /** USD value of each hop's output-side reserve, for the impact estimate. */
  hopReserveUsd: number[];
  /** The pool's two sides in USD, for the split bar (first hop). */
  reserves: { base: { symbol: string; usd: number }; quote: { symbol: string; usd: number } } | null;
}

const Q96 = 2 ** 96;
const SIZES = [100, 1_000, 10_000, 50_000];

/**
 * Walks a route from `asset` to USDC and prices each hop from its pool. "Depth" is the pool's
 * virtual reserves at the current price (what a constant-product pool of the same liquidity would
 * hold), which is what small trades see; concentrated pools can be shallower away from the price.
 * `symbolOf`/`decimalsOf` name and size the currencies along the route.
 */
export function analyseRoute(
  asset: Address,
  hops: readonly HopPool[],
  usdc: Address,
  weth: Address,
  symbolOf: (a: string) => string,
  decimalsOf: (a: string) => number,
): RouteAnalysis | null {
  if (hops.length === 0) return null;
  const lc = (a: string) => a.toLowerCase();
  let cur = lc(asset);
  const names = [symbolOf(cur)];
  const price: number[] = []; // whole `other` per whole `cur`
  const reserveOther: number[] = []; // whole units of `other` held at the current price
  const others: string[] = [];
  const curs: string[] = [];
  for (const h of hops) {
    // WETH unwraps into native ETH for a pool quoted in ETH; treat the zero address as WETH there.
    const c0 = lc(h.key.currency0) === zeroAddress && cur === lc(weth) ? lc(weth) : lc(h.key.currency0);
    const c1 = lc(h.key.currency1) === zeroAddress && cur === lc(weth) ? lc(weth) : lc(h.key.currency1);
    if (cur !== c0 && cur !== c1) return null;
    const other = cur === c0 ? c1 : c0;
    if (h.sqrtPriceX96 === 0n) return null;
    const r = Number(h.sqrtPriceX96) / Q96;
    const raw = r * r; // raw currency1 per raw currency0
    const dCur = decimalsOf(cur);
    const dOther = decimalsOf(other);
    price.push((cur === c0 ? raw : 1 / raw) * 10 ** (dCur - dOther));
    const L = Number(h.liquidity);
    reserveOther.push((other === c1 ? L * r : L / r) / 10 ** dOther);
    curs.push(cur);
    others.push(other);
    names.push(symbolOf(other));
    cur = other;
  }
  if (cur !== lc(usdc)) return null;
  // Back-propagate USD values from the USDC end.
  const usd: number[] = new Array(hops.length + 1);
  usd[hops.length] = 1;
  for (let i = hops.length - 1; i >= 0; i--) usd[i] = usd[i + 1]! * price[i]!;
  const hopReserveUsd = reserveOther.map((res, i) => res * usd[i + 1]!);
  const depths = hopReserveUsd.map((v) => 2 * v);
  const first = hops[0]!;
  const r0 = Number(first.sqrtPriceX96) / Q96;
  const L0 = Number(first.liquidity);
  const baseIs0 = lc(first.key.currency0) === curs[0] || (lc(first.key.currency0) === zeroAddress && curs[0] === lc(weth));
  const baseRes = (baseIs0 ? L0 / r0 : L0 * r0) / 10 ** decimalsOf(curs[0]!);
  return {
    route: names,
    priceUsd: usd[0]!,
    depthUsd: Math.min(...depths),
    poolDepthUsd: depths[0]!,
    hopReserveUsd,
    reserves: { base: { symbol: names[0]!, usd: baseRes * usd[0]! }, quote: { symbol: names[1]!, usd: hopReserveUsd[0]! } },
  };
}

/**
 * Estimated price impact of swapping `size` USD along the route: each hop is a constant-product pool
 * of the hop's reserves, impacts add. Null where the size is at or past half the route's depth.
 */
export function impactLadder(hopReserveUsd: readonly number[], sizes: readonly number[] = SIZES): ImpactStep[] {
  const depth = hopReserveUsd.length ? 2 * Math.min(...hopReserveUsd) : 0;
  return sizes.map((size) => ({
    size,
    impact: depth > 0 && size < depth / 2 ? Number(hopReserveUsd.reduce((sum, r) => sum + (100 * size) / (r + size), 0).toFixed(2)) : null,
  }));
}

export interface QuoteMarketData {
  paused?: boolean;
  route?: string[];
  priceUsd?: number;
  routeDepthUsd?: number;
  poolLiquidityUsd?: number;
  reserves?: RouteAnalysis["reserves"];
  impact?: ImpactStep[];
  /** The registry has no route for this asset, so fees in it cannot convert to USDC. */
  noRoute?: boolean;
}

/** Ondo's pause state for each address: paused when the token or the whole market is paused. Failed reads are left out. */
export async function readOndoPaused(client: PublicClient, addresses: readonly Address[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const ondo = addresses.filter((a) => isOndoToken(a));
  if (ondo.length === 0) return out;
  const pm = ONDO_INFRA.tokenPauseManager;
  const [allResult, ...perToken] = await Promise.all([
    client.readContract({ address: pm, abi: pauseManagerAbi, functionName: "allTokensPaused" }).then(Boolean, () => false),
    ...ondo.map((a) =>
      client.readContract({ address: pm, abi: pauseManagerAbi, functionName: "isTokenPaused", args: [a] }).then(
        (v) => Boolean(v),
        () => null,
      ),
    ),
  ]);
  ondo.forEach((a, i) => {
    const p = perToken[i];
    if (p !== null && p !== undefined) out.set(a.toLowerCase(), Boolean(allResult) || p);
    else if (allResult) out.set(a.toLowerCase(), true);
  });
  return out;
}

/** Routes, prices and depth for the assets, from the quote registry and the v4 StateView. */
export async function readQuoteMarkets(client: PublicClient, cfg: Pick<AppConfig, "factoryAddress">, assets: readonly AppQuoteAsset[]): Promise<Map<string, QuoteMarketData>> {
  const out = new Map<string, QuoteMarketData>();
  const get = (a: string) => out.get(a.toLowerCase()) ?? out.set(a.toLowerCase(), {}).get(a.toLowerCase())!;
  const paused = await readOndoPaused(client, assets.map((a) => a.address)).catch(() => new Map<string, boolean>());
  for (const [a, p] of paused) get(a).paused = p;

  if (!cfg.factoryAddress) return out;
  const registry = (await client.readContract({ address: cfg.factoryAddress, abi: varadaFactoryAbi, functionName: "quoteRegistry" })) as Address;
  const routes = await client.multicall({
    allowFailure: true,
    contracts: assets.map((a) => ({ address: registry, abi: quoteRegistryAbi, functionName: "routeOf" as const, args: [a.address] as const })),
  });
  const keyed: { asset: AppQuoteAsset; keys: PoolKey[] }[] = [];
  routes.forEach((r, i) => {
    if (r.status !== "success") return;
    const keys = (r.result as readonly PoolKey[]).map((k) => ({ currency0: k.currency0, currency1: k.currency1, fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: k.hooks }));
    if (keys.length === 0) get(assets[i]!.address).noRoute = true;
    else keyed.push({ asset: assets[i]!, keys });
  });

  // One multicall for every pool the routes touch.
  const pools = new Map<string, PoolKey>();
  for (const { keys } of keyed) for (const k of keys) pools.set(poolIdOf(k), k);
  const ids = [...pools.keys()] as Hex[];
  const calls = ids.flatMap((id) => [
    { address: EXTERNAL_ADDRESSES.stateView, abi: stateViewAbi, functionName: "getSlot0" as const, args: [id] as const },
    { address: EXTERNAL_ADDRESSES.stateView, abi: stateViewAbi, functionName: "getLiquidity" as const, args: [id] as const },
  ]);
  const state = ids.length ? await client.multicall({ allowFailure: true, contracts: calls }) : [];
  const live = new Map<string, { sqrtPriceX96: bigint; liquidity: bigint }>();
  ids.forEach((id, i) => {
    const s = state[i * 2];
    const l = state[i * 2 + 1];
    if (s?.status === "success" && l?.status === "success") live.set(id, { sqrtPriceX96: (s.result as unknown as readonly [bigint])[0], liquidity: l.result as bigint });
  });

  const decimals = new Map<string, number>([
    [EXTERNAL_ADDRESSES.weth.toLowerCase(), 18],
    [EXTERNAL_ADDRESSES.usdc.toLowerCase(), 6],
    ...assets.map((a) => [a.address.toLowerCase(), a.decimals] as const),
  ]);
  const symbolOf = (a: string) => (a === zeroAddress ? "ETH" : describeQuoteAsset(a).symbol);
  for (const { asset, keys } of keyed) {
    const hops: HopPool[] = [];
    for (const k of keys) {
      const l = live.get(poolIdOf(k));
      if (!l) break;
      hops.push({ key: k, ...l });
    }
    if (hops.length !== keys.length) continue;
    const a = analyseRoute(asset.address, hops, EXTERNAL_ADDRESSES.usdc, EXTERNAL_ADDRESSES.weth, symbolOf, (c) => decimals.get(c.toLowerCase()) ?? 18);
    if (!a) continue;
    Object.assign(get(asset.address), {
      route: a.route,
      priceUsd: a.priceUsd,
      routeDepthUsd: a.depthUsd,
      poolLiquidityUsd: a.poolDepthUsd,
      reserves: a.reserves,
      impact: impactLadder(a.hopReserveUsd),
    } satisfies QuoteMarketData);
  }
  return out;
}

/** Layers market data onto the registry assets. */
export function withQuoteMarkets(assets: readonly AppQuoteAsset[], data: ReadonlyMap<string, QuoteMarketData> | undefined): AppQuoteAsset[] {
  if (!data) return [...assets];
  return assets.map((a) => {
    const m = data.get(a.address.toLowerCase());
    if (!m) return a;
    return {
      ...a,
      paused: m.paused ?? a.paused,
      route: m.route ?? a.route,
      price: m.priceUsd ?? a.price,
      routeDepthUsd: m.routeDepthUsd ?? a.routeDepthUsd,
      poolLiquidityUsd: m.poolLiquidityUsd ?? a.poolLiquidityUsd,
      reserves: m.reserves ?? a.reserves,
      impact: m.impact ?? a.impact,
      launchable: m.noRoute ? { ok: false, reason: "No fee route to USDC is configured" } : a.launchable,
    };
  });
}
