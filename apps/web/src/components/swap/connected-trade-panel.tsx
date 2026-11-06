"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAccount, useConnect } from "wagmi";
import { Button } from "@varada/ui/components/ui/button";
import { ChevronDown } from "@varada/ui/components/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@varada/ui/components/ui/dropdown-menu";
import type { CauseName } from "@varada/ui/components/varada/cause-icon";
import { LiquidityPanel } from "@varada/ui/components/varada/liquidity-panel";
import { PriceImpactLadder, DEFAULT_IMPACT_SIZES } from "@varada/ui/components/varada/price-impact-ladder";
import { TradePanel, type TradeBlocker, type TradeSide, type TradeToken } from "@varada/ui/components/varada/trade-panel";
import type { QuoteKind } from "@varada/ui/components/varada/stock-logo";
import { ETH, ONDO_TOKENS, REASON_LABEL, isOndoToken, ondoSymbolOf, type SwapAsset } from "@varada/sdk";
import { useAppConfig, useDeps } from "@/components/providers";
import { useBalances } from "@/hooks/use-swap-balances";
import { useSwapClients } from "@/hooks/use-swap-clients";
import { useRegistryAssets } from "@/hooks/use-swap-registry";
import { usePoolMarket, useUsdPrices } from "@/hooks/use-swap-market";
import { useSwapQuote } from "@/hooks/use-swap-quote";
import { useSwap } from "@/hooks/use-swap";
import { formatDisplay, formatPercent, formatRaw, formatUsd } from "@/lib/swap/amounts";
import { formatTimeUntil, usMarketSession } from "@/lib/swap/calendar";
import { loadQuoteRouteDepth } from "@/lib/swap/depth";
import { resolveMarketToken, tradeAssets, type TradeTokenInput } from "@/lib/swap/tokens";
import { payAmountRaw, quoteImpactLadder, requestTradeQuote } from "@/lib/swap/trade";

export interface ConnectedTradePanelProps {
  /** The token being traded. Only `address` and `symbol` are required; the hook and quote asset are read when absent. */
  token: TradeTokenInput;
  /** Cause named next to the fee split ("Wildlife rescue"). */
  causeName?: string;
  causeIcon?: CauseName;
  /** Hide the price impact ladder and the liquidity panel below the ticket. */
  hideDetails?: boolean;
  /** Called after a swap is mined (refresh the trade feed here). */
  onSwapped?: () => void;
  className?: string;
}

/** Keep this much ETH when "Max" is pressed on a native ETH balance, for gas. */
const GAS_RESERVE_WEI = 3_000_000_000_000_000n;

function assetKind(a: SwapAsset): QuoteKind {
  if (!isOndoToken(a.address)) return "crypto";
  const kind = Object.entries(ONDO_TOKENS).find(([, t]) => t.address.toLowerCase() === a.address.toLowerCase())?.[1].kind;
  return kind === "Stock" ? "stock" : kind === "ETF" ? "etf" : "rwa";
}

const kindLabel = (a: SwapAsset) => (isOndoToken(a.address) ? (ondoSymbolOf(a.address) ?? a.symbol) : a.symbol);

/**
 * The trade ticket of a token page, wired to the swap engine: quotes (debounced, best route over
 * existing v4 pools), balances (private RPC), Permit2 approvals and the swap itself, the 90/10 fee
 * split, the anti-sniper surcharge countdown, the price impact ladder and the liquidity panel.
 * Mount it with the token and nothing else:
 *
 *   <ConnectedTradePanel token={{ address, symbol }} causeName="Wildlife rescue" />
 */
export function ConnectedTradePanel({ token: input, causeName = "the cause", causeIcon, hideDetails, onSwapped, className }: ConnectedTradePanelProps) {
  const cfg = useAppConfig();
  const deps = useDeps();
  const clients = useSwapClients();
  const { isConnected } = useAccount();
  const { connectors, connect } = useConnect();

  const resolved = useQuery({
    queryKey: ["market-token", input.address, input.hook ?? null, input.quote ?? null],
    staleTime: 5 * 60_000,
    queryFn: () => resolveMarketToken({ chain: clients.chain, indexer: deps.indexer, cfg }, input),
  });
  const token = resolved.data ?? null;

  const [side, setSide] = useState<TradeSide>("buy");
  const [asset, setAsset] = useState<SwapAsset>(ETH);
  const [amountText, setAmountText] = useState("");
  const [slippagePct, setSlippagePct] = useState(1);
  const [pickerOpen, setPickerOpen] = useState(false);

  const registry = useRegistryAssets();
  const registryAssets = registry.data;
  const assets = useMemo(() => (token ? tradeAssets(token.quote, registryAssets) : []), [token, registryAssets]);
  const routing = useMemo(() => ({ extraHubs: registryAssets ?? [] }), [registryAssets]);
  const tokenAsset: SwapAsset | null = token ? { address: token.address, symbol: token.symbol, decimals: token.decimals ?? 18 } : null;

  const swap = useSwap();
  const q = useSwapQuote({ token, side, asset, amountText, slippagePct, routing });
  const { market, quoteUsd } = usePoolMarket(token);
  const balances = useBalances(useMemo(() => (tokenAsset ? [...assets, tokenAsset] : assets), [assets, tokenAsset?.address])); // eslint-disable-line react-hooks/exhaustive-deps
  const usd = useUsdPrices(assets);

  // clear the amount when the direction flips: it is in a different unit
  useEffect(() => {
    setAmountText("");
    swap.reset();
  }, [side]); // eslint-disable-line react-hooks/exhaustive-deps

  const payAsset = side === "buy" ? asset : tokenAsset;
  const receiveAsset = side === "buy" ? tokenAsset : asset;
  const payUsdPrice = side === "buy" ? (usd.data?.get(asset.address.toLowerCase()) ?? null) : (market?.priceUsd ?? null);

  // ----- price impact ladder: the route of a small reference trade, then bigger sizes on that route
  const ladder = useQuery({
    queryKey: ["swap-ladder", token?.address, side, asset.address, payUsdPrice ? Math.round(payUsdPrice * 100) : null],
    enabled: Boolean(token && payUsdPrice && !hideDetails),
    staleTime: 30_000,
    queryFn: async () => {
      const ref = DEFAULT_IMPACT_SIZES[0]! / payUsdPrice!;
      const decimals = side === "buy" ? asset.decimals : (token!.decimals ?? 18);
      const refText = ref.toFixed(Math.min(decimals, 8));
      const quote = await requestTradeQuote({ chain: clients.chain }, { token: token!, side, asset, amountText: refText, slippagePct, routing });
      if (!quote) return [];
      return quoteImpactLadder(clients.chain, quote, payUsdPrice!, DEFAULT_IMPACT_SIZES);
    },
  });

  const depth = useQuery({
    queryKey: ["swap-depth", token?.quote.address, quoteUsd],
    enabled: Boolean(token && quoteUsd && !hideDetails),
    staleTime: 60_000,
    queryFn: () => loadQuoteRouteDepth(clients.chain, token!.quote, quoteUsd),
  });

  if (resolved.isError) {
    return (
      <section className={className} role="alert" aria-label="Trade">
        Trading is not available for this token yet: {resolved.error instanceof Error ? resolved.error.message : "its pool could not be found"}.
      </section>
    );
  }
  if (!token || !tokenAsset || !payAsset || !receiveAsset) {
    return <section className={className} aria-busy="true" aria-label="Trade">Loading the trade ticket…</section>;
  }

  const quote = q.quote;
  const payBalance = balances.balanceOf(payAsset);
  const payRaw = payAmountRaw({ token, side, asset, amountText });
  const nativeIn = payAsset.address === ETH.address;
  const maxRaw = payBalance !== undefined ? (nativeIn ? (payBalance > GAS_RESERVE_WEI ? payBalance - GAS_RESERVE_WEI : 0n) : payBalance) : undefined;

  const toTradeToken = (a: SwapAsset): TradeToken => {
    const bal = balances.balanceOf(a);
    return { symbol: kindLabel(a), kind: assetKind(a), balance: bal === undefined ? undefined : formatDisplay(bal, a.decimals) };
  };

  const insufficient = isConnected && payRaw !== null && payBalance !== undefined && payRaw > payBalance;
  const marketSession = usMarketSession(new Date());
  const ondoInvolved = isOndoToken(token.quote.address) || isOndoToken(asset.address);

  let blocker: TradeBlocker | null = null;
  if (!isConnected) blocker = { label: "Connect wallet", onAction: () => connectors[0] && connect({ connector: connectors[0] }) };
  else if (payRaw === null) blocker = null; // the panel says "Enter an amount"
  else if (insufficient) blocker = { label: `Insufficient ${payAsset.symbol} balance` };
  else if (q.status === "loading" && !quote) blocker = { label: "Fetching best price…" };
  else if (q.status === "error" && q.error) blocker = { label: REASON_LABEL[q.error.reason] };
  else if (q.stale && q.status === "loading") blocker = { label: "Updating price…" };
  else if (quote && quote.blockers.length > 0) blocker = { label: REASON_LABEL[quote.blockers[0]!] };
  else if (!quote) blocker = { label: "Fetching best price…" };

  const feeFraction = quote?.feeFraction ?? 0;
  const payValueUsd = payRaw !== null && payUsdPrice ? (Number(payRaw) / 10 ** payAsset.decimals) * payUsdPrice : null;
  const causeValue = (share: number) => (payValueUsd !== null ? formatUsd(payValueUsd * feeFraction * share) : undefined);
  const sniper = quote?.fee.sniperActive
    ? { active: true, detail: `${formatPercent(quote.fee.sniperBps / 100)}${quote.fee.sniperEndsAt ? ` · ends in ${formatTimeUntil(Math.max(0, quote.fee.sniperEndsAt * 1000 - Date.now()))}` : ""}` }
    : undefined;

  const notices: ReactNode[] = [];
  if (quote && ondoInvolved && marketSession.session !== "open") {
    notices.push(
      <p key="market" role="note" className="m-0 text-[13px] text-ink-soft">
        {marketSession.session === "paused" ? "Paused by Ondo." : "US market closed."} Prices of {token.quote.symbol} can be stale until {marketSession.next ? `the next open in ${formatTimeUntil(marketSession.next.getTime() - Date.now())}` : "it reopens"}; large trades may get a worse rate.
      </p>,
    );
  }
  if (quote) {
    notices.push(
      <p key="route" className="m-0 text-[13px] text-ink-muted">
        Route: {quote.routeLabel}
        {quote.alternatives.length > 1 ? ` (best of ${quote.alternatives.length})` : ""}
      </p>,
    );
  }
  for (const w of quote?.compliance.warnings ?? []) if (w.reason !== "market-closed") notices.push(<p key={w.message} role="note" className="m-0 text-[13px] text-ink-soft">{w.message}</p>);
  if (quote?.compliance.blockers.length)
    notices.push(
      <p key="blocked" role="alert" className="m-0 text-[13px] text-terracotta-strong">
        {quote.compliance.blockers.map((b) => b.message).join(". ")}
      </p>,
    );
  if (swap.steps.length > 0 && swap.phase !== "idle") {
    notices.push(
      <ol key="steps" aria-label="Swap progress" className="m-0 list-none space-y-0.5 p-0 text-[13px] text-ink-soft">
        {swap.steps.map((s) => (
          <li key={s.id} aria-current={s.status === "active" ? "step" : undefined}>
            {s.status === "done" ? "Done" : s.status === "active" ? "Now" : s.status === "error" ? "Failed" : "Next"}: {s.label}
          </li>
        ))}
      </ol>,
    );
  }
  if (swap.phase === "error" && swap.error && swap.error.reason !== "user-rejected") {
    notices.push(
      <p key="err" role="alert" className="m-0 text-[13px] text-terracotta-strong">
        {swap.error.message}
      </p>,
    );
  }
  if (swap.phase === "error" && swap.error?.reason === "user-rejected") {
    notices.push(
      <p key="rejected" role="status" className="m-0 text-[13px] text-ink-soft">
        Cancelled in your wallet. Nothing was swapped; press the button to try again.
      </p>,
    );
  }
  if (q.error && quote && q.stale) notices.push(<p key="stale" role="status" className="m-0 text-[13px] text-ink-muted">Could not refresh the price: {q.error.message}</p>);
  if (q.status === "error" && q.error) notices.push(<p key="qerr" role="alert" className="m-0 text-[13px] text-terracotta-strong">{q.error.message}</p>);

  const onSubmit = () => {
    if (!quote) return;
    void swap.execute(quote, {
      causeName,
      onSuccess: () => {
        setAmountText("");
        void balances.refresh();
        onSwapped?.();
      },
    });
  };

  return (
    <div className={className} data-slot="connected-trade-panel">
      <div className="mb-2 flex items-center gap-2 text-[13px] text-ink-muted">
        <span>{side === "buy" ? "Pay with" : "Receive in"}</span>
        <DropdownMenu open={pickerOpen} onOpenChange={setPickerOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" aria-label={`${side === "buy" ? "Pay with" : "Receive in"} ${asset.symbol}, change`}>
              {kindLabel(asset)}
              <ChevronDown aria-hidden="true" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{side === "buy" ? "Pay with" : "Receive in"}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={asset.address}
              onValueChange={(v) => {
                const next = assets.find((a) => a.address === v);
                if (next) {
                  setAsset(next);
                  setAmountText("");
                }
              }}
            >
              {assets.map((a) => (
                <DropdownMenuRadioItem key={a.address} value={a.address}>
                  {kindLabel(a)}
                  {balances.balanceOf(a) !== undefined ? <span className="num ml-auto pl-4 text-ink-muted">{formatDisplay(balances.balanceOf(a)!, a.decimals)}</span> : null}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <TradePanel
        side={side}
        onSideChange={setSide}
        pay={toTradeToken(payAsset)}
        receive={toTradeToken(receiveAsset)}
        payAmount={amountText}
        onPayAmountChange={setAmountText}
        receiveAmount={quote ? formatDisplay(quote.amountOut, receiveAsset.decimals) : ""}
        payFiat={payValueUsd !== null ? formatUsd(payValueUsd) : undefined}
        payPriceUsd={payUsdPrice ?? undefined}
        payBalanceRaw={payBalance !== undefined ? formatRaw(payBalance, payAsset.decimals, 8) : undefined}
        maxAmount={maxRaw !== undefined ? formatRaw(maxRaw, payAsset.decimals, 8) : undefined}
        onPickPayToken={() => setPickerOpen(true)}
        slippage={slippagePct}
        onSlippageChange={setSlippagePct}
        priceImpact={quote?.best.priceImpactPct}
        minReceived={quote ? formatDisplay(quote.amountOutMin, receiveAsset.decimals) : undefined}
        fee={formatPercent((quote?.fee.feeBps ?? 0) / 100)}
        sniperFee={sniper}
        causeAmount={causeValue(0.9)}
        platformAmount={causeValue(0.1)}
        causeName={causeName}
        causeIcon={causeIcon}
        blocker={blocker}
        pending={swap.busy}
        onSubmit={onSubmit}
        notice={notices.length > 0 ? <div className="flex flex-col gap-1.5">{notices}</div> : undefined}
      />

      {hideDetails ? null : (
        <div className="mt-4 flex flex-col gap-4">
          {ladder.data && ladder.data.length > 0 ? <PriceImpactLadder steps={ladder.data} route={quote?.routeLabel} /> : null}
          <LiquidityPanel
            quote={{ symbol: token.quote.symbol, name: quoteName(token.quote), kind: assetKind(token.quote), description: `${assetKind(token.quote) === "crypto" ? "Wrapped ether" : "Tokenized asset"} · ${token.quote.decimals} decimals` }}
            poolLiquidity={market?.depthUsd != null ? formatUsd(market.depthUsd) : market?.depthQuote != null ? `${market.depthQuote.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${token.quote.symbol}` : "—"}
            quotePrice={quoteUsd != null ? formatUsd(quoteUsd) : "—"}
            routeDepth={depth.data ? (depth.data.impactPct === null ? `Can't fill ${formatUsd(depth.data.sizeUsd)}` : `${formatPercent(depth.data.impactPct)} at ${formatUsd(depth.data.sizeUsd)}`) : "—"}
            lpStatus="Locked forever"
            route={`Fees convert ${token.quote.symbol} to USDC before they go to the cause. Trades route through existing Uniswap v4 pools when you pay in another asset.`}
            warning={ondoInvolved && marketSession.session !== "open" ? true : undefined}
          />
        </div>
      )}
    </div>
  );
}

function quoteName(a: SwapAsset): string {
  if (isOndoToken(a.address)) return `${a.symbol} (Ondo)`;
  return a.symbol === "WETH" ? "Wrapped Ether" : a.symbol;
}

