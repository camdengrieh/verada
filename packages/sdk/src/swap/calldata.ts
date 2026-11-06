/**
 * Universal Router calldata for a route: `execute(commands, inputs, deadline)`.
 *
 * Each v3 segment becomes one `V3_SWAP_EXACT_IN` / `V3_SWAP_EXACT_OUT` (a packed path), each v2 segment one
 * `V2_SWAP_EXACT_IN` / `V2_SWAP_EXACT_OUT`; between segments the output sits in the router
 * (recipient `ADDRESS_THIS`) and the next segment spends `CONTRACT_BALANCE`. The slippage limit is the swap
 * command's own minimum out / maximum in.
 *
 * Each v4 segment of the route becomes one `V4_SWAP` command with the v4 router actions
 * `SWAP_EXACT_IN_SINGLE` / `SWAP_EXACT_IN` (or the exact-out forms) followed by `SETTLE_ALL` and
 * `TAKE_ALL`. ETH <-> WETH steps are `WRAP_ETH` / `UNWRAP_WETH` commands; value that stays inside
 * the router between commands is settled from the router's own balance. The slippage limit is
 * enforced on chain by the closing `TAKE_ALL` (minimum out), `UNWRAP_WETH` / `SWEEP` (minimum out) or
 * `SETTLE_ALL` (maximum in).
 */
import { encodeAbiParameters, encodeFunctionData, toHex, type Address, type Hex } from "viem";
import { universalRouterAbi } from "./abis.js";
import {
  CONTRACT_BALANCE,
  DEFAULT_ENVIRONMENT,
  MAX_UINT128,
  OPEN_DELTA,
  ROUTER_ADDRESS_THIS,
  ROUTER_MSG_SENDER,
  UR_COMMAND,
  V4_ACTION,
} from "./constants.js";
import { SwapError } from "./errors.js";
import type { PermitSingle } from "./permit2.js";
import { segmentRoute, type RouteSegment } from "./routing.js";
import { v2Path, v3Path } from "./venues.js";
import { NATIVE_CURRENCY, type PoolKey, type QuoteMode, type Route, type RouteStep, type SwapEnvironment } from "./types.js";

type PoolStep = Extract<RouteStep, { kind: "pool" }>;
type V4Segment = Extract<RouteSegment, { kind: "v4" }>;
type PackedSegment = Extract<RouteSegment, { kind: "v3" | "v2" }>;

const poolKeyParam = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

const pathKeyParam = {
  type: "tuple[]",
  components: [
    { name: "intermediateCurrency", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
    { name: "hookData", type: "bytes" },
  ],
} as const;

const exactInSingle = [
  { type: "tuple", components: [{ name: "poolKey", ...poolKeyParam }, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" }] },
] as const;
const exactInMulti = [
  { type: "tuple", components: [{ name: "currencyIn", type: "address" }, { name: "path", ...pathKeyParam }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }] },
] as const;
const exactOutSingle = [
  { type: "tuple", components: [{ name: "poolKey", ...poolKeyParam }, { name: "zeroForOne", type: "bool" }, { name: "amountOut", type: "uint128" }, { name: "amountInMaximum", type: "uint128" }, { name: "hookData", type: "bytes" }] },
] as const;
const exactOutMulti = [
  { type: "tuple", components: [{ name: "currencyOut", type: "address" }, { name: "path", ...pathKeyParam }, { name: "amountOut", type: "uint128" }, { name: "amountInMaximum", type: "uint128" }] },
] as const;

const NO_HOOK_DATA: Hex = "0x";
const asKey = (k: PoolKey) => ({ currency0: k.currency0, currency1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks });

function u128(v: bigint, what: string): bigint {
  if (v < 0n || v > MAX_UINT128) throw new RangeError(`${what} does not fit in uint128`);
  return v;
}

/** abi.encode(Currency, uint256): SETTLE_ALL (maxAmount) and TAKE_ALL (minAmount). */
const currencyAmount = (c: Address, n: bigint): Hex => encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [c, n]);

class Actions {
  readonly bytes: number[] = [];
  readonly params: Hex[] = [];
  add(action: number, param: Hex) {
    this.bytes.push(action);
    this.params.push(param);
  }
  encode(): Hex {
    return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [toHex(Uint8Array.from(this.bytes)), this.params]);
  }
}

function swapExactIn(a: Actions, seg: V4Segment, amountIn: bigint, amountOutMinimum: bigint) {
  if (seg.steps.length === 1) {
    const s = seg.steps[0] as PoolStep;
    a.add(V4_ACTION.SWAP_EXACT_IN_SINGLE, encodeAbiParameters(exactInSingle, [{ poolKey: asKey(s.key), zeroForOne: s.zeroForOne, amountIn: u128(amountIn, "amountIn"), amountOutMinimum: u128(amountOutMinimum, "amountOutMinimum"), hookData: NO_HOOK_DATA }]));
    return;
  }
  const path = seg.steps.map((s) => ({ intermediateCurrency: s.currencyOut, fee: s.key.fee, tickSpacing: s.key.tickSpacing, hooks: s.key.hooks, hookData: NO_HOOK_DATA }));
  a.add(V4_ACTION.SWAP_EXACT_IN, encodeAbiParameters(exactInMulti, [{ currencyIn: seg.currencyIn, path, amountIn: u128(amountIn, "amountIn"), amountOutMinimum: u128(amountOutMinimum, "amountOutMinimum") }]));
}

function swapExactOut(a: Actions, seg: V4Segment, amountOut: bigint, amountInMaximum: bigint) {
  if (seg.steps.length === 1) {
    const s = seg.steps[0] as PoolStep;
    a.add(V4_ACTION.SWAP_EXACT_OUT_SINGLE, encodeAbiParameters(exactOutSingle, [{ poolKey: asKey(s.key), zeroForOne: s.zeroForOne, amountOut: u128(amountOut, "amountOut"), amountInMaximum: u128(amountInMaximum, "amountInMaximum"), hookData: NO_HOOK_DATA }]));
    return;
  }
  // exact-out paths name, for each pool, the currency paid into it
  const path = seg.steps.map((s) => ({ intermediateCurrency: s.currencyIn, fee: s.key.fee, tickSpacing: s.key.tickSpacing, hooks: s.key.hooks, hookData: NO_HOOK_DATA }));
  a.add(V4_ACTION.SWAP_EXACT_OUT, encodeAbiParameters(exactOutMulti, [{ currencyOut: seg.currencyOut, path, amountOut: u128(amountOut, "amountOut"), amountInMaximum: u128(amountInMaximum, "amountInMaximum") }]));
}

const v3InAbi = [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }] as const;
const v2InAbi = [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "address[]" }, { type: "bool" }] as const;

/**
 * One v3 / v2 swap command. Exact-in: `a` is the amount in and `b` the minimum out. Exact-out: `a` is the
 * amount out and `b` the maximum in. `payerIsUser` pulls the input from the user through Permit2, otherwise from
 * the router's own balance.
 */
function packedSwap(cmds: Commands, seg: PackedSegment, mode: QuoteMode, recipient: Address, a: bigint, b: bigint, payerIsUser: boolean) {
  if (seg.kind === "v3") {
    cmds.add(mode === "exactIn" ? UR_COMMAND.V3_SWAP_EXACT_IN : UR_COMMAND.V3_SWAP_EXACT_OUT, encodeAbiParameters(v3InAbi, [recipient, a, b, v3Path(seg.steps, mode), payerIsUser]));
  } else {
    cmds.add(mode === "exactIn" ? UR_COMMAND.V2_SWAP_EXACT_IN : UR_COMMAND.V2_SWAP_EXACT_OUT, encodeAbiParameters(v2InAbi, [recipient, a, b, v2Path(seg.steps), payerIsUser]));
  }
}

const settle = (currency: Address, amount: bigint, payerIsUser: boolean): Hex => encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], [currency, amount, payerIsUser]);
const take = (currency: Address, recipient: Address, amount: bigint): Hex => encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [currency, recipient, amount]);

class Commands {
  readonly bytes: number[] = [];
  readonly inputs: Hex[] = [];
  add(cmd: number, input: Hex) {
    this.bytes.push(cmd);
    this.inputs.push(input);
  }
}

const permitAbi = [
  {
    type: "tuple",
    components: [
      { name: "details", type: "tuple", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }] },
      { name: "spender", type: "address" },
      { name: "sigDeadline", type: "uint256" },
    ],
  },
  { type: "bytes" },
] as const;

export interface SwapCalldataParams {
  route: Route;
  mode: QuoteMode;
  /** Exact-in: the input amount. Exact-out: the maximum input (what is approved / sent as value). */
  amountIn: bigint;
  /** Exact-in: the minimum output. Exact-out: the exact output. */
  amountOut: bigint;
  /** Unix seconds after which the router reverts. */
  deadline: number;
  /** A signed Permit2 permit to consume first (ERC-20 inputs without a sufficient Permit2 allowance). */
  permit?: { permit: PermitSingle; signature: Hex };
  env?: SwapEnvironment;
}

export interface BuiltTransaction {
  to: Address;
  data: Hex;
  /** Wei to send: the input amount for native ETH inputs, else zero. */
  value: bigint;
}

/**
 * Encodes the Universal Router call. For exact-in `amountIn` is spent and `amountOut` is the
 * minimum accepted; for exact-out `amountOut` is delivered and `amountIn` is the maximum paid.
 * Exact-out supports a single segment of one venue (v4, v3 or v2; a v3 / v2 path may have several hops),
 * optionally after an ETH -> WETH wrap (the unused WETH is unwrapped and returned); other shapes throw
 * `exact-out-unsupported`.
 */
export function buildSwapCalldata(p: SwapCalldataParams): BuiltTransaction {
  const env = p.env ?? DEFAULT_ENVIRONMENT;
  const segments = segmentRoute(p.route);
  if (segments.length === 0) throw new SwapError("no-route");
  if (p.amountIn <= 0n || p.amountOut <= 0n) throw new SwapError("zero-amount");
  const nativeIn = p.route.currencyIn.toLowerCase() === NATIVE_CURRENCY;
  const cmds = new Commands();

  if (p.permit && !nativeIn) {
    cmds.add(UR_COMMAND.PERMIT2_PERMIT, encodeAbiParameters(permitAbi, [p.permit.permit, p.permit.signature]));
  }

  if (p.mode === "exactOut") {
    buildExactOut(cmds, segments, p, nativeIn);
  } else {
    buildExactIn(cmds, segments, p);
  }

  const data = encodeFunctionData({
    abi: universalRouterAbi,
    functionName: "execute",
    args: [toHex(Uint8Array.from(cmds.bytes)), cmds.inputs, BigInt(p.deadline)],
  });
  return { to: env.universalRouter, data, value: nativeIn ? p.amountIn : 0n };
}

function buildExactIn(cmds: Commands, segments: RouteSegment[], p: SwapCalldataParams) {
  const last = segments.length - 1;
  segments.forEach((seg, i) => {
    const fromUser = i === 0;
    const isLast = i === last;
    if (seg.kind === "wrap") {
      // ETH in: the router holds msg.value; wrap what is there (or the user's whole input)
      cmds.add(UR_COMMAND.WRAP_ETH, encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ROUTER_ADDRESS_THIS, fromUser ? p.amountIn : CONTRACT_BALANCE]));
      if (isLast) cmds.add(UR_COMMAND.SWEEP, sweep(seg.currencyOut, p.amountOut));
      return;
    }
    if (seg.kind === "unwrap") {
      if (fromUser) {
        cmds.add(UR_COMMAND.PERMIT2_TRANSFER_FROM, encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint160" }], [seg.currencyIn, ROUTER_ADDRESS_THIS, p.amountIn]));
      }
      // unwraps the router's whole WETH balance; only the last step has a minimum to enforce
      cmds.add(UR_COMMAND.UNWRAP_WETH, encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [isLast ? ROUTER_MSG_SENDER : ROUTER_ADDRESS_THIS, isLast ? p.amountOut : 0n]));
      return;
    }
    if (seg.kind === "v3" || seg.kind === "v2") {
      packedSwap(cmds, seg, "exactIn", isLast ? ROUTER_MSG_SENDER : ROUTER_ADDRESS_THIS, fromUser ? p.amountIn : CONTRACT_BALANCE, isLast ? p.amountOut : 0n, fromUser);
      return;
    }
    const a = new Actions();
    if (fromUser) {
      swapExactIn(a, seg, p.amountIn, isLast ? p.amountOut : 0n);
      a.add(V4_ACTION.SETTLE_ALL, currencyAmount(seg.currencyIn, p.amountIn));
    } else {
      // the input is already in the router: credit it to the pool manager first, then spend the credit
      a.add(V4_ACTION.SETTLE, settle(seg.currencyIn, CONTRACT_BALANCE, false));
      swapExactIn(a, seg, OPEN_DELTA, isLast ? p.amountOut : 0n);
    }
    if (isLast) a.add(V4_ACTION.TAKE_ALL, currencyAmount(seg.currencyOut, p.amountOut));
    else a.add(V4_ACTION.TAKE, take(seg.currencyOut, ROUTER_ADDRESS_THIS, OPEN_DELTA));
    cmds.add(UR_COMMAND.V4_SWAP, a.encode());
  });
}

function sweep(token: Address, amountMin: bigint): Hex {
  return encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [token, ROUTER_MSG_SENDER, amountMin]);
}

function buildExactOut(cmds: Commands, segments: RouteSegment[], p: SwapCalldataParams, nativeIn: boolean) {
  const wrapFirst = segments[0]?.kind === "wrap";
  // a v3 / v2 swap can end in WETH that is unwrapped to ETH for the user
  const lastSeg = segments[segments.length - 1];
  const unwrapLast = segments.length === 2 && lastSeg?.kind === "unwrap" && (segments[0]!.kind === "v3" || segments[0]!.kind === "v2");
  const rest = wrapFirst ? segments.slice(1) : unwrapLast ? segments.slice(0, 1) : segments;
  if (rest.length !== 1 || rest[0]!.kind === "wrap" || rest[0]!.kind === "unwrap") {
    throw new SwapError("exact-out-unsupported", "Exact-output works for one swap on one venue, optionally paid in ETH through a wrap");
  }
  if (rest[0]!.kind === "v3" || rest[0]!.kind === "v2") {
    // the router pulls what the swap needs (at most amountIn) from the user, or spends the wrapped ETH it holds
    if (wrapFirst) cmds.add(UR_COMMAND.WRAP_ETH, encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ROUTER_ADDRESS_THIS, p.amountIn]));
    packedSwap(cmds, rest[0] as PackedSegment, "exactOut", unwrapLast ? ROUTER_ADDRESS_THIS : ROUTER_MSG_SENDER, p.amountOut, p.amountIn, !wrapFirst);
    if (unwrapLast) cmds.add(UR_COMMAND.UNWRAP_WETH, encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ROUTER_MSG_SENDER, p.amountOut]));
    if (wrapFirst) cmds.add(UR_COMMAND.UNWRAP_WETH, encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ROUTER_MSG_SENDER, 0n]));
    return;
  }
  const seg = rest[0] as V4Segment;
  const a = new Actions();
  swapExactOut(a, seg, p.amountOut, p.amountIn);
  if (wrapFirst) {
    cmds.add(UR_COMMAND.WRAP_ETH, encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ROUTER_ADDRESS_THIS, p.amountIn]));
    a.add(V4_ACTION.SETTLE, settle(seg.currencyIn, OPEN_DELTA, false));
  } else {
    a.add(V4_ACTION.SETTLE_ALL, currencyAmount(seg.currencyIn, p.amountIn));
  }
  a.add(V4_ACTION.TAKE_ALL, currencyAmount(seg.currencyOut, p.amountOut));
  cmds.add(UR_COMMAND.V4_SWAP, a.encode());
  if (wrapFirst) {
    // WETH left over from the maximum is unwrapped and sent back as ETH
    cmds.add(UR_COMMAND.UNWRAP_WETH, encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ROUTER_MSG_SENDER, 0n]));
  } else if (nativeIn) {
    cmds.add(UR_COMMAND.SWEEP, sweep(NATIVE_CURRENCY, 0n));
  }
}

