"use client";

/**
 * Where the swap ticket mounts: the desktop aside and the phone's bottom sheet. Both render the swap
 * engine's `ConnectedTradePanel` (quotes, balances, approvals, the swap, the price impact ladder and
 * the liquidity panel; see docs/SWAP.md). Only one of them is mounted at a time, so the engine's
 * queries and state exist once.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address } from "viem";
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@varada/ui/components/ui/drawer";
import type { TradingMetric } from "@varada/ui/components/varada/trading-metrics-bar";
import type { CauseName } from "@varada/ui/components/varada/cause-icon";
import { ConnectedTradePanel } from "@/components/swap";
import { useAppConfig, useDeps } from "@/components/providers";
import { usePoolMarket } from "@/hooks/use-swap-market";
import { useSwapClients } from "@/hooks/use-swap-clients";
import { resolveMarketToken } from "@/lib/swap/tokens";

export interface TradeSurfaceProps {
  token: string;
  symbol: string;
  causeName?: string;
  causeIcon?: CauseName;
  /** Called after a swap is mined: refresh the trade feed, market and holders. */
  onSwapped?: () => void;
}

export function TradeAside({ token, symbol, causeName, causeIcon, onSwapped }: TradeSurfaceProps) {
  return (
    <section aria-label="Trade" className="rounded-[26px] border border-line bg-card p-4 @container">
      <ConnectedTradePanel token={{ address: token, symbol }} causeName={causeName} causeIcon={causeIcon} onSwapped={onSwapped} />
    </section>
  );
}

export function TradeSheet({ token, symbol, causeName, causeIcon, onSwapped, open, onOpenChange }: TradeSurfaceProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="h-[92dvh]" data-slot="trade-sheet">
        <DrawerHeader className="pb-2">
          <DrawerTitle className="text-2xl leading-tight">Trade ${symbol}</DrawerTitle>
          <DrawerDescription className="sr-only">Buy or sell {symbol}. Every trade pays a fee and 90% of it goes to the token&apos;s cause.</DrawerDescription>
        </DrawerHeader>
        <DrawerBody className="@container min-h-0 flex-1 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {open ? <ConnectedTradePanel token={{ address: token, symbol }} causeName={causeName} causeIcon={causeIcon} onSwapped={onSwapped} /> : null}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}

/** The pool's liquidity as a metric, from the engine's pool read (public chain data); empty until it is known. */
export function useLiquidityMetric(token: string, symbol: string): TradingMetric[] {
  const config = useAppConfig();
  const deps = useDeps();
  const clients = useSwapClients();
  // The same query key the ticket uses (token and symbol only), so the ticket's resolution is reused.
  const resolved = useQuery({
    queryKey: ["market-token", token, null, null],
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => resolveMarketToken({ chain: clients.chain, indexer: deps.indexer, cfg: config }, { address: token as Address, symbol }),
  });
  const { market } = usePoolMarket(resolved.data ?? null);
  return useMemo(() => {
    if (!market) return [];
    if (market.tvlUsd != null) return [{ key: "liquidity", label: "Liquidity", value: market.tvlUsd, format: { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }, hint: "Pool value, both sides" }];
    if (market.tvlQuote != null) return [{ key: "liquidity", label: `Liquidity (${market.quote.symbol})`, value: market.tvlQuote, format: { notation: "compact", maximumFractionDigits: 2 }, hint: "Pool value, both sides" }];
    return [];
  }, [market]);
}

