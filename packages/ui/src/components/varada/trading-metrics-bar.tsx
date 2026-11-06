// Adapted from 21st.dev @kuratlielia/stats-band (id 35089): a band of headline numbers that count up into
// view in a hairline grid. Rebuilt with NumberTicker, ▲/▼ deltas and container queries: one ruled row on
// wide containers, a 2-column grid (or a snap-scrolling strip) on narrow ones.
"use client";

import { HandHeart } from "lucide-react";
import type { ReactNode } from "react";
import { Delta } from "@verada/ui/components/data/stat-card";
import { NumberTicker } from "@verada/ui/components/motion/number-ticker";
import { cn } from "@verada/ui/lib/utils";

export interface TradingMetric {
  key: string;
  label: string;
  /** Null shows a dash ("not indexed yet"). */
  value: number | null;
  format?: Intl.NumberFormatOptions;
  /** Signed change in percent; ▲ / ▼ with the period after it. */
  delta?: number;
  /** "24h", "7d". */
  deltaPeriod?: string;
  /** Small print under the value ("since launch"). */
  hint?: ReactNode;
  /** `cause` paints the value sage (fees to causes). */
  tone?: "default" | "cause";
  icon?: ReactNode;
  /** The lead metric (price): bigger, and two cells wide in the narrow grid. */
  lead?: boolean;
}

/** Price formatting that keeps tiny memecoin prices readable: $0.00004213, $1.27, $3,412.50. */
export function priceFormat(price: number): Intl.NumberFormatOptions {
  return price > 0 && price < 1
    ? { style: "currency", currency: "USD", minimumSignificantDigits: 2, maximumSignificantDigits: 4 }
    : { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 };
}

export const COMPACT_USD: Intl.NumberFormatOptions = { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 };
export const WHOLE: Intl.NumberFormatOptions = { maximumFractionDigits: 0 };

export interface TradingMetricsInput {
  priceUsd?: number | null;
  change24h?: number;
  marketCapUsd?: number | null;
  marketCapChange?: number;
  volume24hUsd?: number | null;
  volumeChange?: number;
  liquidityUsd?: number | null;
  liquidityChange?: number;
  holders?: number | null;
  holdersChange?: number;
  /** Fees sent to causes (90% of trading fees), USD, since launch. */
  feesToCausesUsd?: number | null;
  feesChange?: number;
}

/** The standard seven: price (with 24h), market cap, volume, liquidity, holders and fees to causes. */
export function tradingMetrics(m: TradingMetricsInput): TradingMetric[] {
  const out: TradingMetric[] = [];
  if (m.priceUsd !== undefined)
    out.push({ key: "price", label: "Price", value: m.priceUsd, format: priceFormat(m.priceUsd ?? 1), delta: m.change24h, deltaPeriod: "24h", lead: true });
  if (m.marketCapUsd !== undefined) out.push({ key: "mcap", label: "Market cap", value: m.marketCapUsd, format: COMPACT_USD, delta: m.marketCapChange, deltaPeriod: "24h" });
  if (m.volume24hUsd !== undefined) out.push({ key: "volume", label: "Volume 24h", value: m.volume24hUsd, format: COMPACT_USD, delta: m.volumeChange, deltaPeriod: "vs prior 24h" });
  if (m.liquidityUsd !== undefined) out.push({ key: "liquidity", label: "Liquidity", value: m.liquidityUsd, format: COMPACT_USD, delta: m.liquidityChange, deltaPeriod: "24h" });
  if (m.holders !== undefined) out.push({ key: "holders", label: "Holders", value: m.holders, format: WHOLE, delta: m.holdersChange, deltaPeriod: "24h" });
  if (m.feesToCausesUsd !== undefined)
    out.push({
      key: "fees",
      label: "Fees to causes",
      value: m.feesToCausesUsd,
      format: COMPACT_USD,
      delta: m.feesChange,
      deltaPeriod: "24h",
      tone: "cause",
      icon: <HandHeart />,
      hint: "90% of fees, paid in USDC",
    });
  return out;
}

export interface TradingMetricsBarProps {
  metrics: readonly TradingMetric[];
  /** Narrow containers: a 2-column `grid` (default) or a horizontally scrolling `scroll` strip. */
  narrow?: "grid" | "scroll";
  /** Count up when first in view and spring between live values (default true; off under reduced motion). */
  animate?: boolean;
  /** Accessible name of the bar (default "Trading metrics"). */
  label?: string;
  className?: string;
}

/**
 * Price, 24h, market cap, volume, liquidity, holders and fees to causes in one ruled band. Hairline
 * dividers sit between the metrics at every width; the layout follows the bar's container, not the screen.
 */
export function TradingMetricsBar({ metrics, narrow = "grid", animate = true, label = "Trading metrics", className }: TradingMetricsBarProps) {
  const scroll = narrow === "scroll";
  const fillsHole = metrics.filter((m) => !m.lead).length % 2 === 1;
  const list = (
    <dl
      className={cn(
        // -ml-px / -mt-px hide the outer edge of each cell's left/top rule, leaving only dividers.
        "m-0 -mt-px -ml-px",
        scroll
          ? "flex @4xl:flex-nowrap"
          : "grid grid-cols-2 @lg:grid-cols-4 @4xl:flex @4xl:flex-nowrap",
      )}
    >
      {metrics.map((m, i) => (
        <div
          key={m.key}
          data-metric={m.key}
          className={cn(
            "flex min-w-0 flex-col gap-1 border-t border-l border-line px-4 py-3",
            scroll ? "w-[10.5rem] shrink-0 snap-start @4xl:w-auto @4xl:min-w-0 @4xl:flex-1 @4xl:shrink" : "@4xl:min-w-0 @4xl:flex-1",
            m.lead && (scroll ? "w-[12.5rem] @4xl:flex-[1.4]" : "col-span-2 @4xl:flex-[1.4]"),
            // An odd number of small cells leaves a hole in the 2- and 4-column grids; the last one fills it.
            !scroll && !m.lead && i === metrics.length - 1 && fillsHole && "col-span-2",
          )}
        >
          <dt className="flex items-center gap-1.5 text-xs font-medium text-ink-muted [&_svg]:size-3.5">
            {m.icon ? <span aria-hidden="true" className={m.tone === "cause" ? "text-sage-ink" : undefined}>{m.icon}</span> : null}
            {m.label}
          </dt>
          <dd className={cn("m-0 font-mono font-semibold leading-tight tracking-tight", m.lead ? "text-2xl" : "text-lg", m.tone === "cause" && "text-sage-ink")}>
            {m.value === null ? (
              <span className="text-ink-muted" aria-label="Not available">–</span>
            ) : animate ? (
              <NumberTicker value={m.value} format={m.format} />
            ) : (
              <span className="num">{new Intl.NumberFormat("en-US", m.format).format(m.value)}</span>
            )}
          </dd>
          {m.delta !== undefined ? (
            <dd className="m-0">
              <Delta value={m.delta} suffix={m.deltaPeriod} className="flex-wrap gap-x-1.5 gap-y-0 text-xs [&>.num]:whitespace-nowrap" />
            </dd>
          ) : null}
          {m.hint ? <dd className="m-0 text-xs text-ink-muted">{m.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );

  return (
    <section data-slot="trading-metrics-bar" aria-label={label} className={cn("@container overflow-hidden rounded-2xl border border-line bg-card", className)}>
      {scroll ? (
        <div tabIndex={0} role="region" aria-label={`${label}, scrolls sideways`} className="relative snap-x snap-mandatory overflow-x-auto outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 @4xl:overflow-visible">
          {list}
        </div>
      ) : (
        list
      )}
    </section>
  );
}
