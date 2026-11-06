import { EXTERNAL_ADDRESSES } from "@verada/sdk";
import { parseAbi, toEventSelector } from "viem";

/** Uniswap v4 singleton; every Verada pool lives in it. */
export const POOL_MANAGER = EXTERNAL_ADDRESSES.poolManager;

/** `IPoolManager.Swap`. Amounts are the swapper's deltas: positive is paid out to the swapper. */
export const PoolManagerSwapAbi = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);
export const SWAP_TOPIC = toEventSelector(PoolManagerSwapAbi[0]);
