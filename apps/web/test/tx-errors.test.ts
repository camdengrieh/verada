import { describe, expect, it } from "vitest";
import { friendlyTxError, isUserRejection, isWrongChain, revertName } from "@/lib/tx-errors";
import { txUrl } from "@/lib/explorer";

describe("friendlyTxError", () => {
  it("recognises a wallet rejection anywhere in the cause chain", () => {
    const e = Object.assign(new Error("TransactionExecutionError"), { cause: { cause: { code: 4001, message: "User rejected the request." } } });
    expect(isUserRejection(e)).toBe(true);
    expect(friendlyTxError(e)).toMatch(/declined the request in your wallet/);
    expect(isUserRejection(new Error("User denied transaction signature"))).toBe(true);
    expect(isUserRejection(new Error("rpc down"))).toBe(false);
  });

  it("recognises a wrong network", () => {
    const e = Object.assign(new Error("x"), { name: "ChainMismatchError" });
    expect(isWrongChain(e)).toBe(true);
    expect(friendlyTxError(e)).toMatch(/different network/);
  });

  it("maps insufficient funds and contract reverts", () => {
    expect(friendlyTxError(Object.assign(new Error("x"), { name: "InsufficientFundsError" }))).toMatch(/enough ETH/);
    const viemStyle = { shortMessage: "reverted", cause: { data: { errorName: "AlreadyVoted" } } };
    expect(revertName(viemStyle)).toBe("AlreadyVoted");
    expect(friendlyTxError(viemStyle)).toMatch(/already voted/);
    expect(friendlyTxError(new Error('The contract function "castBallot" reverted with the following signature: ZeroWeight()'))).toMatch(/none of this token/);
  });

  it("leaves unknown errors alone", () => {
    expect(friendlyTxError(new Error("something odd"))).toBeNull();
    expect(friendlyTxError(undefined)).toBeNull();
  });
});

describe("txUrl", () => {
  it("links mainnet transactions only", () => {
    const h = `0x${"ab".repeat(32)}`;
    expect(txUrl(1, h)).toBe(`https://etherscan.io/tx/${h}`);
    expect(txUrl(31337, h)).toBeUndefined();
    expect(txUrl(1, "0x12")).toBeUndefined();
    expect(txUrl(1, undefined)).toBeUndefined();
  });
});
