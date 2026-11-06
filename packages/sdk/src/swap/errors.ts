/**
 * Typed reasons a swap cannot be quoted or sent, and the mapping from raw errors (viem reverts,
 * wallet rejections) to them. The UI turns each reason into a button label or a note.
 */
import { BaseError, decodeAbiParameters, type Hex } from "viem";

export type SwapReason =
  /** No path of existing pools connects the two assets. */
  | "no-route"
  /** The pool or route cannot fill this size (not enough liquidity). */
  | "insufficient-liquidity"
  /** A pool of the route is not initialized. */
  | "pool-not-initialized"
  /** A hook reverted the swap (the message carries its selector). */
  | "hook-reverted"
  /** An Ondo token of the route is paused (or all tokens are). */
  | "paused"
  /** The user's address is on Ondo's blocklist. */
  | "blocked"
  /** The user's address is on a sanctions list. */
  | "sanctioned"
  /** The US market is closed: Ondo prices can be stale and the token may refuse to trade. */
  | "market-closed"
  | "zero-amount"
  /** The route cannot fill this size without moving the price by `maxImpactPct` or more. */
  | "price-impact"
  | "insufficient-balance"
  /** Output moved past the slippage limit between quote and execution. */
  | "slippage"
  | "deadline-expired"
  | "user-rejected"
  | "insufficient-gas-funds"
  | "exact-out-unsupported"
  | "unsupported-asset"
  | "rpc-unavailable"
  | "unknown";

export class SwapError extends Error {
  readonly reason: SwapReason;
  readonly detail?: string;
  constructor(reason: SwapReason, message?: string, options?: { detail?: string; cause?: unknown }) {
    super(message ?? REASON_MESSAGE[reason], options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SwapError";
    this.reason = reason;
    this.detail = options?.detail;
  }
}

export const REASON_MESSAGE: Record<SwapReason, string> = {
  "no-route": "No route found between these assets",
  "insufficient-liquidity": "Not enough liquidity for this size",
  "pool-not-initialized": "This pool is not live yet",
  "hook-reverted": "The pool's hook rejected this swap",
  paused: "Trading is paused for this asset",
  blocked: "This address is blocked from trading this asset",
  sanctioned: "This address cannot trade this asset",
  "market-closed": "The US market is closed",
  "zero-amount": "Enter an amount",
  "price-impact": "Price impact is too high for this size; try a smaller amount",
  "insufficient-balance": "Insufficient balance",
  slippage: "Price moved beyond your slippage limit",
  "deadline-expired": "The quote expired",
  "user-rejected": "Request rejected in the wallet",
  "insufficient-gas-funds": "Not enough ETH to pay for gas",
  "exact-out-unsupported": "Exact-output is not available for this route",
  "unsupported-asset": "This asset is not supported",
  "rpc-unavailable": "Could not reach the network",
  unknown: "Something went wrong",
};

/** Short button labels for the trade panel. */
export const REASON_LABEL: Record<SwapReason, string> = {
  "no-route": "No route",
  "insufficient-liquidity": "Not enough liquidity",
  "pool-not-initialized": "Pool not live",
  "hook-reverted": "Swap not allowed",
  paused: "Trading paused",
  blocked: "Address blocked",
  sanctioned: "Address restricted",
  "market-closed": "Market closed",
  "zero-amount": "Enter an amount",
  "price-impact": "Price impact too high",
  "insufficient-balance": "Insufficient balance",
  slippage: "Slippage too tight",
  "deadline-expired": "Quote expired",
  "user-rejected": "Rejected",
  "insufficient-gas-funds": "Not enough ETH for gas",
  "exact-out-unsupported": "Exact output unavailable",
  "unsupported-asset": "Unsupported asset",
  "rpc-unavailable": "Network unavailable",
  unknown: "Try again",
};

/** Selectors of the custom errors worth naming (checked against keccak in the unit tests). */
export const KNOWN_ERROR_SELECTORS: Record<string, SwapReason> = {
  "0x8ed6a70e": "blocked", // UserBlocked()
  "0x349e7009": "sanctioned", // UserSanctioned()
  "0x7a5ed734": "insufficient-liquidity", // NotEnoughLiquidity(bytes32) of the v4 quoter
  "0x486aa307": "pool-not-initialized", // PoolNotInitialized()
  "0x8b063d73": "slippage", // V4TooLittleReceived(uint256,uint256)
  "0x12bacdd3": "slippage", // V4TooMuchRequested(uint256,uint256)
  "0x39d35496": "slippage", // V3TooLittleReceived()
  "0x739dbe52": "slippage", // V3TooMuchRequested()
  "0x849eaf98": "slippage", // V2TooLittleReceived()
  "0x8ab0bc16": "slippage", // V2TooMuchRequested()
  "0xae52ad0c": "no-route", // V2InvalidPath()
  "0x5bf6f916": "deadline-expired", // TransactionDeadlinePassed()
  "0x1c26714c": "hook-reverted", // InsufficientGas() of VaradaLiveHook: send more gas
  "0x7d617bb3": "hook-reverted", // PartialFillNotSupported() of VaradaLiveHook
  "0x19f9fbb7": "hook-reverted", // SwapReentered() of VaradaLiveHook
  "0xa9e35b2f": "hook-reverted", // HookCallFailed()
};

const UNEXPECTED_REVERT_BYTES = "0x6190b2b0"; // V4Quoter: UnexpectedRevertBytes(bytes)
const EXECUTION_FAILED = "0x2c4029e9"; // UniversalRouter: ExecutionFailed(uint256,bytes)
const WRAPPED_ERROR = "0x90bfb865"; // v4-core CustomRevert: WrappedError(address,bytes4,bytes,bytes)

/**
 * Selectors found in revert data, outermost first, unwrapping the three wrappers around a pool's or hook's
 * own error: the quoter's `UnexpectedRevertBytes`, the router's `ExecutionFailed` and the pool manager's
 * `WrappedError` (whose selector argument is the hook function that failed, and whose reason is the hook's error).
 */
export function revertSelectors(data: string, depth = 0): string[] {
  const d = data.toLowerCase();
  if (!/^0x[0-9a-f]{8}/.test(d) || depth > 5) return [];
  const sel = d.slice(0, 10);
  const out = [sel];
  const body = `0x${d.slice(10)}` as Hex;
  try {
    if (sel === UNEXPECTED_REVERT_BYTES) {
      const [inner] = decodeAbiParameters([{ type: "bytes" }], body);
      out.push(...revertSelectors(inner, depth + 1));
    } else if (sel === EXECUTION_FAILED) {
      const [, inner] = decodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], body);
      out.push(...revertSelectors(inner, depth + 1));
    } else if (sel === WRAPPED_ERROR) {
      const [, , reason] = decodeAbiParameters([{ type: "address" }, { type: "bytes4" }, { type: "bytes" }, { type: "bytes" }], body);
      out.push(...revertSelectors(reason, depth + 1));
    }
  } catch {
    // truncated or foreign data: keep what was found
  }
  return out;
}

/** Hex revert data found anywhere in an error and its causes. */
function revertData(err: unknown, depth = 0): string[] {
  if (depth > 8 || typeof err !== "object" || err === null) return [];
  const e = err as Record<string, unknown>;
  const own = typeof e.data === "string" && e.data.startsWith("0x") ? [e.data] : typeof (e.data as { data?: unknown } | undefined)?.data === "string" ? [(e.data as { data: string }).data] : [];
  return [...own, ...revertData(e.cause, depth + 1)];
}

function collectText(err: unknown, depth = 0): string {
  if (depth > 6 || err === null || err === undefined) return "";
  if (typeof err === "string") return err;
  if (typeof err !== "object") return String(err);
  const e = err as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of ["name", "shortMessage", "message", "details", "reason", "signature"]) {
    if (typeof e[k] === "string") parts.push(e[k] as string);
  }
  if (e.data !== undefined) parts.push(typeof e.data === "string" ? e.data : JSON.stringify(e.data, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  if (e.cause) parts.push(collectText(e.cause, depth + 1));
  return parts.join(" | ");
}

/**
 * Maps any thrown value to a {@link SwapError}. Recognises wallet rejections (EIP-1193 code 4001
 * and viem's `UserRejectedRequestError`), gas-funds errors, deadline and slippage reverts of the
 * Universal Router / v4 router, the Ondo compliance errors, and revert data of the quoter.
 */
export function mapSwapError(err: unknown): SwapError {
  if (err instanceof SwapError) return err;
  const text = collectText(err);
  const lower = text.toLowerCase();
  const code = (err as { code?: unknown } | null)?.code;
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  if (code === 4001 || cause?.code === 4001 || lower.includes("user rejected") || lower.includes("user denied") || lower.includes("rejected the request")) {
    return new SwapError("user-rejected", undefined, { cause: err });
  }
  if (lower.includes("insufficient funds") || lower.includes("exceeds the balance of the account")) {
    return new SwapError("insufficient-gas-funds", undefined, { cause: err });
  }
  // decode wrapped reverts first: the innermost known error says why
  for (const data of revertData(err)) {
    const selectors = revertSelectors(data);
    for (const selector of selectors.slice().reverse()) {
      const reason = KNOWN_ERROR_SELECTORS[selector];
      if (reason) return new SwapError(reason, undefined, { detail: selector, cause: err });
    }
  }
  for (const [selector, reason] of Object.entries(KNOWN_ERROR_SELECTORS)) {
    if (lower.includes(selector)) return new SwapError(reason, undefined, { detail: selector, cause: err });
  }
  if (lower.includes("userblocked")) return new SwapError("blocked", undefined, { cause: err });
  if (lower.includes("usersanctioned")) return new SwapError("sanctioned", undefined, { cause: err });
  if (lower.includes("transactiondeadlinepassed") || lower.includes("deadline")) return new SwapError("deadline-expired", undefined, { cause: err });
  if (lower.includes("toolittlereceived") || lower.includes("toomuchrequested") || lower.includes("slippage")) {
    return new SwapError("slippage", undefined, { cause: err });
  }
  if (lower.includes("poolnotinitialized") || lower.includes("pool not initialized")) return new SwapError("pool-not-initialized", undefined, { cause: err });
  if (lower.includes("insufficient_liquidity") || lower.includes("insufficient_input_amount") || lower.includes("insufficient_output_amount") || lower.includes("uniswapv2library")) {
    return new SwapError("insufficient-liquidity", undefined, { cause: err });
  }
  if (lower.includes("notenoughliquidity") || lower.includes("not enough liquidity") || lower.includes("insufficient liquidity")) {
    return new SwapError("insufficient-liquidity", undefined, { cause: err });
  }
  if (lower.includes("enforcedpause") || lower.includes("paused")) return new SwapError("paused", undefined, { cause: err });
  if (lower.includes("wrappederror") || lower.includes("hookcallfailed") || lower.includes("hook call failed")) {
    return new SwapError("hook-reverted", undefined, { detail: firstSelector(text), cause: err });
  }
  if (lower.includes("http request failed") || lower.includes("fetch failed") || lower.includes("network") || lower.includes("timeout") || lower.includes("privaterpc")) {
    return new SwapError("rpc-unavailable", undefined, { cause: err });
  }
  const msg = err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : undefined;
  return new SwapError("unknown", msg, { cause: err });
}

function firstSelector(text: string): string | undefined {
  return /0x[0-9a-fA-F]{8}/.exec(text)?.[0];
}
