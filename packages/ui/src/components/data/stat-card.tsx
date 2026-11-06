// Adapted from 21st.dev @ravikatiyar162/stats-card-2 (id 8412): headline value, signed change, sparkline under it.
"use client";

import type { ReactNode } from "react";
import { Card } from "@verada/ui/components/ui/card";
import { NumberTicker } from "@verada/ui/components/motion/number-ticker";
import { Sparkline, type SparklineTone } from "@verada/ui/components/data/sparkline";
import { cn } from "@verada/ui/lib/utils";

export interface DeltaProps {
  /** Signed change. Positive shows ▲ in the gain colour, negative ▼ in the loss colour. */
  value: number;
  /** How the number is written. Defaults to a percentage with up to two decimals. */
  format?: (abs: number) => string;
  /** Plain-language context after the number, e.g. "vs last epoch". */
  suffix?: ReactNode;
  /** On the dark ink card, hue is dropped for paper text; the glyph still carries direction. */
  onInk?: boolean;
  className?: string;
}

const pct = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

/** Gain / loss readout: glyph, colour and a spoken direction, never colour alone. */
export function Delta({ value, format = pct, suffix, onInk = false, className }: DeltaProps) {
  const dir = value > 0 ? "up" : value < 0 ? "down" : "flat";
  const glyph = dir === "up" ? "▲" : dir === "down" ? "▼" : "–";
  return (
    <span
      data-slot="delta"
      data-direction={dir}
      className={cn(
        "inline-flex items-baseline gap-1.5 text-sm font-semibold",
        onInk ? "text-paper" : dir === "up" ? "text-gain" : dir === "down" ? "text-loss" : "text-ink-muted",
        className,
      )}
    >
      <span className="num">
        <span aria-hidden="true">{glyph} </span>
        <span className="sr-only">{dir === "flat" ? "unchanged " : `${dir} `}</span>
        {format(Math.abs(value))}
      </span>
      {suffix ? <span className={cn("font-normal", onInk ? "text-paper/80" : "text-ink-muted")}>{suffix}</span> : null}
    </span>
  );
}

export interface StatCardProps {
  label: ReactNode;
  /** A number animates with NumberTicker and formats with `format`; a string is shown as is. */
  value: number | string;
  format?: Intl.NumberFormatOptions;
  delta?: number;
  deltaFormat?: (abs: number) => string;
  deltaSuffix?: ReactNode;
  /** Trend points for the sparkline under the value. */
  trend?: number[];
  trendTone?: SparklineTone;
  /** Accessible summary of the trend line. */
  trendLabel?: string;
  icon?: ReactNode;
  /** Small print under everything (source, epoch…). */
  hint?: ReactNode;
  tone?: "paper" | "ink" | "sand";
  /** Count up on first view (default true for numbers). */
  animate?: boolean;
  className?: string;
}

/** Headline number card: label, big mono value, delta with ▲/▼ and an optional sparkline. */
export function StatCard({
  label,
  value,
  format,
  delta,
  deltaFormat,
  deltaSuffix,
  trend,
  trendTone = "auto",
  trendLabel,
  icon,
  hint,
  tone = "paper",
  animate = true,
  className,
}: StatCardProps) {
  const onInk = tone === "ink";
  return (
    <Card tone={tone} data-slot="stat-card" className={cn("gap-3", className)}>
      <div className="flex items-start justify-between gap-3">
        <span className={cn("kicker", onInk && "text-paper/80")}>{label}</span>
        {icon ? (
          <span aria-hidden="true" className={cn("[&_svg]:size-5", onInk ? "text-paper/80" : "text-ink-muted")}>
            {icon}
          </span>
        ) : null}
      </div>
      <div className="font-mono text-[2rem] leading-none font-semibold tracking-tight sm:text-4xl">
        {typeof value === "number" ? (
          animate ? (
            <NumberTicker value={value} format={format} />
          ) : (
            <span className="num">{new Intl.NumberFormat("en-US", format).format(value)}</span>
          )
        ) : (
          <span className="num">{value}</span>
        )}
      </div>
      {delta !== undefined ? <Delta value={delta} format={deltaFormat} suffix={deltaSuffix} onInk={onInk} /> : null}
      {trend && trend.length > 1 ? (
        <Sparkline
          data={trend}
          tone={onInk ? "muted" : trendTone}
          label={trendLabel}
          width={240}
          height={48}
          className={cn("h-12 w-full", onInk && "text-paper/70")}
          preserveAspectRatio="none"
          endDot={false}
        />
      ) : null}
      {hint ? <p className={cn("text-xs", onInk ? "text-paper/75" : "text-ink-muted")}>{hint}</p> : null}
    </Card>
  );
}
