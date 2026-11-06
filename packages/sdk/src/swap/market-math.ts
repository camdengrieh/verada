/**
 * Display math for a Varada pool. Every token launches as one single-sided position holding the
 * whole supply, from the start price to the end of the usable tick range, and that position is
 * locked, so the pool's reserves follow from its liquidity, the current price and the supply.
 * Floating point: for display (TVL, market cap), never for amounts that are sent.
 */
import { VARADA_TICK_SPACING } from "./constants.js";

const MAX_TICK = 887_272;

/** `TickMath.maxUsableTick(spacing)`. */
export const maxUsableTick = (spacing: number = VARADA_TICK_SPACING): number => Math.floor(MAX_TICK / spacing) * spacing;

/** sqrt(1.0001^tick), the price at a tick in sqrt form (not Q96). */
export const sqrtPriceAtTick = (tick: number): number => Math.pow(1.0001, tick / 2);

export interface PoolReserves {
  /** Raw units. */
  token: number;
  quote: number;
}

/**
 * Reserves of the locked position. `sqrtPrice` is `sqrtPriceX96 / 2^96`, `liquidity` the pool
 * liquidity, `supply` the token's total supply at launch (raw), `tokenIsCurrency0` the pool's order.
 *
 * The position covers [start price, top of range] when the token is currency0 and [bottom of range,
 * start price] otherwise; the start price follows from the supply: all of it sat in the position
 * before the first trade.
 */
export function positionReserves(p: { sqrtPrice: number; liquidity: number; supply: number; tokenIsCurrency0: boolean }): PoolReserves | null {
  const { sqrtPrice: s, liquidity: L, supply: S } = p;
  if (!(s > 0) || !(L > 0) || !(S > 0)) return null;
  if (p.tokenIsCurrency0) {
    const sqrtB = sqrtPriceAtTick(maxUsableTick());
    const sqrtA = 1 / (S / L + 1 / sqrtB);
    const clamped = Math.min(Math.max(s, sqrtA), sqrtB);
    return { token: L * (1 / clamped - 1 / sqrtB), quote: L * (clamped - sqrtA) };
  }
  const sqrtA = sqrtPriceAtTick(-maxUsableTick());
  const sqrtB = S / L + sqrtA;
  const clamped = Math.min(Math.max(s, sqrtA), sqrtB);
  return { token: L * (clamped - sqrtA), quote: L * (1 / clamped - 1 / sqrtB) };
}

/** Quote per whole token (decimal-adjusted) from a pool's sqrt price. */
export function tokenPriceInQuote(p: { sqrtPrice: number; tokenIsCurrency0: boolean; tokenDecimals: number; quoteDecimals: number }): number {
  const raw = p.sqrtPrice * p.sqrtPrice; // currency1 per currency0, raw
  const quotePerTokenRaw = p.tokenIsCurrency0 ? raw : 1 / raw;
  return quotePerTokenRaw * 10 ** (p.tokenDecimals - p.quoteDecimals);
}

