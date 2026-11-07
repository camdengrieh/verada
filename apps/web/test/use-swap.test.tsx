import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ETH, ONDO_TOKENS, WETH, clearDiscoveryCache, poolIdOf, quoteTrade, varadaPoolKey, type TradeQuote } from "@varada/sdk";

const ACCOUNT = "0x00000000000000000000000000000000000000aa";
const TOKEN = "0x1111111111111111111111111111111111111111";
const HOOK = "0x2222222222222222222222222222222222222222";
const SWAP_HASH = `0x${"5a".repeat(32)}`;

const wagmi = vi.hoisted(() => ({
  send: vi.fn(),
  sign: vi.fn(),
  estimate: vi.fn(),
  wait: vi.fn(),
  getTx: vi.fn(),
  call: vi.fn(),
  account: { address: "0x00000000000000000000000000000000000000aa", chainId: 1 } as { address?: string; chainId?: number },
}));
vi.mock("wagmi", () => ({
  useAccount: () => wagmi.account,
  useConfig: () => ({}),
  usePublicClient: () => ({ waitForTransactionReceipt: wagmi.wait, getTransaction: wagmi.getTx, call: wagmi.call }),
  useSendTransaction: () => ({ sendTransactionAsync: wagmi.send }),
  useSignTypedData: () => ({ signTypedDataAsync: wagmi.sign }),
}));
vi.mock("wagmi/actions", () => ({ estimateGas: wagmi.estimate }));

const toasts = vi.hoisted(() => ({ pending: vi.fn(() => "toast-1"), success: vi.fn(), error: vi.fn() }));
vi.mock("@varada/ui/components/varada/tx-toast", () => ({ txToast: toasts }));

const accountClient = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/hooks/use-swap-clients", () => ({ useSwapClients: () => ({ chain: {} as never, accountClient: accountClient.value, account: wagmi.account.address }) }));

import { MAX_QUOTE_AGE_MS, useSwap } from "@/hooks/use-swap";

// ---- a tiny world to build real quotes against (same shape as the SDK's engine tests)
function fakeChain(allowance: { erc20: bigint; permit: bigint; expiration: number }) {
  const tokenKey = varadaPoolKey(TOKEN, WETH.address, HOOK);
  const tokenId = poolIdOf(tokenKey);
  return {
    async readContract(a: { functionName: string; address: string; args?: unknown[] }) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args = (a.args ?? []) as any[];
      switch (a.functionName) {
        case "getSlot0": return args[0] === tokenId ? [2n ** 96n, 0, 0, 0] : [0n, 0, 0, 0];
        case "getLiquidity": return args[0] === tokenId ? 10n ** 18n : 0n;
        case "quoteExactInputSingle": return [(args[0].exactAmount * 1000n), 100_000n];
        case "currentFeeBps": return 300;
        case "feeConfig": return { baseFeeBps: 100, surchargeStartBps: 0, decaySeconds: 0, launchTimestamp: 1 };
        case "vault": throw new Error("revert");
        case "allowance": return args.length === 2 ? allowance.erc20 : [allowance.permit, allowance.expiration, 3];
        default: throw new Error("unexpected " + a.functionName);
      }
    },
  };
}

const token = { address: TOKEN as `0x${string}`, symbol: "TKN", hook: HOOK as `0x${string}`, quote: WETH, decimals: 18 };

async function makeQuote(asset = WETH): Promise<TradeQuote> {
  clearDiscoveryCache();
  return quoteTrade(fakeChain({ erc20: 0n, permit: 0n, expiration: 0 }) as never, { token, side: "buy", asset, amount: 10n ** 18n, slippageBps: 100 });
}

beforeEach(() => {
  vi.clearAllMocks();
  wagmi.account = { address: ACCOUNT, chainId: 1 };
  wagmi.send.mockImplementation(async () => SWAP_HASH);
  wagmi.sign.mockResolvedValue(`0x${"11".repeat(65)}`);
  wagmi.estimate.mockResolvedValue(1_000_000n);
  wagmi.wait.mockResolvedValue({ status: "success", blockNumber: 1n });
  wagmi.getTx.mockResolvedValue({ from: ACCOUNT, to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af", input: "0x3593564c", value: 0n, gas: 1_000_000n });
  wagmi.call.mockResolvedValue({ data: "0x" });
  toasts.pending.mockReturnValue("toast-1");
  accountClient.value = fakeChain({ erc20: 0n, permit: 0n, expiration: 0 });
});

describe("useSwap", () => {
  it("approves, signs the permit, estimates gas, sends the swap and reports success", async () => {
    const quote = await makeQuote();
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useSwap());
    let receipt: unknown;
    await act(async () => {
      receipt = await result.current.execute(quote, { causeName: "Wildlife rescue", onSuccess });
    });
    expect(receipt).toMatchObject({ status: "success" });
    expect(result.current.phase).toBe("success");
    expect(result.current.hash).toBe(SWAP_HASH);
    expect(result.current.steps.map((s) => [s.id, s.status])).toEqual([["approve", "done"], ["permit", "done"], ["swap", "done"]]);

    // 1: approve(permit2, max) to the pay token; 2: the swap with gas = estimate * 1.25
    expect(wagmi.send).toHaveBeenCalledTimes(2);
    expect(wagmi.send.mock.calls[0]![0].to).toBe(WETH.address);
    expect(wagmi.send.mock.calls[1]![0]).toMatchObject({ value: 0n, gas: 1_250_000n });
    expect(wagmi.send.mock.calls[1]![0].data.startsWith("0x3593564c")).toBe(true);
    // the permit is signed over Permit2 typed data
    expect(wagmi.sign.mock.calls[0]![0]).toMatchObject({ primaryType: "PermitSingle", domain: { name: "Permit2", chainId: 1 } });
    // toasts: pending then success with the donation
    expect(toasts.pending).toHaveBeenCalledWith(expect.objectContaining({ kind: "swap" }));
    expect(toasts.success).toHaveBeenCalledWith("toast-1", expect.objectContaining({ kind: "swap", explorerHref: `https://etherscan.io/tx/${SWAP_HASH}`, donation: expect.objectContaining({ cause: "Wildlife rescue" }) }));
    expect(onSuccess).toHaveBeenCalled();
  });

  it("skips the approval and permit when allowances already cover the swap", async () => {
    const quote = await makeQuote();
    accountClient.value = fakeChain({ erc20: 2n ** 255n, permit: 10n ** 20n, expiration: Math.floor(Date.now() / 1000) + 3600 });
    const { result } = renderHook(() => useSwap());
    await act(async () => void (await result.current.execute(quote)));
    expect(result.current.steps.map((s) => s.id)).toEqual(["swap"]);
    expect(wagmi.send).toHaveBeenCalledTimes(1);
    expect(wagmi.sign).not.toHaveBeenCalled();
  });

  it("pays native ETH as value with no approvals", async () => {
    clearDiscoveryCache();
    const quote = await quoteTrade(fakeChain({ erc20: 0n, permit: 0n, expiration: 0 }) as never, { token, side: "buy", asset: ETH, amount: 10n ** 18n, slippageBps: 100 });
    const { result } = renderHook(() => useSwap());
    await act(async () => void (await result.current.execute(quote)));
    expect(wagmi.send).toHaveBeenCalledTimes(1);
    expect(wagmi.send.mock.calls[0]![0].value).toBe(10n ** 18n);
    expect(wagmi.sign).not.toHaveBeenCalled();
  });

  it("maps a wallet rejection to user-rejected without a toast", async () => {
    const quote = await makeQuote();
    wagmi.send.mockRejectedValueOnce(Object.assign(new Error("User rejected the request."), { code: 4001 }));
    const { result } = renderHook(() => useSwap());
    await act(async () => void (await result.current.execute(quote)));
    expect(result.current.phase).toBe("error");
    expect(result.current.error?.reason).toBe("user-rejected");
    expect(result.current.steps.find((s) => s.id === "approve")?.status).toBe("error");
    expect(toasts.error).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("turns a failing gas estimate into a typed error before the wallet is asked to send the swap", async () => {
    const quote = await makeQuote();
    accountClient.value = fakeChain({ erc20: 2n ** 255n, permit: 10n ** 20n, expiration: Math.floor(Date.now() / 1000) + 3600 });
    wagmi.estimate.mockRejectedValueOnce(new Error("execution reverted: ... 0x8b063d73 ..."));
    const { result } = renderHook(() => useSwap());
    await act(async () => void (await result.current.execute(quote)));
    expect(result.current.error?.reason).toBe("slippage");
    expect(wagmi.send).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledWith(undefined, expect.objectContaining({ kind: "swap" }));
  });

  it("marks a reverted swap as failed and updates the pending toast", async () => {
    const quote = await makeQuote();
    accountClient.value = fakeChain({ erc20: 2n ** 255n, permit: 10n ** 20n, expiration: Math.floor(Date.now() / 1000) + 3600 });
    wagmi.wait.mockResolvedValueOnce({ status: "reverted", blockNumber: 7n });
    wagmi.call.mockRejectedValueOnce(new Error("execution reverted"));
    const { result } = renderHook(() => useSwap());
    await act(async () => void (await result.current.execute(quote)));
    expect(result.current.phase).toBe("error");
    expect(result.current.error?.reason).toBe("unknown");
    expect(result.current.error?.detail).toBe(SWAP_HASH);
    expect(toasts.error).toHaveBeenCalledWith("toast-1", expect.anything());
  });

  it("replays a reverted swap at its block and reports the decoded reason (slippage)", async () => {
    const quote = await makeQuote();
    accountClient.value = fakeChain({ erc20: 2n ** 255n, permit: 10n ** 20n, expiration: Math.floor(Date.now() / 1000) + 3600 });
    wagmi.wait.mockResolvedValueOnce({ status: "reverted", blockNumber: 7n });
    wagmi.call.mockRejectedValueOnce(Object.assign(new Error("execution reverted"), { data: `0x8b063d73${"00".repeat(64)}` }));
    const { result } = renderHook(() => useSwap());
    await act(async () => void (await result.current.execute(quote)));
    expect(wagmi.call).toHaveBeenCalledWith(expect.objectContaining({ account: ACCOUNT, blockNumber: 7n, data: "0x3593564c" }));
    expect(result.current.error?.reason).toBe("slippage");
    expect(result.current.error?.message).toBe("Price moved beyond your slippage limit");
    expect(toasts.error).toHaveBeenCalledWith("toast-1", expect.objectContaining({ description: "Price moved beyond your slippage limit" }));
  });

  it("reports an expired on-chain deadline from a reverted swap", async () => {
    const quote = await makeQuote();
    accountClient.value = fakeChain({ erc20: 2n ** 255n, permit: 10n ** 20n, expiration: Math.floor(Date.now() / 1000) + 3600 });
    wagmi.wait.mockResolvedValueOnce({ status: "reverted", blockNumber: 7n });
    wagmi.call.mockRejectedValueOnce(Object.assign(new Error("execution reverted"), { data: "0x5bf6f916" }));
    const { result } = renderHook(() => useSwap());
    await act(async () => void (await result.current.execute(quote)));
    expect(result.current.error?.reason).toBe("deadline-expired");
  });

  it("names a reverted approval by its decoded reason too", async () => {
    const quote = await makeQuote();
    wagmi.wait.mockResolvedValueOnce({ status: "reverted", blockNumber: 7n });
    wagmi.call.mockRejectedValueOnce(new Error("execution reverted"));
    const { result } = renderHook(() => useSwap());
    await act(async () => void (await result.current.execute(quote)));
    expect(result.current.error?.message).toBe("The approval transaction failed");
    expect(result.current.steps.find((s) => s.id === "approve")?.status).toBe("error");
    expect(wagmi.sign).not.toHaveBeenCalled();
  });

  it("a wallet rejection while signing the Permit2 permit fails only that step and sends nothing more", async () => {
    const quote = await makeQuote();
    wagmi.sign.mockRejectedValueOnce(Object.assign(new Error("User rejected the request."), { code: 4001 }));
    const { result } = renderHook(() => useSwap());
    await act(async () => void (await result.current.execute(quote)));
    expect(result.current.error?.reason).toBe("user-rejected");
    expect(result.current.steps.map((s) => [s.id, s.status])).toEqual([["approve", "done"], ["permit", "error"], ["swap", "pending"]]);
    expect(wagmi.send).toHaveBeenCalledTimes(1);
    expect(wagmi.estimate).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
    // a retry starts clean
    await act(async () => void (await result.current.execute(quote)));
    expect(result.current.phase).toBe("success");
  });

  it("maps a token-balance revert at simulation to insufficient-balance before the wallet opens", async () => {
    const quote = await makeQuote();
    accountClient.value = fakeChain({ erc20: 2n ** 255n, permit: 10n ** 20n, expiration: Math.floor(Date.now() / 1000) + 3600 });
    wagmi.estimate.mockRejectedValueOnce(Object.assign(new Error("execution reverted"), { data: `0xe450d38c${"00".repeat(96)}` }));
    const { result } = renderHook(() => useSwap());
    await act(async () => void (await result.current.execute(quote)));
    expect(result.current.error?.reason).toBe("insufficient-balance");
    expect(wagmi.send).not.toHaveBeenCalled();
  });

  it("refuses old quotes, blocked quotes and a missing wallet", async () => {
    const quote = await makeQuote();
    const { result } = renderHook(() => useSwap());
    await act(async () => void (await result.current.execute({ ...quote, quotedAt: Date.now() - MAX_QUOTE_AGE_MS - 1 })));
    expect(result.current.error?.reason).toBe("deadline-expired");

    await act(async () => void (await result.current.execute({ ...quote, blockers: ["paused"], compliance: { blockers: [{ reason: "paused", message: "AMZNon is paused by Ondo" }], warnings: [], checked: [ONDO_TOKENS.AMZNon.address] } })));
    expect(result.current.error?.reason).toBe("paused");
    expect(result.current.error?.message).toBe("AMZNon is paused by Ondo");

    wagmi.account = { address: undefined, chainId: 1 };
    const r2 = renderHook(() => useSwap());
    await act(async () => void (await r2.result.current.execute(quote)));
    expect(r2.result.current.phase).toBe("error");
    expect(wagmi.send).not.toHaveBeenCalled();
  });

  it("resets USDT-style approvals before raising them", async () => {
    clearDiscoveryCache();
    // pay in USDT: pool exists only for the token, so build the quote directly
    const usdt = { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" as const, symbol: "USDT", decimals: 6 };
    const base = await makeQuote();
    const quote = { ...base, payAsset: usdt, amountIn: 1_000_000n, amountInMax: 1_000_000n } as TradeQuote;
    accountClient.value = fakeChain({ erc20: 5n, permit: 0n, expiration: 0 });
    const { result } = renderHook(() => useSwap());
    await act(async () => void (await result.current.execute(quote)));
    expect(result.current.steps.map((s) => s.id)).toEqual(["reset", "approve", "permit", "swap"]);
    expect(wagmi.send).toHaveBeenCalledTimes(3);
  });

  it("ignores a second execute while one is running", async () => {
    const quote = await makeQuote();
    let release!: (v: string) => void;
    wagmi.send.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const { result } = renderHook(() => useSwap());
    let first!: Promise<unknown>;
    act(() => {
      first = result.current.execute(quote);
    });
    let second: unknown = "pending";
    await act(async () => {
      second = await result.current.execute(quote);
    });
    expect(second).toBeNull();
    await act(async () => {
      release(SWAP_HASH);
      await first;
    });
  });
});
