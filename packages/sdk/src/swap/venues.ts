/**
 * Uniswap v3 and v2 as extra venues next to v4: pool discovery (factory `getPool` / `getPair`, then
 * `slot0` + `liquidity` or `getReserves`), path encoding and quotes (`QuoterV2`, Router02 `getAmountsOut`).
 *
 * v3 and v2 pools trade WETH; native ETH reaches them through the route's wrap step. Pools are returned as
 * {@link PoolState}s (see its doc) so ranking, mid prices and price impact treat every venue alike.
 */
import { encodePacked, getAddress, zeroAddress, type Address, type Hex } from "viem";
import { v2FactoryAbi, v2PairAbi, v2RouterAbi, v3FactoryAbi, v3PoolAbi, v3QuoterAbi } from "./abis-venues.js";
import { DEFAULT_ENVIRONMENT, MAX_UINT128, V2_FEE, V3_FEE_TIERS } from "./constants.js";
import { SwapError, mapSwapError } from "./errors.js";
import { buildPoolKey, readSettled, type ReadClient } from "./pool.js";
import { NATIVE_CURRENCY, type PoolState, type RouteStep, type SwapEnvironment, type SwapVenue } from "./types.js";

export type PoolStep = Extract<RouteStep, { kind: "pool" }>;

/** Which venues a search covers. Default: all three. */
export interface VenueConfig {
  v4?: boolean;
  v3?: boolean;
  v2?: boolean;
}

export const stepVenue = (s: { venue?: SwapVenue }): SwapVenue => s.venue ?? "v4";

/** Venues a route trades on, in order of first use. */
export function routeVenues(route: { steps: readonly RouteStep[] }): SwapVenue[] {
  const seen: SwapVenue[] = [];
  for (const s of route.steps) if (s.kind === "pool" && !seen.includes(stepVenue(s))) seen.push(stepVenue(s));
  return seen;
}

const lc = (a: string) => a.toLowerCase();

/** The ERC-20 a node trades as on v3 / v2: native ETH is WETH. */
const asErc20 = (a: Address, weth: Address): Address => (lc(a) === NATIVE_CURRENCY ? weth : a);

/**
 * Unordered ERC-20 pairs among `nodes` (native ETH folded into WETH). With `core`, only pairs that include a core
 * node, like the v4 candidates (satellites connect to the hubs, not to each other).
 */
export function candidatePairs(nodes: readonly Address[], weth: Address, core?: readonly Address[]): [Address, Address][] {
  const uniq = new Map<string, Address>();
  for (const n of nodes) uniq.set(lc(asErc20(n, weth)), getAddress(asErc20(n, weth)));
  const list = [...uniq.values()];
  const coreSet = core ? new Set(core.map((c) => lc(asErc20(c, weth)))) : null;
  const out: [Address, Address][] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (coreSet && !coreSet.has(lc(list[i]!)) && !coreSet.has(lc(list[j]!))) continue;
      out.push([list[i]!, list[j]!]);
    }
  }
  return out;
}

/** Integer square root (Newton). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt of a negative number");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** Finds the live v3 pools of each pair in the fee tiers. Missing contracts / failed reads mean "no pool". */
export async function discoverV3Pools(client: ReadClient, pairs: readonly (readonly [Address, Address])[], env: SwapEnvironment = DEFAULT_ENVIRONMENT, tiers: readonly number[] = V3_FEE_TIERS): Promise<PoolState[]> {
  const lookups = pairs.flatMap(([a, b]) => tiers.map((fee) => ({ a, b, fee })));
  const found = await readSettled<Address>(
    client,
    lookups.map((l) => ({ address: env.v3Factory, abi: v3FactoryAbi, functionName: "getPool", args: [l.a, l.b, l.fee] })),
  );
  const pools = lookups.flatMap((l, i) => {
    const r = found[i]!;
    return r.ok && lc(r.value) !== zeroAddress ? [{ ...l, pool: getAddress(r.value) }] : [];
  });
  const reads = await readSettled<unknown>(
    client,
    pools.flatMap((p) => [
      { address: p.pool, abi: v3PoolAbi, functionName: "slot0" },
      { address: p.pool, abi: v3PoolAbi, functionName: "liquidity" },
    ]),
  );
  const out: PoolState[] = [];
  pools.forEach((p, i) => {
    const slot0 = reads[2 * i]!;
    const liq = reads[2 * i + 1]!;
    if (!slot0.ok || !liq.ok) return;
    const [sqrtPriceX96, tick] = slot0.value as readonly [bigint, number];
    out.push({
      venue: "v3",
      address: p.pool,
      poolId: lc(p.pool) as Hex,
      key: buildPoolKey({ currencyA: p.a, currencyB: p.b, fee: p.fee, tickSpacing: 0 }),
      sqrtPriceX96,
      tick,
      protocolFee: 0,
      lpFee: p.fee,
      liquidity: liq.value as bigint,
      initialized: sqrtPriceX96 > 0n,
    });
  });
  return out;
}

/** Finds the live v2 pairs of each pair of tokens, as constant-product {@link PoolState}s. */
export async function discoverV2Pairs(client: ReadClient, pairs: readonly (readonly [Address, Address])[], env: SwapEnvironment = DEFAULT_ENVIRONMENT): Promise<PoolState[]> {
  const found = await readSettled<Address>(
    client,
    pairs.map(([a, b]) => ({ address: env.v2Factory, abi: v2FactoryAbi, functionName: "getPair", args: [a, b] })),
  );
  const existing = pairs.flatMap(([a, b], i) => {
    const r = found[i]!;
    return r.ok && lc(r.value) !== zeroAddress ? [{ a, b, pair: getAddress(r.value) }] : [];
  });
  const reserves = await readSettled<readonly [bigint, bigint, number]>(
    client,
    existing.map((p) => ({ address: p.pair, abi: v2PairAbi, functionName: "getReserves" })),
  );
  const out: PoolState[] = [];
  existing.forEach((p, i) => {
    const r = reserves[i]!;
    if (!r.ok) return;
    const [r0, r1] = r.value;
    if (r0 === 0n || r1 === 0n) return;
    out.push({
      venue: "v2",
      address: p.pair,
      poolId: lc(p.pair) as Hex,
      key: buildPoolKey({ currencyA: p.a, currencyB: p.b, fee: V2_FEE, tickSpacing: 0 }),
      sqrtPriceX96: isqrt((r1 << 192n) / r0),
      tick: 0,
      protocolFee: 0,
      lpFee: V2_FEE,
      liquidity: isqrt(r0 * r1),
      initialized: true,
    });
  });
  return out;
}

/** `token | fee | token | fee | token`, packed: the exact-in order, or reversed for exact-out. */
export function v3Path(steps: readonly PoolStep[], mode: "exactIn" | "exactOut"): Hex {
  const types: ("address" | "uint24")[] = [];
  const values: (Address | number)[] = [];
  if (mode === "exactIn") {
    steps.forEach((s, i) => {
      if (i === 0) {
        types.push("address");
        values.push(s.currencyIn);
      }
      types.push("uint24", "address");
      values.push(s.key.fee, s.currencyOut);
    });
  } else {
    [...steps].reverse().forEach((s, i) => {
      if (i === 0) {
        types.push("address");
        values.push(s.currencyOut);
      }
      types.push("uint24", "address");
      values.push(s.key.fee, s.currencyIn);
    });
  }
  return encodePacked(types, values);
}

/** The token addresses a v2 segment swaps along, in trade order. */
export function v2Path(steps: readonly PoolStep[]): Address[] {
  return [steps[0]!.currencyIn, ...steps.map((s) => s.currencyOut)];
}

/** Gas a v2 hop costs, for the estimate (the router has no gas quote). */
export const V2_HOP_GAS = 110_000n;

/** One v3 segment through `QuoterV2`. Returns the other side's amount and the quoter's gas estimate. */
export async function quoteV3Segment(client: ReadClient, steps: readonly PoolStep[], mode: "exactIn" | "exactOut", amount: bigint, env: SwapEnvironment): Promise<{ amount: bigint; gas: bigint }> {
  if (amount <= 0n) throw new SwapError("zero-amount");
  try {
    const path = v3Path(steps, mode);
    const res =
      mode === "exactIn"
        ? await client.readContract({ address: env.v3Quoter, abi: v3QuoterAbi, functionName: "quoteExactInput", args: [path, amount] })
        : await client.readContract({ address: env.v3Quoter, abi: v3QuoterAbi, functionName: "quoteExactOutput", args: [path, amount] });
    return { amount: res[0], gas: res[3] };
  } catch (e) {
    throw mapSwapError(e);
  }
}

/** One v2 segment through Router02 `getAmountsOut` / `getAmountsIn`. */
export async function quoteV2Segment(client: ReadClient, steps: readonly PoolStep[], mode: "exactIn" | "exactOut", amount: bigint, env: SwapEnvironment): Promise<{ amount: bigint; gas: bigint }> {
  if (amount <= 0n) throw new SwapError("zero-amount");
  if (amount > MAX_UINT128) throw new SwapError("insufficient-liquidity", "Amount too large");
  try {
    const path = v2Path(steps);
    const amounts =
      mode === "exactIn"
        ? await client.readContract({ address: env.v2Router, abi: v2RouterAbi, functionName: "getAmountsOut", args: [amount, path] })
        : await client.readContract({ address: env.v2Router, abi: v2RouterAbi, functionName: "getAmountsIn", args: [amount, path] });
    return { amount: mode === "exactIn" ? amounts[amounts.length - 1]! : amounts[0]!, gas: V2_HOP_GAS * BigInt(steps.length) };
  } catch (e) {
    throw mapSwapError(e);
  }
}
