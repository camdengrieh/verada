/**
 * From a {@link TradeQuote} to transactions: the approval steps (ERC-20 -> Permit2, signed permit)
 * and the Universal Router call, with slippage limits and a deadline.
 */
import { encodeFunctionData, type Address, type Hex } from "viem";
import { erc20Abi } from "./abis.js";
import { buildSwapCalldata, type BuiltTransaction } from "./calldata.js";
import { DEFAULT_ENVIRONMENT } from "./constants.js";
import type { TradeQuote } from "./engine.js";
import { SwapError } from "./errors.js";
import { buildPermitSingle, permitSingleTypedData, planApprovals, readAllowances, type ApprovalPlan, type Permit2Allowance, type PermitSingle, type SignedPermit } from "./permit2.js";
import type { ReadClient } from "./pool.js";
import { NATIVE_CURRENCY, type SwapEnvironment } from "./types.js";

/** Default time a swap transaction stays valid. */
export const DEFAULT_DEADLINE_SECONDS = 20 * 60;

/** What the user has to spend on this trade: exact-in the input amount, exact-out the maximum. */
export function spendAmount(q: Pick<TradeQuote, "mode" | "amountIn" | "amountInMax">): bigint {
  return q.mode === "exactIn" ? q.amountIn : q.amountInMax;
}

export interface ExecutionPlan {
  /** Pay asset is native ETH: nothing to approve, the amount travels as value. */
  native: boolean;
  allowance: Permit2Allowance | null;
  approval: ApprovalPlan;
  /** Reset the ERC-20 allowance to zero first (USDT-style tokens). */
  resetTx: { to: Address; data: Hex } | null;
  /** `approve(permit2, max)` on the pay token. */
  approveTx: { to: Address; data: Hex } | null;
  /** Unsigned permit to sign (EIP-712) when Permit2 does not already allow the router. */
  permit: PermitSingle | null;
  typedData: ReturnType<typeof permitSingleTypedData> | null;
}

/**
 * Reads the user's allowances (through the account client: address-keyed) and decides what is
 * needed before the swap. Existing allowances are reused.
 */
export async function planExecution(accountClient: ReadClient, quote: TradeQuote, p: { account: Address; chainId?: number; env?: SwapEnvironment; now?: number }): Promise<ExecutionPlan> {
  const env = p.env ?? DEFAULT_ENVIRONMENT;
  const now = p.now ?? Math.floor(Date.now() / 1000);
  const token = quote.payAsset.address;
  const native = token.toLowerCase() === NATIVE_CURRENCY;
  if (native) {
    return { native, allowance: null, approval: planApprovals({ token, native, amount: 0n, allowance: { erc20ToPermit2: 0n, amount: 0n, expiration: 0, nonce: 0 }, now }), resetTx: null, approveTx: null, permit: null, typedData: null };
  }
  const amount = spendAmount(quote);
  const allowance = await readAllowances(accountClient, { owner: p.account, token, permit2: env.permit2, spender: env.universalRouter });
  const approval = planApprovals({ token, native, amount, allowance, now });
  const permit = approval.needsPermit ? buildPermitSingle({ token, amount, spender: env.universalRouter, nonce: allowance.nonce, now }) : null;
  return {
    native,
    allowance,
    approval,
    resetTx: approval.resetFirst ? { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [env.permit2, 0n] }) } : null,
    approveTx: approval.needsApprove ? { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [env.permit2, approval.approveAmount] }) } : null,
    permit,
    typedData: permit ? permitSingleTypedData(permit, env.permit2, p.chainId ?? 1) : null,
  };
}

/** The Universal Router transaction for a quote. `signedPermit` is required when the plan asked for one. */
export function buildTradeTransaction(quote: TradeQuote, p: { deadline?: number; now?: number; signedPermit?: SignedPermit; env?: SwapEnvironment } = {}): BuiltTransaction {
  if (quote.blockers.length > 0) throw new SwapError(quote.blockers[0]!);
  const now = p.now ?? Math.floor(Date.now() / 1000);
  const deadline = p.deadline ?? now + DEFAULT_DEADLINE_SECONDS;
  return buildSwapCalldata({
    route: quote.best.route,
    mode: quote.mode,
    amountIn: spendAmount(quote),
    amountOut: quote.mode === "exactIn" ? quote.amountOutMin : quote.amountOut,
    deadline,
    permit: p.signedPermit,
    env: p.env,
  });
}

