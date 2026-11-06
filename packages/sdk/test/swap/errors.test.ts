import { toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { KNOWN_ERROR_SELECTORS, REASON_LABEL, REASON_MESSAGE, SwapError, mapSwapError, type SwapReason } from "../../src/index.js";

describe("error selectors", () => {
  it("match their signatures", () => {
    const sigs: Record<string, string> = {
      "UserBlocked()": "blocked",
      "UserSanctioned()": "sanctioned",
      "NotEnoughLiquidity(bytes32)": "insufficient-liquidity",
      "PoolNotInitialized()": "pool-not-initialized",
      "V4TooLittleReceived(uint256,uint256)": "slippage",
      "V4TooMuchRequested(uint256,uint256)": "slippage",
      "V3TooLittleReceived()": "slippage",
      "TransactionDeadlinePassed()": "deadline-expired",
      "InsufficientGas()": "hook-reverted",
      "PartialFillNotSupported()": "hook-reverted",
      "SwapReentered()": "hook-reverted",
      "HookCallFailed()": "hook-reverted",
    };
    for (const [sig, reason] of Object.entries(sigs)) expect(KNOWN_ERROR_SELECTORS[toFunctionSelector(`function ${sig}`)]).toBe(reason);
  });
});

describe("mapSwapError", () => {
  it("recognises wallet rejections", () => {
    expect(mapSwapError({ code: 4001, message: "x" }).reason).toBe("user-rejected");
    expect(mapSwapError(new Error("User rejected the request.")).reason).toBe("user-rejected");
    expect(mapSwapError({ message: "wrapped", cause: { code: 4001 } }).reason).toBe("user-rejected");
  });
  it("recognises gas-funds errors", () => {
    expect(mapSwapError(new Error("insufficient funds for gas * price + value")).reason).toBe("insufficient-gas-funds");
  });
  it("maps router and quoter reverts by selector", () => {
    expect(mapSwapError(new Error('reverted with data: 0x5bf6f916')).reason).toBe("deadline-expired");
    expect(mapSwapError(new Error("ExecutionFailed 0x2c4029e9 ... 0x8b063d73 0000")).reason).toBe("slippage");
    expect(mapSwapError(new Error("revert 0x7a5ed734aaaa")).reason).toBe("insufficient-liquidity");
    expect(mapSwapError(new Error("revert 0x486aa307")).reason).toBe("pool-not-initialized");
  });
  it("recognises Ondo compliance errors by name and selector", () => {
    expect(mapSwapError(new Error("The contract function reverted with the following reason: UserBlocked()")).reason).toBe("blocked");
    expect(mapSwapError(new Error("0x349e7009")).reason).toBe("sanctioned");
  });
  it("names hook failures and keeps the selector", () => {
    const e = mapSwapError(new Error("WrappedError(0xhook, 0x575e24b4, 0x1c26714c, 0x)"));
    expect(e.reason).toBe("hook-reverted");
    expect(e.detail).toBe("0x1c26714c");
  });
  it("maps transport failures and passes unknown ones through", () => {
    expect(mapSwapError(new Error("HTTP request failed.")).reason).toBe("rpc-unavailable");
    const u = mapSwapError(new Error("something odd"));
    expect(u.reason).toBe("unknown");
    expect(u.message).toBe("something odd");
  });
  it("returns SwapErrors unchanged", () => {
    const e = new SwapError("no-route");
    expect(mapSwapError(e)).toBe(e);
  });
  it("has a message and a label for every reason", () => {
    for (const r of Object.keys(REASON_MESSAGE) as SwapReason[]) {
      expect(REASON_MESSAGE[r].length).toBeGreaterThan(3);
      expect(REASON_LABEL[r].length).toBeGreaterThan(3);
    }
  });
});
