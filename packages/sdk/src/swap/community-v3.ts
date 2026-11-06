/**
 * Router-less swaps through Uniswap v3-style pools the Universal Router cannot reach, such as the
 * community factory that hosts the deepest Ondo stock pools (the Universal Router hard-codes the
 * canonical v3 factory). The swap goes through `V3PoolSwapper`: the user approves the input token to
 * the swapper once and sends one transaction; no Permit2 and no router.
 *
 * The swapper only accepts factories fixed at its deployment and derives each pool from the factory's
 * init code hash, so {@link communityPoolAddress} must use the same hash. The community factory's pools
 * match the canonical hash (checked on a mainnet fork in `V3PoolSwapperFork.t.sol`).
 *
 * Trust: the community factory's operator can create and seed pools of any pair. Pools are plain
 * UniswapV3Pool code, but a deceptive pool can still quote a bad price. Treat `minOut` as mandatory,
 * take it from a price you trust, and prefer the pools returned by {@link discoverFactoryPools}, which
 * ranks by liquidity.
 */
import { concatHex, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import type { ReadClient } from "./pool.js";

export const COMMUNITY_V3_FACTORY: Address = getAddress("0x00a38533c68327aBE0Cc265436e036066E2D6B38");
export const CANONICAL_V3_FACTORY: Address = getAddress("0x1F98431c8aD98523631AE4a59f267346ea31F984");
/** `POOL_INIT_CODE_HASH` of the canonical factory; the community factory deploys the same pool code. */
export const V3_POOL_INIT_CODE_HASH: Hex = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";

/** Fee tiers of the community factory (hundredths of a basis point) next to the canonical ones. */
export const COMMUNITY_V3_FEE_TIERS: readonly number[] = [100, 500, 3000, 6000, 10_000, 15_000, 20_000, 30_000, 50_000];

export const v3PoolSwapperAbi = parseAbi([
  "function swapExactIn(address factory, address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minOut, uint160 sqrtPriceLimitX96, address recipient, uint256 deadline) returns (uint256 spent, uint256 received)",
  "function poolOf(address factory, address tokenA, address tokenB, uint24 fee) view returns (address)",
  "function isAllowedFactory(address factory) view returns (bool)",
]);

const factoryAbi = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);
const poolAbi = parseAbi(["function liquidity() view returns (uint128)", "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)"]);

const lc = (a: string) => a.toLowerCase();

/** CREATE2 address of the pool of (`tokenA`, `tokenB`, `fee`) in `factory`; same derivation as the contract. */
export function communityPoolAddress(factory: Address, tokenA: Address, tokenB: Address, fee: number, initCodeHash: Hex = V3_POOL_INIT_CODE_HASH): Address {
  const [t0, t1] = lc(tokenA) < lc(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA];
  const salt = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }], [t0, t1, fee]));
  const hash = keccak256(concatHex(["0xff", factory, salt, initCodeHash]));
  return getAddress(`0x${hash.slice(-40)}`);
}

export interface FactoryPool {
  factory: Address;
  pool: Address;
  fee: number;
  liquidity: bigint;
  sqrtPriceX96: bigint;
}

/** Live pools of the pair in `factory` for each fee tier, deepest (by in-range liquidity) first. */
export async function discoverFactoryPools(client: ReadClient, factory: Address, tokenA: Address, tokenB: Address, tiers: readonly number[] = COMMUNITY_V3_FEE_TIERS): Promise<FactoryPool[]> {
  const out: FactoryPool[] = [];
  await Promise.all(
    tiers.map(async (fee) => {
      try {
        const pool = (await client.readContract({ address: factory, abi: factoryAbi, functionName: "getPool", args: [tokenA, tokenB, fee] })) as Address;
        if (lc(pool) === zeroAddress) return;
        const [liquidity, slot0] = await Promise.all([
          client.readContract({ address: pool, abi: poolAbi, functionName: "liquidity" }) as Promise<bigint>,
          client.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }) as Promise<readonly [bigint, ...unknown[]]>,
        ]);
        if (slot0[0] === 0n) return;
        out.push({ factory, pool: getAddress(pool), fee, liquidity, sqrtPriceX96: slot0[0] });
      } catch {
        // missing contract or failed read: no pool at this tier
      }
    }),
  );
  return out.sort((a, b) => (a.liquidity === b.liquidity ? 0 : a.liquidity > b.liquidity ? -1 : 1));
}

/** Spot output of `amountIn` of `tokenIn` at the pool's price, before fee and impact. */
export function spotAmountOut(sqrtPriceX96: bigint, tokenIn: Address, tokenOut: Address, amountIn: bigint): bigint {
  const ratioX192 = sqrtPriceX96 * sqrtPriceX96; // token1 per token0
  return lc(tokenIn) < lc(tokenOut) ? (amountIn * ratioX192) >> 192n : (amountIn << 192n) / ratioX192;
}

/** Minimum output after the pool fee and `slippageBps` of impact allowance against spot. */
export function minOutFromSpot(spotOut: bigint, fee: number, slippageBps: number): bigint {
  const feeBps = BigInt(Math.ceil(fee / 100));
  const total = feeBps + BigInt(slippageBps);
  if (total >= 10_000n) return 0n;
  return (spotOut * (10_000n - total)) / 10_000n;
}

export interface CommunitySwapParams {
  swapper: Address;
  factory: Address;
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  amountIn: bigint;
  minOut: bigint;
  recipient: Address;
  /** Unix seconds. */
  deadline: bigint;
  /** Zero (default) means the widest limit in the swap direction. */
  sqrtPriceLimitX96?: bigint;
}

export interface CommunitySwapTx {
  to: Address;
  data: Hex;
  value: 0n;
  /** The input token and spender the user must have approved for at least `amountIn`. */
  approval: { token: Address; spender: Address; amount: bigint };
}

/** One transaction that swaps through the pool, plus the approval it needs. The swapper pulls from the sender. */
export function buildCommunitySwap(p: CommunitySwapParams): CommunitySwapTx {
  if (p.amountIn <= 0n) throw new RangeError("amountIn must be positive");
  if (p.minOut <= 0n) throw new RangeError("minOut must be positive: a router-less swap has no other price protection");
  const data = encodeFunctionData({
    abi: v3PoolSwapperAbi,
    functionName: "swapExactIn",
    args: [p.factory, p.tokenIn, p.tokenOut, p.fee, p.amountIn, p.minOut, p.sqrtPriceLimitX96 ?? 0n, p.recipient, p.deadline],
  });
  return { to: p.swapper, data, value: 0n, approval: { token: p.tokenIn, spender: p.swapper, amount: p.amountIn } };
}
