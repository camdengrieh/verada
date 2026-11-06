// Adapted from 21st.dev @vijayksingh/meter (id 37294): a row of lit segments for a level in a range.
// Rebuilt on a log scale with liquidity tiers that carry a text label as well as a colour.
import type { ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";

/**
 * How deep a market is, in USD. Liquidity spans five orders of magnitude across Ondo tokens (most
 * have none), so the bar is logarithmic: $1K lights the first segment, $10M lights them all.
 */

export type LiquidityTier = "deep" | "ok" | "thin" | "none";

export interface LiquidityThresholds {
  /** At or above this many USD a market is "ok" (default $25K). */
  ok: number;
  /** At or above this it is "deep" (default $250K). */
  deep: number;
}

export const DEFAULT_LIQUIDITY_THRESHOLDS: LiquidityThresholds = { ok: 25_000, deep: 250_000 };

/** none for zero or missing, thin below `ok`, ok below `deep`, then deep. */
export function liquidityTier(usd: number | null | undefined, thresholds: LiquidityThresholds = DEFAULT_LIQUIDITY_THRESHOLDS): LiquidityTier {
  if (!usd || usd <= 0 || !Number.isFinite(usd)) return "none";
  if (usd >= thresholds.deep) return "deep";
  if (usd >= thresholds.ok) return "ok";
  return "thin";
}

export interface LogScale {
  /** USD at the start of the bar (default $1K). */
  min: number;
  /** USD that fills the bar (default $10M). */
  max: number;
}

export const DEFAULT_LIQUIDITY_SCALE: LogScale = { min: 1_000, max: 10_000_000 };

/** Position of `usd` on a log10 scale, clamped to 0–1. Zero stays zero; anything above zero shows a sliver. */
export function liquidityFraction(usd: number | null | undefined, scale: LogScale = DEFAULT_LIQUIDITY_SCALE): number {
  if (!usd || usd <= 0 || !Number.isFinite(usd)) return 0;
  const lo = Math.log10(scale.min);
  const hi = Math.log10(scale.max);
  const f = (Math.log10(usd) - lo) / (hi - lo || 1);
  return Math.min(1, Math.max(0.02, f));
}

const compactUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: 1 });
const wholeUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** "$58.2K", "$1.2M"; under $1,000 printed whole ("$640"). */
export function formatUsdCompact(usd: number): string {
  return Math.abs(usd) < 1000 ? wholeUsd.format(usd) : compactUsd.format(usd);
}

export const LIQUIDITY_TIER_LABEL: Record<LiquidityTier, string> = {
  deep: "Deep",
  ok: "OK",
  thin: "Thin",
  none: "No liquidity",
};

const TIER_TONE: Record<LiquidityTier, { lit: string; text: string }> = {
  deep: { lit: "bg-sage", text: "text-sage-ink" },
  ok: { lit: "bg-sky", text: "text-stock-ink" },
  thin: { lit: "bg-ochre", text: "text-ochre-ink" },
  none: { lit: "bg-line-strong", text: "text-ink-muted" },
};

export interface LiquidityMeterProps extends Omit<ComponentProps<"div">, "children"> {
  /** Depth in USD; 0 or undefined is "No liquidity". */
  value: number | null | undefined;
  /** What is measured, for the accessible name and the card header ("Route depth to USDC"). */
  label?: string;
  thresholds?: LiquidityThresholds;
  scale?: LogScale;
  /** `cell` is one compact line for tables; `card` adds a header and threshold ticks. */
  variant?: "cell" | "card";
  segments?: number;
  /** Overrides the formatted value ("$58,200"). */
  valueText?: string;
}

/** Log-scale depth bar with a tier word (Deep / OK / Thin / No liquidity) beside it. */
export function LiquidityMeter({
  value,
  label = "Liquidity",
  thresholds = DEFAULT_LIQUIDITY_THRESHOLDS,
  scale = DEFAULT_LIQUIDITY_SCALE,
  variant = "cell",
  segments,
  valueText,
  className,
  ...props
}: LiquidityMeterProps) {
  const tier = liquidityTier(value, thresholds);
  const fraction = liquidityFraction(value, scale);
  const count = segments ?? (variant === "card" ? 16 : 8);
  const lit = tier === "none" ? 0 : Math.max(1, Math.round(fraction * count));
  const tone = TIER_TONE[tier];
  const formatted = valueText ?? (value && value > 0 ? formatUsdCompact(value) : "$0");
  const tierLabel = LIQUIDITY_TIER_LABEL[tier];
  const spoken = tier === "none" ? `${label}: no liquidity` : `${label}: ${formatted}, ${tierLabel.toLowerCase()}`;

  const bar = (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      aria-valuetext={spoken}
      className={cn("flex min-w-0 gap-[3px]", variant === "card" ? "h-3 w-full flex-none" : "h-2 flex-1")}
    >
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          data-lit={i < lit ? "" : undefined}
          className={cn("flex-1 rounded-[2px] transition-colors duration-300", i < lit ? tone.lit : "bg-sand")}
        />
      ))}
    </div>
  );

  if (variant === "cell") {
    return (
      <div data-slot="liquidity-meter" data-tier={tier} className={cn("flex min-w-0 items-center gap-2.5", className)} {...props}>
        <div className="flex w-20 shrink-0 sm:w-24">{bar}</div>
        <span className={cn("text-[13px] whitespace-nowrap", tone.text)}>
          {tier === "none" ? (
            <span className="font-semibold">{tierLabel}</span>
          ) : (
            <>
              <span className="num font-semibold text-ink">{formatted}</span> <span className="font-semibold">{tierLabel}</span>
            </>
          )}
        </span>
      </div>
    );
  }

  const tick = (usd: number) => `${liquidityFraction(usd, scale) * 100}%`;
  return (
    <div data-slot="liquidity-meter" data-tier={tier} className={cn("@container flex flex-col gap-2", className)} {...props}>
      <div className="flex flex-col gap-0.5 @[16rem]:flex-row @[16rem]:items-baseline @[16rem]:justify-between @[16rem]:gap-3">
        <span className="text-[13px] text-ink-muted">{label}</span>
        <span className={cn("text-sm", tone.text)}>
          <span className="num font-semibold text-ink">{tier === "none" ? "$0" : formatted}</span>
          {" · "}
          <span className="font-semibold">{tierLabel}</span>
        </span>
      </div>
      {bar}
      <div aria-hidden="true" className="relative h-5 text-[11px] text-ink-muted">
        {[
          { key: "ok", usd: thresholds.ok, text: "ok" },
          { key: "deep", usd: thresholds.deep, text: "deep" },
        ].map(({ key, usd, text }) => (
          <span key={key} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: tick(usd) }}>
            <span className="mx-auto mb-0.5 block h-1 w-px bg-ink-muted" />
            <span className="num">{formatUsdCompact(usd)}</span>
            <span className="hidden @[20rem]:inline"> {text}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
