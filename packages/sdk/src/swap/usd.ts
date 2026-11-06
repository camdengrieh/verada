/**
 * One on-chain USD price per asset, with no external oracle. An asset is priced through a route of
 * Uniswap v4 pools that ends in USDC (the QuoteRegistry's fee route first, pools found by the swap
 * engine as a fallback). Each hop gives a price and a depth, so a price always comes with how much
 * real liquidity stands behind it. Floating point: for display, never for amounts that are sent.
 */

const Q96 = 2 ** 96;

/** One pool along a route, in the direction of travel (asset toward USDC). */
export interface UsdHop {
  sqrtPriceX96: bigint;
  /** Pool liquidity `L` (raw). */
  liquidity: bigint;
  /** True when the hop sells currency0 for currency1, that is the asset we hold is currency0. */
  zeroForOne: boolean;
  decimalsIn: number;
  decimalsOut: number;
}

/** Whole `out` per whole `in` at the pool's current price (inverted pools and any decimals 6/8/18). */
export function hopPriceOutPerIn(h: Pick<UsdHop, "sqrtPriceX96" | "zeroForOne" | "decimalsIn" | "decimalsOut">): number {
  const r = Number(h.sqrtPriceX96) / Q96;
  if (!(r > 0)) return NaN;
  const raw1Per0 = r * r;
  const rawOutPerIn = h.zeroForOne ? raw1Per0 : 1 / raw1Per0;
  return rawOutPerIn * 10 ** (h.decimalsIn - h.decimalsOut);
}

/**
 * Whole units of the hop's output asset held by the pool at the current price (virtual reserves of a
 * constant-product pool with the same liquidity: what small trades see).
 */
export function hopOutReserve(h: Pick<UsdHop, "sqrtPriceX96" | "liquidity" | "zeroForOne" | "decimalsOut">): number {
  const r = Number(h.sqrtPriceX96) / Q96;
  const L = Number(h.liquidity);
  if (!(r > 0) || !(L > 0)) return 0;
  const rawOut = h.zeroForOne ? L * r : L / r; // out is currency1 when selling currency0
  return rawOut / 10 ** h.decimalsOut;
}

export interface UsdRoutePrice {
  /** USD per whole asset (the route ends in a dollar-valued asset: USDC). */
  priceUsd: number;
  /** Thinnest hop: twice the USD value of its output-side reserve. */
  depthUsd: number;
  /** USD value of each hop's output-side reserve, first hop first. */
  hopReserveUsd: number[];
}

/** Price and depth of a route whose last hop pays out USDC (1 USD per unit). Null for an empty or unpriced route. */
export function priceUsdcRoute(hops: readonly UsdHop[]): UsdRoutePrice | null {
  if (hops.length === 0) return null;
  const prices = hops.map(hopPriceOutPerIn);
  if (prices.some((p) => !Number.isFinite(p) || p <= 0)) return null;
  // USD value of one unit held after hop i, back-propagated from the USDC end.
  const usdAfter: number[] = new Array(hops.length);
  let acc = 1;
  for (let i = hops.length - 1; i >= 0; i--) {
    usdAfter[i] = acc;
    acc *= prices[i]!;
  }
  const hopReserveUsd = hops.map((h, i) => hopOutReserve(h) * usdAfter[i]!);
  return { priceUsd: acc, depthUsd: 2 * Math.min(...hopReserveUsd), hopReserveUsd };
}

/** Where a USD price came from. */
export type UsdSource = "stable" | "registry" | "discovered";
/** high: deep enough to trust; low: thin, show "~" and a note; none: no price. */
export type UsdConfidence = "high" | "low" | "none";

/** Below this depth a price is shown as approximate ("~"). */
export const THIN_DEPTH_USD = 25_000;

export interface UsdQuote {
  address: string;
  /** USD per whole unit; null when no route prices the asset. */
  priceUsd: number | null;
  /** Depth of the route behind the price (see {@link priceUsdcRoute}); Infinity for a dollar stablecoin. */
  depthUsd: number;
  confidence: UsdConfidence;
  source: UsdSource | null;
  /** Symbols from the asset to USDC. */
  route: string[];
  /** Ondo only: the US session is closed, so the pool price may lag the reference. */
  marketClosed?: boolean;
}

export function confidenceFor(priceUsd: number | null, depthUsd: number): UsdConfidence {
  if (priceUsd === null || !Number.isFinite(priceUsd) || priceUsd <= 0) return "none";
  return depthUsd >= THIN_DEPTH_USD ? "high" : "low";
}

export function makeUsdQuote(address: string, source: UsdSource, route: string[], p: Pick<UsdRoutePrice, "priceUsd" | "depthUsd">, marketClosed?: boolean): UsdQuote {
  const confidence = confidenceFor(p.priceUsd, p.depthUsd);
  return {
    address: address.toLowerCase(),
    priceUsd: confidence === "none" ? null : p.priceUsd,
    depthUsd: p.depthUsd,
    confidence,
    source: confidence === "none" ? null : source,
    route,
    ...(marketClosed ? { marketClosed: true } : {}),
  };
}

export const noUsdQuote = (address: string): UsdQuote => ({ address: address.toLowerCase(), priceUsd: null, depthUsd: 0, confidence: "none", source: null, route: [] });

/** The deepest priced candidate; ties keep the earlier one, so list the registry route first. */
export function deepestUsdQuote(address: string, candidates: readonly (UsdQuote | null | undefined)[]): UsdQuote {
  let best: UsdQuote | null = null;
  for (const c of candidates) {
    if (!c || c.priceUsd === null) continue;
    if (best === null || c.depthUsd > best.depthUsd) best = c;
  }
  return best ?? noUsdQuote(address);
}

/** Registry route first; the discovered route only when the registry has none or is thinner. */
export function pickUsdQuote(address: string, registry: UsdQuote | null | undefined, discovered: UsdQuote | null | undefined): UsdQuote {
  return deepestUsdQuote(address, [registry, discovered]);
}

export interface UsdValue {
  usd: number;
  /** Show "~": the price is thin or the market is closed. */
  approx: boolean;
}

/** Value of `amount` whole units at the quote; null when there is no price. */
export function usdValue(amount: number, q: UsdQuote | null | undefined): UsdValue | null {
  if (!q || q.priceUsd === null || !Number.isFinite(amount)) return null;
  return { usd: amount * q.priceUsd, approx: q.confidence !== "high" || Boolean(q.marketClosed) };
}

/** Notes to print next to a figure priced by `q`; empty when the price is firm. */
export function usdNotes(q: UsdQuote | null | undefined): string[] {
  if (!q || q.priceUsd === null) return [];
  const out: string[] = [];
  if (q.confidence === "low") out.push("Thin liquidity: the price can move on small trades.");
  if (q.marketClosed) out.push("US market closed: the pool price may lag the reference.");
  return out;
}

/** Orders items deepest first; items without a price go last, ties by name. */
export function rankByDepth<T>(items: readonly T[], depthOf: (t: T) => number | null | undefined, nameOf: (t: T) => string): T[] {
  const d = (t: T) => {
    const v = depthOf(t);
    return v === null || v === undefined || Number.isNaN(v) ? -1 : v;
  };
  return [...items].sort((a, b) => d(b) - d(a) || nameOf(a).localeCompare(nameOf(b)));
}
