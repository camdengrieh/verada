// Adapted from 21st.dev @mirukullacode/tweenly-chart-kpi (id 39900): count-up headline, delta pill and a
// sparkline under (or beside) the number. Rebuilt on NumberTicker, Delta and Sparkline with a period
// switch (24h / 7d / 30d…) and a container query that moves the sparkline beside the value when wide.
"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Delta } from "@varada/ui/components/data/stat-card";
import { Sparkline, type SparklineTone } from "@varada/ui/components/data/sparkline";
import { NumberTicker } from "@varada/ui/components/motion/number-ticker";
import { ToggleGroup, ToggleGroupItem } from "@varada/ui/components/ui/toggle-group";
import { cn } from "@varada/ui/lib/utils";

export interface KpiPeriod {
  /** "24h", "7d", "30d". */
  key: string;
  label?: string;
  value: number;
  /** Signed change over the period, percent. */
  delta?: number;
  /** Points for the sparkline, oldest first. */
  trend?: readonly number[];
  /** Words after the delta ("vs previous 7d"). */
  deltaSuffix?: ReactNode;
}

export interface KpiTileProps {
  label: ReactNode;
  periods: readonly KpiPeriod[];
  value?: string;
  defaultValue?: string;
  onPeriodChange?: (key: string) => void;
  format?: Intl.NumberFormatOptions;
  icon?: ReactNode;
  hint?: ReactNode;
  /** Sparkline colour; `auto` follows the delta (or, without one, the trend) direction. */
  tone?: SparklineTone;
  /** Count up and draw the line (default true; off under reduced motion). */
  animate?: boolean;
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

/** One headline number with a period switch, ▲/▼ change and a sparkline area for the chosen period. */
export function KpiTile({ label, periods, value, defaultValue, onPeriodChange, format, icon, hint, tone = "auto", animate = true, headingLevel = 3, className }: KpiTileProps) {
  const id = useId();
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  const [internal, setInternal] = useState(defaultValue ?? periods[0]?.key ?? "");
  const [plot, setPlot] = useState<HTMLDivElement | null>(null);
  const plotWidth = useWidth(plot);
  const current = value ?? internal;
  const p = periods.find((x) => x.key === current) ?? periods[0];
  if (!p) return null;
  const periodName = p.label ?? p.key;
  const trend = p.trend ? [...p.trend] : [];
  const fmt = new Intl.NumberFormat("en-US", format);
  const trendLabel =
    trend.length > 1 ? `${periodName} trend from ${fmt.format(trend[0]!)} to ${fmt.format(trend.at(-1)!)}` : undefined;

  return (
    <section data-slot="kpi-tile" aria-labelledby={`${id}-label`} className={cn("@container flex flex-col gap-3 rounded-2xl border border-line bg-card p-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading id={`${id}-label`} className="m-0 flex items-center gap-1.5 font-sans text-sm font-semibold text-ink-soft [&_svg]:size-4">
          {icon ? <span aria-hidden="true" className="text-ink-muted">{icon}</span> : null}
          {label}
        </Heading>
        {periods.length > 1 ? (
          <ToggleGroup
            type="single"
            size="sm"
            value={p.key}
            onValueChange={(k) => {
              if (!k) return;
              if (value === undefined) setInternal(k);
              onPeriodChange?.(k);
            }}
            aria-label="Period"
          >
            {periods.map((x) => (
              // sm segments are 32px tall; the pseudo-element grows the hit area to 44px.
              <ToggleGroupItem key={x.key} value={x.key} className="px-2.5 after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']">
                {x.label ?? x.key}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 @sm:grid @sm:grid-cols-[auto_minmax(0,1fr)] @sm:items-end @sm:gap-5">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span aria-live="polite" className="font-mono text-[1.75rem] leading-none font-semibold tracking-tight @md:text-[2rem]">
            {animate ? <NumberTicker value={p.value} format={format} /> : <span className="num">{fmt.format(p.value)}</span>}
          </span>
          {p.delta !== undefined ? <Delta value={p.delta} suffix={p.deltaSuffix ?? `in ${periodName}`} className="flex-wrap gap-x-1.5 gap-y-0 text-xs [&>.num]:whitespace-nowrap" /> : null}
        </div>
        {trend.length > 1 ? (
          // Drawn at the measured width (not a stretched viewBox) so the line keeps its stroke and length.
          <div ref={setPlot} className="h-14 w-full min-w-0">
            <Sparkline key={p.key} data={trend} tone={tone === "auto" && p.delta !== undefined ? (p.delta >= 0 ? "gain" : "loss") : tone} label={trendLabel} width={plotWidth || 240} height={56} animate={animate} endDot={false} className="block max-w-full" />
          </div>
        ) : null}
      </div>

      {hint ? <p className="m-0 text-xs text-ink-muted">{hint}</p> : null}
    </section>
  );
}

/** Content width of an element, tracked with ResizeObserver; 0 until measured. */
function useWidth(node: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!node || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);
  return width;
}
