import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { stateViewAbi } from "./abis.js";
import { DEFAULT_ENVIRONMENT, DYNAMIC_FEE_FLAG, VARADA_TICK_SPACING } from "./constants.js";
import { SwapError } from "./errors.js";
import type { PoolKey, PoolState, SwapEnvironment } from "./types.js";

/** The minimal client surface the engine reads through (a viem public client satisfies it). */
export type ReadClient = Pick<PublicClient, "readContract"> & Partial<Pick<PublicClient, "multicall">>;

/** Orders two currencies the way pool keys do (ascending by address, native ETH first). */
export function sortCurrencies(a: Address, b: Address): [Address, Address] {
  if (a.toLowerCase() === b.toLowerCase()) throw new RangeError("a pool needs two different currencies");
  return BigInt(a) < BigInt(b) ? [getAddress(a), getAddress(b)] : [getAddress(b), getAddress(a)];
}

export function buildPoolKey(p: { currencyA: Address; currencyB: Address; fee: number; tickSpacing: number; hooks?: Address }): PoolKey {
  const [currency0, currency1] = sortCurrencies(p.currencyA, p.currencyB);
  return {
    currency0,
    currency1,
    fee: p.fee,
    tickSpacing: p.tickSpacing,
    hooks: getAddress(p.hooks ?? "0x0000000000000000000000000000000000000000"),
  };
}

/** The pool key of a Varada token: dynamic fee, tick spacing 200, the token's own hook. */
export function varadaPoolKey(token: Address, quote: Address, hook: Address): PoolKey {
  return buildPoolKey({ currencyA: token, currencyB: quote, fee: DYNAMIC_FEE_FLAG, tickSpacing: VARADA_TICK_SPACING, hooks: hook });
}

/** `PoolId.toId`: keccak256 of the abi-encoded key. */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

export function isDynamicFee(fee: number): boolean {
  return (fee & DYNAMIC_FEE_FLAG) !== 0;
}

/**
 * Runs the same read for many inputs. Uses `multicall` (one round trip) when the client has it and
 * falls back to parallel `readContract` calls.
 */
export async function readSettled<T>(client: ReadClient, calls: readonly { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }[]): Promise<({ ok: true; value: T } | { ok: false; error: unknown })[]> {
  if (calls.length === 0) return [];
  if (typeof client.multicall === "function") {
    try {
      const res = (await client.multicall({ contracts: calls as never, allowFailure: true })) as { status: string; result?: unknown; error?: unknown }[];
      return res.map((r) => (r.status === "success" ? { ok: true as const, value: r.result as T } : { ok: false as const, error: r.error }));
    } catch {
      // chain without a multicall3 entry: fall through to single reads
    }
  }
  return Promise.all(
    calls.map(async (c) => {
      try {
        return { ok: true as const, value: (await client.readContract(c as never)) as T };
      } catch (error) {
        return { ok: false as const, error };
      }
    }),
  );
}

/** Reads slot0 and liquidity of each v4 pool through `StateView`. Pools that revert are reported as uninitialized. */
export async function readPoolStates(client: ReadClient, keys: readonly PoolKey[], env: SwapEnvironment = DEFAULT_ENVIRONMENT): Promise<PoolState[]> {
  const ids = keys.map(poolIdOf);
  const calls = ids.flatMap((id) => [
    { address: env.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [id] },
    { address: env.stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [id] },
  ]);
  const res = await readSettled<unknown>(client, calls);
  return keys.map((key, i) => {
    const slot0 = res[2 * i]!;
    const liq = res[2 * i + 1]!;
    if (!slot0.ok && !liq.ok) {
      // A pure transport failure must not read as "no pool": surface it.
      throw new SwapError("rpc-unavailable", undefined, { cause: slot0.error });
    }
    const [sqrtPriceX96, tick, protocolFee, lpFee] = slot0.ok ? (slot0.value as readonly [bigint, number, number, number]) : [0n, 0, 0, 0];
    return {
      poolId: ids[i]!,
      key,
      sqrtPriceX96,
      tick,
      protocolFee,
      lpFee,
      liquidity: liq.ok ? (liq.value as bigint) : 0n,
      initialized: sqrtPriceX96 > 0n,
    };
  });
}

export async function readPoolState(client: ReadClient, key: PoolKey, env: SwapEnvironment = DEFAULT_ENVIRONMENT): Promise<PoolState> {
  return (await readPoolStates(client, [key], env))[0]!;
}

const Q96 = 2 ** 96;

/** Raw price of currency1 per currency0 (no decimal adjustment) from `sqrtPriceX96`. */
export function rawPrice1Per0(sqrtPriceX96: bigint): number {
  const s = Number(sqrtPriceX96) / Q96;
  return s * s;
}

/** Raw mid price (out per in, base units) for a swap in the given direction. */
export function rawMidPrice(state: Pick<PoolState, "sqrtPriceX96">, zeroForOne: boolean): number {
  const p = rawPrice1Per0(state.sqrtPriceX96);
  return zeroForOne ? p : 1 / p;
}

/** Decimal-adjusts a raw price (out per in) given both currencies' decimals. */
export function adjustPrice(rawPrice: number, decimalsIn: number, decimalsOut: number): number {
  return rawPrice * 10 ** (decimalsIn - decimalsOut);
}
