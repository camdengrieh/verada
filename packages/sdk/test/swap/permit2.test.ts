import { describe, expect, it } from "vitest";
import { MAX_UINT256, USDC, USDT, WETH, buildPermitSingle, permitSingleTypedData, planApprovals, readAllowances } from "../../src/index.js";

const now = 1_800_000_000;
const none = { erc20ToPermit2: 0n, amount: 0n, expiration: 0, nonce: 0 };

describe("planApprovals", () => {
  it("needs nothing for native ETH", () => {
    expect(planApprovals({ token: WETH.address, native: true, amount: 5n, allowance: none, now })).toEqual({ needsApprove: false, resetFirst: false, approveAmount: 0n, needsPermit: false });
  });
  it("asks for the approval and a permit on first use", () => {
    const p = planApprovals({ token: USDC.address, native: false, amount: 1000n, allowance: none, now });
    expect(p).toEqual({ needsApprove: true, resetFirst: false, approveAmount: MAX_UINT256, needsPermit: true });
  });
  it("reuses a standing Permit2 allowance", () => {
    const p = planApprovals({ token: USDC.address, native: false, amount: 1000n, allowance: { erc20ToPermit2: MAX_UINT256, amount: 5000n, expiration: now + 3600, nonce: 4 }, now });
    expect(p.needsApprove).toBe(false);
    expect(p.needsPermit).toBe(false);
  });
  it("re-permits when the allowance is too small or about to expire", () => {
    const base = { erc20ToPermit2: MAX_UINT256, nonce: 1 };
    expect(planApprovals({ token: USDC.address, native: false, amount: 1000n, allowance: { ...base, amount: 999n, expiration: now + 3600 }, now }).needsPermit).toBe(true);
    expect(planApprovals({ token: USDC.address, native: false, amount: 1000n, allowance: { ...base, amount: 5000n, expiration: now + 30 }, now }).needsPermit).toBe(true);
    expect(planApprovals({ token: USDC.address, native: false, amount: 1000n, allowance: { ...base, amount: 5000n, expiration: 0 }, now }).needsPermit).toBe(true);
  });
  it("resets USDT allowances before raising them", () => {
    const p = planApprovals({ token: USDT.address, native: false, amount: 1000n, allowance: { erc20ToPermit2: 10n, amount: 0n, expiration: 0, nonce: 0 }, now });
    expect(p.resetFirst).toBe(true);
    expect(planApprovals({ token: USDC.address, native: false, amount: 1000n, allowance: { erc20ToPermit2: 10n, amount: 0n, expiration: 0, nonce: 0 }, now }).resetFirst).toBe(false);
  });
});

describe("permit typed data", () => {
  it("builds a short-lived, exact-amount permit for the router", () => {
    const permit = buildPermitSingle({ token: USDC.address, amount: 123n, spender: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af", nonce: 7, now });
    expect(permit.details.amount).toBe(123n);
    expect(permit.details.nonce).toBe(7);
    expect(permit.details.expiration).toBe(now + 1800);
    expect(permit.sigDeadline).toBe(BigInt(now + 1800));
    const td = permitSingleTypedData(permit, "0x000000000022D473030F116dDEE9F6B43aC78BA3", 1);
    expect(td.domain).toEqual({ name: "Permit2", chainId: 1, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" });
    expect(td.primaryType).toBe("PermitSingle");
    expect(td.types.PermitDetails.map((f) => f.name)).toEqual(["token", "amount", "expiration", "nonce"]);
  });
  it("refuses amounts over uint160", () => {
    expect(() => buildPermitSingle({ token: USDC.address, amount: 1n << 160n, spender: USDC.address, nonce: 0, now })).toThrow(RangeError);
  });
  it("reads both allowances", async () => {
    const client = {
      readContract: async (a: { functionName: string }) => (a.functionName === "allowance" && "args" in a && (a as { args: unknown[] }).args.length === 2 ? 42n : ([9n, 1_900_000_000, 5] as const)),
    };
    const r = await readAllowances(client as never, { owner: USDC.address, token: USDC.address, permit2: WETH.address, spender: WETH.address });
    expect(r).toEqual({ erc20ToPermit2: 42n, amount: 9n, expiration: 1_900_000_000, nonce: 5 });
  });
});
