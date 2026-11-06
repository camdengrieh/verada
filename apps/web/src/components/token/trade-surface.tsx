"use client";

/**
 * Where the swap ticket mounts. The swap engine (apps/web/src/components/swap, owned by another
 * change) exports `ConnectedTradePanel`, `usePoolMarket` and `useSwapQuote`; until it is merged this
 * page has nothing to trade with, and shows no ticket rather than an inert one. `TRADE_READY` gates
 * the hero's trade action and the phone's sticky bar, and `TradeAside` / `TradeSheet` are the two
 * places the engine's panel goes: the desktop aside and the phone's bottom sheet.
 */
import type { ReactNode } from "react";

export const TRADE_READY = false;

export function TradeAside({ token }: { token: string; symbol: string }): ReactNode {
  void token;
  return null;
}

export function TradeSheet({ open }: { token: string; symbol: string; open: boolean; onOpenChange: (open: boolean) => void }): ReactNode {
  void open;
  return null;
}
