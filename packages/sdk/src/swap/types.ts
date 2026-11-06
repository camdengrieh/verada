import type { Address, Hex } from "viem";
import { zeroAddress } from "viem";

/** The zero address stands for native ETH, as in every Uniswap v4 pool key. */
export const NATIVE_CURRENCY: Address = zeroAddress;

/** A currency a user can pay with or receive. `address` is the zero address for native ETH. */
export interface SwapAsset {
  address: Address;
  symbol: string;
  decimals: number;
}

/** Uniswap v4 `PoolKey`. `currency0 < currency1` by address. */
export interface PoolKey {
  currency0: Address;
  currency1: Address;
  /** LP fee in hundredths of a basis point, or `0x800000` for a dynamic-fee pool. */
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** Live state of a pool read from `StateView`. */
export interface PoolState {
  poolId: Hex;
  key: PoolKey;
  sqrtPriceX96: bigint;
  tick: number;
  /** `slot0.lpFee` (for a dynamic-fee pool this is the last stored fee, not necessarily the one charged). */
  lpFee: number;
  protocolFee: number;
  liquidity: bigint;
  /** The pool was initialized (`sqrtPriceX96 > 0`). */
  initialized: boolean;
}

/** One step of a route. Pool steps swap inside a v4 pool; wrap steps convert between ETH and WETH. */
export type RouteStep =
  | {
      kind: "pool";
      key: PoolKey;
      poolId: Hex;
      zeroForOne: boolean;
      currencyIn: Address;
      currencyOut: Address;
    }
  | { kind: "wrap"; currencyIn: Address; currencyOut: Address }
  | { kind: "unwrap"; currencyIn: Address; currencyOut: Address };

export interface Route {
  steps: RouteStep[];
  currencyIn: Address;
  currencyOut: Address;
}

export type TradeSide = "buy" | "sell";
export type QuoteMode = "exactIn" | "exactOut";

/** Which of the two Varada hooks a token's pool uses. */
export type VaradaMode = "weekly" | "live";

/** Everything the engine needs to know about a Varada token to trade it. */
export interface VaradaMarketToken {
  address: Address;
  symbol: string;
  /** Always 18 for Varada tokens. */
  decimals?: number;
  /** The token's hook (`VaradaHook` or `VaradaLiveHook`), from the indexer's `token.hook`. */
  hook: Address;
  /** The quote asset the token's pool is paired with (WETH or an Ondo token). */
  quote: SwapAsset;
  /** Optional; read from the hook when omitted. */
  mode?: VaradaMode;
}

/** Fee the Varada hook charges right now and where it goes. */
export interface VaradaFeeInfo {
  mode: VaradaMode;
  /** Total fee in basis points (base plus the current launch / anti-sniper surcharge). */
  feeBps: number;
  baseFeeBps: number;
  /** Current surcharge in basis points (zero once the decay window has passed). */
  sniperBps: number;
  sniperActive: boolean;
  /** Unix seconds at which the surcharge reaches zero; null when there never was one. */
  sniperEndsAt: number | null;
  /** The surcharge the token launched with. */
  sniperStartBps: number;
  /** Share of every fee that goes to the cause pool and to the platform, in basis points of the fee. */
  causeShareBps: number;
  platformShareBps: number;
}

/** Quote of one route: amounts, prices and the pieces the trade panel shows. */
export interface RouteQuote {
  mode: QuoteMode;
  route: Route;
  /** Raw amounts. For exact-in `amountIn` is the input, for exact-out `amountOut` is the target. */
  amountIn: bigint;
  amountOut: bigint;
  /** Mid price (out per in, decimal-adjusted) from the pools' current prices, before fees and slippage. */
  midPrice: number;
  /** Price the trade gets (out per in, decimal-adjusted). */
  executionPrice: number;
  /** Price impact in percent, excluding fees (never negative). */
  priceImpactPct: number;
  /** Total fees along the route as a fraction in percent (LP fees plus the Varada fee). */
  totalFeePct: number;
  gasEstimate: bigint;
}

export interface SwapEnvironment {
  weth: Address;
  usdc: Address;
  permit2: Address;
  poolManager: Address;
  stateView: Address;
  quoter: Address;
  universalRouter: Address;
}
