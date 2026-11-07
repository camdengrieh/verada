import { encodeAbiParameters, toFunctionSelector, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { KNOWN_ERROR_SELECTORS, REASON_LABEL, REASON_MESSAGE, SwapError, mapSwapError, revertSelectors, type SwapReason } from "../../src/index.js";

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
  it("recognises a token balance shortfall by selector and by message", () => {
    expect(mapSwapError({ message: "reverted", data: `0xe450d38c${"00".repeat(96)}` }).reason).toBe("insufficient-balance");
    expect(mapSwapError(new Error("ERC20: transfer amount exceeds balance")).reason).toBe("insufficient-balance");
    expect(toFunctionSelector("function ERC20InsufficientBalance(address,uint256,uint256)")).toBe("0xe450d38c");
  });

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

describe("wrapped reverts", () => {
  const wrap = (sel: string, types: readonly { type: string }[], values: readonly unknown[]): Hex => `${sel}${encodeAbiParameters(types as never, values as never).slice(2)}` as Hex;
  const poolId = `0x${"ab".repeat(32)}` as Hex;
  const notEnough: Hex = `0x7a5ed734${"ab".repeat(32)}`;

  it("unwraps the quoter's UnexpectedRevertBytes", () => {
    const data = wrap("0x6190b2b0", [{ type: "bytes" }], [notEnough]);
    expect(revertSelectors(data)).toEqual(["0x6190b2b0", "0x7a5ed734"]);
    const err = Object.assign(new Error("reverted"), { cause: { data } });
    expect(mapSwapError(err).reason).toBe("insufficient-liquidity");
    void poolId;
  });

  it("unwraps the router's ExecutionFailed and the pool manager's WrappedError down to the hook's error", () => {
    const hookError: Hex = "0x1c26714c"; // InsufficientGas()
    const wrapped = wrap("0x90bfb865", [{ type: "address" }, { type: "bytes4" }, { type: "bytes" }, { type: "bytes" }], ["0x00000000000000000000000000000000000000aa", "0x575e24b4", hookError, "0x"]);
    const exec = wrap("0x2c4029e9", [{ type: "uint256" }, { type: "bytes" }], [0n, wrapped]);
    expect(revertSelectors(exec)).toEqual(["0x2c4029e9", "0x90bfb865", "0x1c26714c"]);
    const e = mapSwapError({ message: "x", data: exec });
    expect(e.reason).toBe("hook-reverted");
    expect(e.detail).toBe("0x1c26714c");
  });

  it("reports Ondo compliance errors hidden inside a swap revert", () => {
    const exec = wrap("0x2c4029e9", [{ type: "uint256" }, { type: "bytes" }], [0n, "0x8ed6a70e"]);
    expect(mapSwapError({ message: "x", cause: { data: exec } }).reason).toBe("blocked");
  });

  it("ignores data that is not a revert and survives truncated data", () => {
    expect(revertSelectors("nonsense")).toEqual([]);
    expect(revertSelectors("0x6190b2b0deadbeef")).toEqual(["0x6190b2b0"]);
  });
});
