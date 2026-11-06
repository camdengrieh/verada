"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mapSwapError, type RoutingConfig, type SwapAsset, type SwapError, type TradeQuote, type TradeSide, type VaradaMarketToken } from "@varada/sdk";
import { requestTradeQuote } from "@/lib/swap/trade";
import { useSwapClients } from "./use-swap-clients";

export interface UseSwapQuoteParams {
  /** The token to trade; null while it is still being resolved. */
  token: VaradaMarketToken | null;
  side: TradeSide;
  /** The asset paid with (buy) or received (sell). */
  asset: SwapAsset;
  /** The pay amount as typed. */
  amountText: string;
  /** Slippage tolerance in percent. */
  slippagePct: number;
  /** Routing options (extra hubs such as the registry's Ondo assets). Keep the object stable between renders. */
  routing?: RoutingConfig;
  /** Wait this long after the last keystroke before quoting. Default 350 ms. */
  debounceMs?: number;
  /** Re-quote this often while a quote is showing (prices, the fading sniper fee). Default 15 s; 0 disables. */
  refreshMs?: number;
}

export type SwapQuoteStatus = "idle" | "loading" | "ready" | "error";

export interface SwapQuoteState {
  status: SwapQuoteStatus;
  /** The latest quote. Kept (with `stale`) while a new one loads so the panel does not flash. */
  quote: TradeQuote | null;
  error: SwapError | null;
  /** The shown quote is for earlier inputs. */
  stale: boolean;
  updatedAt: number | null;
  /** Quote again now. */
  refresh: () => void;
}

/**
 * Debounced, cancelling quote for the trade panel. Every input change starts a new request and the
 * answers of older requests are dropped, so a slow reply never overwrites a newer one. Public
 * reads (pools, fees, the quoter) use the public client; the Ondo compliance check of the
 * connected address uses the account client, so the address never leaves the private RPC.
 */
export function useSwapQuote(params: UseSwapQuoteParams): SwapQuoteState {
  const { token, side, asset, amountText, slippagePct, routing, debounceMs = 350, refreshMs = 15_000 } = params;
  const clients = useSwapClients();
  const [state, setState] = useState<Omit<SwapQuoteState, "refresh">>({ status: "idle", quote: null, error: null, stale: false, updatedAt: null });
  const generation = useRef(0);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const clientsRef = useRef(clients);
  clientsRef.current = clients;

  const account = clients.account;
  useEffect(() => {
    const id = ++generation.current;
    if (!token) {
      setState({ status: "idle", quote: null, error: null, stale: false, updatedAt: null });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;

    const run = async (background: boolean) => {
      const myId = background ? generation.current : id;
      if (!background) setState((s) => ({ ...s, status: "loading", stale: s.quote !== null, error: null }));
      try {
        const q = await requestTradeQuote(clientsRef.current, { token, side, asset, amountText, slippagePct, routing });
        if (myId !== generation.current) return;
        if (q === null) setState({ status: "idle", quote: null, error: null, stale: false, updatedAt: null });
        else setState({ status: "ready", quote: q, error: null, stale: false, updatedAt: q.quotedAt });
      } catch (e) {
        if (myId !== generation.current) return;
        // a failed background refresh keeps the last good quote on screen but marks it stale
        const err = mapSwapError(e);
        setState((s) => (background && s.quote ? { ...s, stale: true, error: err } : { status: "error", quote: null, error: err, stale: false, updatedAt: null }));
      }
    };

    timer = setTimeout(() => {
      void run(false);
      if (refreshMs > 0) interval = setInterval(() => void run(true), refreshMs);
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      if (interval) clearInterval(interval);
      timer = undefined;
    };
    // `clients` is read through a ref: a new account client must not restart typing, only the account address does
  }, [token, side, asset, amountText, slippagePct, routing, debounceMs, refreshMs, tick, account]);

  return { ...state, refresh };
}
