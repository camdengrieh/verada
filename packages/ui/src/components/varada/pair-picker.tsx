// Adapted from 21st.dev @ssychui/swap-ticket (id 27122): its token picker (logo disc, symbol over name,
// figure at the end, the active row marked) became radio rows inside the quote-asset list, with a
// pair summary under it in the spirit of the ticket's rate footer. Written for the launch Pair step.
"use client";

import { ArrowRight, CircleCheck, CircleX } from "lucide-react";
import { useState } from "react";
import { cn } from "@varada/ui/lib/utils";
import type { LiquidityThresholds } from "./liquidity-meter";
import { PairChip } from "./pair-chip";
import { DEFAULT_MIN_ROUTE_DEPTH, DEFAULT_QUOTE_SYMBOL, coinTicker, feeRouteHops, launchability, type QuoteAsset } from "./quote-asset";
import { QuoteAssetList, type QuoteKindFilter } from "./quote-asset-list";
import type { ImageSource } from "./shared";

export interface PairPickerProps {
  assets: readonly QuoteAsset[];
  now: Date;
  holidays?: readonly string[];
  earlyCloses?: readonly string[];
  /** The coin being launched (`HARAMBE`). */
  coinSymbol: string;
  coinImage?: ImageSource;
  /** Controlled selection. */
  value?: string | null;
  /** Uncontrolled start (default WETH). */
  defaultValue?: string | null;
  onValueChange?: (symbol: string) => void;
  minDepthUsd?: number;
  thresholds?: LiquidityThresholds;
  title?: string;
  headingLevel?: 2 | 3 | 4;
  defaultKind?: QuoteKindFilter;
  className?: string;
}

/**
 * The launch Pair step: every quote asset in one radio list (All / Crypto / Stocks / ETFs, crypto
 * first, WETH preselected) and a summary of the pair it makes: "$HARAMBE / WETH", the fee route to
 * USDC and whether the coin can launch with it. Discover uses QuoteAssetList in link mode instead.
 */
export function PairPicker({
  assets,
  now,
  holidays,
  earlyCloses,
  coinSymbol,
  coinImage,
  value,
  defaultValue = DEFAULT_QUOTE_SYMBOL,
  onValueChange,
  minDepthUsd = DEFAULT_MIN_ROUTE_DEPTH,
  thresholds,
  title = "Pair it with",
  headingLevel = 3,
  defaultKind,
  className,
}: PairPickerProps) {
  const [internal, setInternal] = useState<string | null>(defaultValue);
  const selected = value !== undefined ? value : internal;
  const asset = selected ? assets.find((a) => a.symbol === selected) : undefined;
  const coin = coinSymbol.replace(/^\$/, "");
  const hops = asset ? feeRouteHops(asset, coin) : null;
  const launch = asset ? launchability(asset, minDepthUsd) : null;

  return (
    <div data-slot="pair-picker" className={cn("@container flex flex-col gap-4", className)}>
      <QuoteAssetList
        mode="select"
        assets={assets}
        now={now}
        holidays={holidays}
        earlyCloses={earlyCloses}
        coinSymbol={coin}
        minDepthUsd={minDepthUsd}
        thresholds={thresholds}
        title={title}
        headingLevel={headingLevel}
        defaultKind={defaultKind}
        value={selected}
        onValueChange={(s) => {
          if (value === undefined) setInternal(s);
          onValueChange?.(s);
        }}
        groupLabel={`Quote asset for ${coinTicker(coin)}`}
      />

      <div aria-live="polite" className="flex flex-col gap-3 rounded-2xl border border-dashed border-line-strong bg-paper p-4 @xl:flex-row @xl:items-center @xl:justify-between">
        {asset ? (
          <>
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-xs text-ink-muted">Your pair</span>
              <PairChip coinSymbol={coin} coinImage={coinImage} quoteSymbol={asset.symbol} quoteKind={asset.kind} quoteLogo={asset.logo} className="w-fit" />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5 @xl:items-end">
              <span className="text-xs text-ink-muted">Fees to causes</span>
              {hops ? (
                <span className="flex flex-wrap items-center gap-1 text-[13px] font-semibold text-ink">
                  {hops.map((h, i) => (
                    <span key={`${h}-${i}`} className="inline-flex items-center gap-1">
                      {i > 0 ? <ArrowRight aria-hidden="true" className="size-3.5 text-ink-muted" /> : null}
                      <span className={h === "USDC" ? "text-sage-ink" : undefined}>{h}</span>
                    </span>
                  ))}
                  <span className="sr-only">{hops.length === 2 ? ", fees are USDC already" : ""}</span>
                </span>
              ) : (
                <span className="text-[13px] font-semibold text-terracotta-strong">No route to USDC</span>
              )}
              <span className={cn("inline-flex items-center gap-1.5 text-[13px] font-semibold", launch?.ok ? "text-sage-ink" : "text-terracotta-strong")}>
                {launch?.ok ? <CircleCheck aria-hidden="true" className="size-4" /> : <CircleX aria-hidden="true" className="size-4" />}
                {launch?.ok ? "Launchable" : `Not launchable: ${launch?.reason}`}
              </span>
            </div>
          </>
        ) : (
          <span className="text-[13px] text-ink-muted">Pick a quote asset for {coinTicker(coin)}. WETH is the usual choice.</span>
        )}
      </div>
    </div>
  );
}
