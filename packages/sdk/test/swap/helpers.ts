import type { Address } from "viem";
import { buildPoolKey, poolIdOf, type PoolState } from "../../src/index.js";

export function fakePool(a: Address, b: Address, fee: number, tickSpacing: number, liquidity: bigint, opts: { hooks?: Address; sqrtPriceX96?: bigint; lpFee?: number } = {}): PoolState {
  const key = buildPoolKey({ currencyA: a, currencyB: b, fee, tickSpacing, hooks: opts.hooks });
  return { poolId: poolIdOf(key), key, sqrtPriceX96: opts.sqrtPriceX96 ?? 2n ** 96n, tick: 0, protocolFee: 0, lpFee: opts.lpFee ?? (fee & 0x7fffff), liquidity, initialized: true };
}

export const TOKEN: Address = "0x1111111111111111111111111111111111111111";
export const OTHER: Address = "0x3333333333333333333333333333333333333333";
export const HOOK: Address = "0x2222222222222222222222222222222222222222";
