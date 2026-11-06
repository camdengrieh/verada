import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwapError, WETH, ETH, type TradeQuote } from "@varada/sdk";

const clients = vi.hoisted(() => ({ value: { chain: {} as never, accountClient: undefined as never, account: undefined as string | undefined } }));
vi.mock("@/hooks/use-swap-clients", () => ({ useSwapClients: () => clients.value }));
const requestTradeQuote = vi.hoisted(() => vi.fn());
vi.mock("@/lib/swap/trade", () => ({ requestTradeQuote }));

import { useSwapQuote } from "@/hooks/use-swap-quote";

const token = { address: "0x1111111111111111111111111111111111111111", symbol: "T", hook: "0x2222222222222222222222222222222222222222", quote: WETH, decimals: 18 } as const;
const quoteOf = (out: bigint): TradeQuote => ({ amountOut: out, quotedAt: Date.now() }) as unknown as TradeQuote;
const base = { token, side: "buy" as const, asset: ETH, amountText: "1", slippagePct: 1 };

beforeEach(() => {
  vi.useFakeTimers();
  requestTradeQuote.mockReset();
  clients.value = { chain: {} as never, accountClient: undefined as never, account: undefined };
});
afterEach(() => vi.useRealTimers());

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useSwapQuote", () => {
  it("stays idle without an amount and quotes after the debounce", async () => {
    requestTradeQuote.mockResolvedValue(null);
    const { result, rerender } = renderHook((p) => useSwapQuote(p), { initialProps: { ...base, amountText: "" } });
    await flush(400);
    expect(result.current.status).toBe("idle");

    requestTradeQuote.mockResolvedValue(quoteOf(5n));
    rerender({ ...base, amountText: "1" });
    expect(requestTradeQuote).toHaveBeenCalledTimes(1); // only the empty-amount call so far
    await flush(349);
    expect(requestTradeQuote).toHaveBeenCalledTimes(1);
    await flush(2);
    expect(result.current.status).toBe("ready");
    expect(result.current.quote?.amountOut).toBe(5n);
    expect(requestTradeQuote).toHaveBeenCalledTimes(2);
  });

  it("debounces typing into one request", async () => {
    requestTradeQuote.mockResolvedValue(quoteOf(1n));
    const { rerender } = renderHook((p) => useSwapQuote(p), { initialProps: { ...base, amountText: "1" } });
    await flush(100);
    rerender({ ...base, amountText: "12" });
    await flush(100);
    rerender({ ...base, amountText: "123" });
    await flush(400);
    expect(requestTradeQuote).toHaveBeenCalledTimes(1);
    expect(requestTradeQuote.mock.calls[0]![1].amountText).toBe("123");
  });

  it("drops the answer of a stale request", async () => {
    let resolveFirst!: (q: TradeQuote) => void;
    requestTradeQuote.mockImplementationOnce(() => new Promise<TradeQuote>((r) => (resolveFirst = r)));
    const { result, rerender } = renderHook((p) => useSwapQuote(p), { initialProps: { ...base, amountText: "1" } });
    await flush(400); // first request is now in flight
    requestTradeQuote.mockResolvedValueOnce(quoteOf(200n));
    rerender({ ...base, amountText: "2" });
    await flush(400);
    expect(result.current.quote?.amountOut).toBe(200n);
    await act(async () => resolveFirst(quoteOf(100n))); // the slow first answer arrives last
    expect(result.current.quote?.amountOut).toBe(200n);
  });

  it("keeps the previous quote (marked stale) while a new one loads", async () => {
    requestTradeQuote.mockResolvedValueOnce(quoteOf(1n));
    const { result, rerender } = renderHook((p) => useSwapQuote(p), { initialProps: { ...base, amountText: "1" } });
    await flush(400);
    expect(result.current.stale).toBe(false);
    requestTradeQuote.mockImplementationOnce(() => new Promise(() => {}));
    rerender({ ...base, amountText: "2" });
    await flush(400);
    expect(result.current.status).toBe("loading");
    expect(result.current.stale).toBe(true);
    expect(result.current.quote?.amountOut).toBe(1n);
  });

  it("reports typed errors", async () => {
    requestTradeQuote.mockRejectedValue(new SwapError("no-route"));
    const { result } = renderHook((p) => useSwapQuote(p), { initialProps: base });
    await flush(400);
    expect(result.current.status).toBe("error");
    expect(result.current.error?.reason).toBe("no-route");
    expect(result.current.quote).toBeNull();
  });

  it("maps raw errors to reasons", async () => {
    requestTradeQuote.mockRejectedValue(new Error("HTTP request failed."));
    const { result } = renderHook((p) => useSwapQuote(p), { initialProps: base });
    await flush(400);
    expect(result.current.error?.reason).toBe("rpc-unavailable");
  });

  it("re-quotes on the refresh interval and keeps the last quote when a refresh fails", async () => {
    requestTradeQuote.mockResolvedValueOnce(quoteOf(1n)).mockResolvedValueOnce(quoteOf(2n)).mockRejectedValueOnce(new Error("HTTP request failed."));
    const { result } = renderHook((p) => useSwapQuote({ ...p, refreshMs: 1000 }), { initialProps: base });
    await flush(400);
    expect(result.current.quote?.amountOut).toBe(1n);
    await flush(1000);
    expect(result.current.quote?.amountOut).toBe(2n);
    expect(result.current.status).toBe("ready");
    await flush(1000);
    expect(result.current.quote?.amountOut).toBe(2n);
    expect(result.current.stale).toBe(true);
    expect(result.current.error?.reason).toBe("rpc-unavailable");
  });

  it("does nothing without a resolved token and re-quotes when the account changes", async () => {
    requestTradeQuote.mockResolvedValue(quoteOf(1n));
    const { result, rerender } = renderHook((p) => useSwapQuote(p), { initialProps: { ...base, token: null } });
    await flush(400);
    expect(requestTradeQuote).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
    rerender({ ...base, token: token as never });
    await flush(400);
    expect(requestTradeQuote).toHaveBeenCalledTimes(1);
    clients.value = { ...clients.value, account: "0x00000000000000000000000000000000000000aa" };
    rerender({ ...base, token: token as never });
    await flush(400);
    expect(requestTradeQuote).toHaveBeenCalledTimes(2);
  });

  it("refresh() quotes again immediately", async () => {
    requestTradeQuote.mockResolvedValue(quoteOf(1n));
    const { result } = renderHook((p) => useSwapQuote(p), { initialProps: base });
    await flush(400);
    act(() => result.current.refresh());
    await flush(400);
    expect(requestTradeQuote).toHaveBeenCalledTimes(2);
  });
});
