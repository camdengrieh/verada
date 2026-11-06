/**
 * Permit2 for the Universal Router: reuse an existing allowance, or sign a `PermitSingle` that
 * the router consumes in the same transaction as the swap (no extra on-chain approval).
 *
 * Two allowances are involved: the token's ERC-20 allowance to Permit2 (one `approve` transaction,
 * kept at the maximum so it is paid once per token) and Permit2's allowance to the router, which
 * the signed permit grants for exactly this swap's amount and a short time.
 */
import { getAddress, type Address, type Hex } from "viem";
import { erc20Abi, permit2Abi } from "./abis.js";
import { MAX_UINT160, MAX_UINT256 } from "./constants.js";
import type { ReadClient } from "./pool.js";

export interface PermitDetails {
  token: Address;
  amount: bigint;
  expiration: number;
  nonce: number;
}

export interface PermitSingle {
  details: PermitDetails;
  spender: Address;
  sigDeadline: bigint;
}

export interface Permit2Allowance {
  /** `ERC20.allowance(owner, permit2)`. */
  erc20ToPermit2: bigint;
  /** `Permit2.allowance(owner, token, spender)`. */
  amount: bigint;
  expiration: number;
  nonce: number;
}

export async function readAllowances(client: ReadClient, p: { owner: Address; token: Address; permit2: Address; spender: Address }): Promise<Permit2Allowance> {
  const [erc20ToPermit2, [amount, expiration, nonce]] = await Promise.all([
    client.readContract({ address: p.token, abi: erc20Abi, functionName: "allowance", args: [p.owner, p.permit2] }),
    client.readContract({ address: p.permit2, abi: permit2Abi, functionName: "allowance", args: [p.owner, p.token, p.spender] }),
  ]);
  return { erc20ToPermit2, amount, expiration: Number(expiration), nonce: Number(nonce) };
}

/** Tokens whose `approve` reverts when changing a non-zero allowance to another non-zero value. */
const ZERO_RESET_TOKENS = new Set(["0xdac17f958d2ee523a2206206994597c13d831ec7"]); // USDT

export interface ApprovalPlan {
  /** An ERC-20 `approve(permit2, ...)` transaction is needed first. */
  needsApprove: boolean;
  /** Approve zero first (USDT-style tokens with a stale non-zero allowance). */
  resetFirst: boolean;
  approveAmount: bigint;
  /** Permit2 does not yet let the router spend `amount`: a signed permit must accompany the swap. */
  needsPermit: boolean;
}

export const PERMIT_VALID_SECONDS = 30 * 60;

/**
 * What must happen before a swap that spends `amount` of `token`. Native ETH needs nothing.
 * `now` is unix seconds. An existing Permit2 allowance is reused while it covers `amount` and has
 * more than a minute left.
 */
export function planApprovals(p: { token: Address; native: boolean; amount: bigint; allowance: Permit2Allowance; now: number }): ApprovalPlan {
  if (p.native) return { needsApprove: false, resetFirst: false, approveAmount: 0n, needsPermit: false };
  const needsApprove = p.allowance.erc20ToPermit2 < p.amount;
  const resetFirst = needsApprove && p.allowance.erc20ToPermit2 > 0n && ZERO_RESET_TOKENS.has(p.token.toLowerCase());
  const permitOk = p.allowance.amount >= p.amount && (p.allowance.expiration === 0 ? false : p.allowance.expiration > p.now + 60);
  return { needsApprove, resetFirst, approveAmount: MAX_UINT256, needsPermit: !permitOk };
}

/** The `PermitSingle` for this swap: exactly `amount`, valid for {@link PERMIT_VALID_SECONDS}. */
export function buildPermitSingle(p: { token: Address; amount: bigint; spender: Address; nonce: number; now: number; validSeconds?: number }): PermitSingle {
  if (p.amount > MAX_UINT160) throw new RangeError("amount exceeds uint160");
  const valid = p.validSeconds ?? PERMIT_VALID_SECONDS;
  return {
    details: { token: getAddress(p.token), amount: p.amount, expiration: p.now + valid, nonce: p.nonce },
    spender: getAddress(p.spender),
    sigDeadline: BigInt(p.now + valid),
  };
}

/** EIP-712 typed data of a `PermitSingle` (what `signTypedData` takes). */
export function permitSingleTypedData(permit: PermitSingle, permit2: Address, chainId: number) {
  return {
    domain: { name: "Permit2", chainId, verifyingContract: permit2 },
    types: {
      PermitSingle: [
        { name: "details", type: "PermitDetails" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
      ],
      PermitDetails: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
      ],
    },
    primaryType: "PermitSingle",
    message: permit,
  } as const;
}

export interface SignedPermit {
  permit: PermitSingle;
  signature: Hex;
}
