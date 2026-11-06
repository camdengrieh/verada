import type { Hex } from "viem";
import { v4QuoterAbi } from "./abis.js";
import { DEFAULT_ENVIRONMENT, MAX_UINT128 } from "./constants.js";
import { SwapError, mapSwapError } from "./errors.js";
import { adjustPrice, rawMidPrice, type ReadClient } from "./pool.js";
import { segmentRoute, type RouteSegment } from "./routing.js";
import type { PoolState, QuoteMode, Route, RouteQuote, RouteStep, SwapAsset, SwapEnvironment } from "./types.js";

type PoolStep = Extract<RouteStep, { kind: "pool" }>;

export interface QuoteContext {
  env?: SwapEnvironment;
  tokenIn: SwapAsset;
  tokenOut: SwapAsset;
  /** Pool states by pool id, for mid prices and LP fees. */
  states: ReadonlyMap<string, PoolState>;
  /**
   * Fee in basis points to use for a pool instead of `slot0.lpFee`: the Varada pool's hook fee (its
   * dynamic fee is set per swap by the hook, and the live hook charges through deltas).
   */
  feeBps?: ReadonlyMap<string, number>;
}

const NO_HOOK_DATA: Hex = "0x";

function pathKeys(steps: readonly PoolStep[], mode: QuoteMode) {
  // exact-in: each key names the currency you arrive at; exact-out: the currency you pay into that pool
  return steps.map((s) => ({
    intermediateCurrency: mode === "exactIn" ? s.currencyOut : s.currencyIn,
    fee: s.key.fee,
    tickSpacing: s.key.tickSpacing,
    hooks: s.key.hooks,
    hookData: NO_HOOK_DATA,
  }));
}

/** One v4 segment through the quoter. Returns the other side's amount and the quoter's gas estimate. */
async function quoteSegment(client: ReadClient, seg: Extract<RouteSegment, { kind: "v4" }>, mode: QuoteMode, amount: bigint, env: SwapEnvironment): Promise<{ amount: bigint; gas: bigint }> {
  if (amount <= 0n) throw new SwapError("zero-amount");
  if (amount > MAX_UINT128) throw new SwapError("insufficient-liquidity", "Amount too large");
  try {
    if (seg.steps.length === 1) {
      const s = seg.steps[0]!;
      const params = { poolKey: s.key, zeroForOne: s.zeroForOne, exactAmount: amount, hookData: NO_HOOK_DATA };
      const [out, gas] =
        mode === "exactIn"
          ? await client.readContract({ address: env.quoter, abi: v4QuoterAbi, functionName: "quoteExactInputSingle", args: [params] })
          : await client.readContract({ address: env.quoter, abi: v4QuoterAbi, functionName: "quoteExactOutputSingle", args: [params] });
      return { amount: out, gas };
    }
    const params = { exactCurrency: mode === "exactIn" ? seg.currencyIn : seg.currencyOut, path: pathKeys(seg.steps, mode), exactAmount: amount };
    const [out, gas] =
      mode === "exactIn"
        ? await client.readContract({ address: env.quoter, abi: v4QuoterAbi, functionName: "quoteExactInput", args: [params] })
        : await client.readContract({ address: env.quoter, abi: v4QuoterAbi, functionName: "quoteExactOutput", args: [params] });
    return { amount: out, gas };
  } catch (e) {
    throw mapSwapError(e);
  }
}

/** Fee fraction (0..1) of one pool step. */
function stepFee(s: PoolStep, ctx: QuoteContext): number {
  const override = ctx.feeBps?.get(s.poolId);
  if (override !== undefined) return override / 10_000;
  const state = ctx.states.get(s.poolId);
  return (state?.lpFee ?? s.key.fee) / 1_000_000;
}

/**
 * Mid price (out per in, decimal-adjusted) along a route from the pools' current prices: no fees, no
 * slippage, no RPC. Used for USD pricing and as the price-impact reference.
 */
export function routeMidPrice(route: Route, states: ReadonlyMap<string, PoolState>, decimalsIn: number, decimalsOut: number): number | null {
  let raw = 1;
  for (const s of route.steps) {
    if (s.kind !== "pool") continue;
    const st = states.get(s.poolId);
    if (!st || !st.initialized) return null;
    raw *= rawMidPrice(st, s.zeroForOne);
  }
  return adjustPrice(raw, decimalsIn, decimalsOut);
}

/** Quotes one route through the V4Quoter (exact-in or exact-out). Wrap and unwrap steps convert 1:1. */
export async function quoteRoute(client: ReadClient, route: Route, mode: QuoteMode, amount: bigint, ctx: QuoteContext): Promise<RouteQuote> {
  const env = ctx.env ?? DEFAULT_ENVIRONMENT;
  const segments = segmentRoute(route);
  let gas = 0n;
  let amountIn: bigint;
  let amountOut: bigint;
  if (mode === "exactIn") {
    let a = amount;
    for (const seg of segments) {
      if (seg.kind !== "v4") continue;
      const r = await quoteSegment(client, seg, "exactIn", a, env);
      a = r.amount;
      gas += r.gas;
    }
    amountIn = amount;
    amountOut = a;
  } else {
    let a = amount;
    for (const seg of [...segments].reverse()) {
      if (seg.kind !== "v4") continue;
      const r = await quoteSegment(client, seg, "exactOut", a, env);
      a = r.amount;
      gas += r.gas;
    }
    amountIn = a;
    amountOut = amount;
  }
  if (amountIn === 0n || amountOut === 0n) throw new SwapError("insufficient-liquidity");

  const poolSteps = route.steps.filter((s): s is PoolStep => s.kind === "pool");
  let midRaw = 1;
  let keep = 1;
  for (const s of poolSteps) {
    const st = ctx.states.get(s.poolId);
    if (!st) throw new SwapError("pool-not-initialized", undefined, { detail: s.poolId });
    midRaw *= rawMidPrice(st, s.zeroForOne);
    keep *= 1 - stepFee(s, ctx);
  }
  const midPrice = adjustPrice(midRaw, ctx.tokenIn.decimals, ctx.tokenOut.decimals);
  const executionPrice = Number(amountOut) / 10 ** ctx.tokenOut.decimals / (Number(amountIn) / 10 ** ctx.tokenIn.decimals);
  const priceImpactPct = poolSteps.length === 0 ? 0 : Math.max(0, (1 - executionPrice / (midPrice * keep)) * 100);
  return { mode, route, amountIn, amountOut, midPrice, executionPrice, priceImpactPct, totalFeePct: (1 - keep) * 100, gasEstimate: gas };
}

export interface BestQuote {
  best: RouteQuote;
  /** Every route that quoted, best first. */
  all: RouteQuote[];
  /** Routes the quoter rejected, with the reason. */
  failures: { route: Route; error: SwapError }[];
}

/** Candidate routes quoted at once: public RPCs rate-limit bursts of heavy `eth_call`s. */
export const QUOTE_CONCURRENCY = 4;

/** `Promise.allSettled` over `items` with at most `limit` running at a time, results in input order. */
async function mapSettled<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]!) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * Quotes all candidate routes (at most {@link QUOTE_CONCURRENCY} at a time) and picks the best: highest output for exact-in, lowest
 * input for exact-out. Throws the most informative {@link SwapError} when none quotes.
 */
export async function pickBestQuote(client: ReadClient, routes: readonly Route[], mode: QuoteMode, amount: bigint, ctx: QuoteContext, opts: { concurrency?: number } = {}): Promise<BestQuote> {
  if (routes.length === 0) throw new SwapError("no-route");
  const settled = await mapSettled(routes, opts.concurrency ?? QUOTE_CONCURRENCY, (r) => quoteRoute(client, r, mode, amount, ctx));
  const all: RouteQuote[] = [];
  const failures: BestQuote["failures"] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") all.push(s.value);
    else failures.push({ route: routes[i]!, error: mapSwapError(s.reason) });
  });
  if (all.length === 0) {
    // surface the most specific reason: anything but a generic liquidity miss first
    const specific = failures.find((f) => f.error.reason !== "insufficient-liquidity" && f.error.reason !== "unknown") ?? failures[0]!;
    throw specific.error;
  }
  all.sort((a, b) => (mode === "exactIn" ? (a.amountOut < b.amountOut ? 1 : a.amountOut > b.amountOut ? -1 : 0) : a.amountIn < b.amountIn ? -1 : a.amountIn > b.amountIn ? 1 : 0));
  return { best: all[0]!, all, failures };
}

/** Applies slippage (basis points) to a quote: the least you accept out, or the most you pay in. */
export function applySlippage(quote: Pick<RouteQuote, "mode" | "amountIn" | "amountOut">, slippageBps: number): { amountOutMin: bigint; amountInMax: bigint } {
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) throw new RangeError("slippageBps must be in [0, 10000)");
  const bps = BigInt(Math.round(slippageBps));
  if (quote.mode === "exactIn") {
    return { amountOutMin: (quote.amountOut * (10_000n - bps)) / 10_000n, amountInMax: quote.amountIn };
  }
  // round the maximum up so a quote-sized fill never fails on rounding
  return { amountOutMin: quote.amountOut, amountInMax: (quote.amountIn * (10_000n + bps) + 9_999n) / 10_000n };
}

