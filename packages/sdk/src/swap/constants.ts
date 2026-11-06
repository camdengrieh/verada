import { getAddress, type Address } from "viem";
import { EXTERNAL_ADDRESSES } from "../addresses.js";
import { PLATFORM_SHARE_BPS } from "../feeMath.js";
import { NATIVE_CURRENCY, type SwapAsset, type SwapEnvironment } from "./types.js";

/** `LPFeeLibrary.DYNAMIC_FEE_FLAG`: the `fee` of every Varada pool key. */
export const DYNAMIC_FEE_FLAG = 0x800000;

/** `VaradaFactory.TICK_SPACING` (asserted against the contract in the fork test). */
export const VARADA_TICK_SPACING = 200;

export const VARADA_TOKEN_DECIMALS = 18;

/** Share of every Varada fee that reaches the cause pool and the platform (10 / 90). */
export const PLATFORM_FEE_SHARE_BPS = Number(PLATFORM_SHARE_BPS);
export const CAUSE_FEE_SHARE_BPS = 10_000 - PLATFORM_FEE_SHARE_BPS;

export const ETH: SwapAsset = { address: NATIVE_CURRENCY, symbol: "ETH", decimals: 18 };
export const WETH: SwapAsset = { address: EXTERNAL_ADDRESSES.weth, symbol: "WETH", decimals: 18 };
export const USDC: SwapAsset = { address: EXTERNAL_ADDRESSES.usdc, symbol: "USDC", decimals: 6 };
export const USDT: SwapAsset = { address: getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7"), symbol: "USDT", decimals: 6 };
export const DAI: SwapAsset = { address: getAddress("0x6B175474E89094C44Da98b954EedeAC495271d0F"), symbol: "DAI", decimals: 18 };
export const WBTC: SwapAsset = { address: getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"), symbol: "WBTC", decimals: 8 };

/**
 * Assets a user can pay with and that routes may pass through. Configurable per call; this is the
 * default set. Ondo tokens enter a route as the destination's quote asset or through
 * `extraHubs`, never from this list.
 */
export const DEFAULT_HUBS: readonly SwapAsset[] = [ETH, WETH, USDC, USDT, DAI, WBTC];

/**
 * Uniswap v4 fee tiers searched by default: the four standard ones with their usual tick spacings,
 * plus 1% with tick spacing 100, which mainnet Ondo pools use (e.g. AMZNon / USDC). v4 lets a pool
 * pick any fee and spacing, so a pool outside this list is invisible to the route finder: pass
 * `feeTiers` to search more.
 */
export const DEFAULT_FEE_TIERS: readonly { fee: number; tickSpacing: number }[] = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10_000, tickSpacing: 200 },
  { fee: 10_000, tickSpacing: 100 },
];

export const DEFAULT_ENVIRONMENT: SwapEnvironment = {
  weth: EXTERNAL_ADDRESSES.weth,
  usdc: EXTERNAL_ADDRESSES.usdc,
  permit2: EXTERNAL_ADDRESSES.permit2,
  poolManager: EXTERNAL_ADDRESSES.poolManager,
  stateView: EXTERNAL_ADDRESSES.stateView,
  quoter: EXTERNAL_ADDRESSES.quoter,
  universalRouter: EXTERNAL_ADDRESSES.universalRouter,
};

export const MAX_ROUTE_POOL_HOPS = 3;

/** Universal Router command bytes (`Commands.sol`). */
export const UR_COMMAND = {
  V3_SWAP_EXACT_IN: 0x00,
  V3_SWAP_EXACT_OUT: 0x01,
  SWEEP: 0x04,
  PERMIT2_PERMIT: 0x0a,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  PERMIT2_TRANSFER_FROM: 0x0d,
  V4_SWAP: 0x10,
} as const;

/** v4 router action bytes (`Actions.sol`). */
export const V4_ACTION = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SWAP_EXACT_IN: 0x07,
  SWAP_EXACT_OUT_SINGLE: 0x08,
  SWAP_EXACT_OUT: 0x09,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
  SWEEP: 0x14,
} as const;

/** `ActionConstants.sol`: sentinel recipients and amounts understood by the routers. */
export const ROUTER_MSG_SENDER: Address = "0x0000000000000000000000000000000000000001";
export const ROUTER_ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";
/** Settle / take the whole open delta. */
export const OPEN_DELTA = 0n;
/** Use the router's whole balance of the currency. */
export const CONTRACT_BALANCE = 1n << 255n;
export const MAX_UINT160 = (1n << 160n) - 1n;
export const MAX_UINT128 = (1n << 128n) - 1n;
export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT48 = (1n << 48n) - 1n;
