// Written for Varada on lightweight-charts v5. Layout and OHLC readout follow 21st.dev @ssychui/candle-chart (id 22250), which is SVG-only.
"use client";

import type {
  CandlestickData,
  HistogramData,
  IChartApi,
  ISeriesApi,
  SingleValueData,
  UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@varada/ui/lib/utils";

export interface PriceCandle {
  /** Seconds since the Unix epoch (UTC). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface PricePoint {
  time: number;
  value: number;
}

export interface PriceChartProps {
  /** `candles` draws OHLC candles with a volume strip; `area` draws a filled close line. */
  kind?: "candles" | "area";
  candles?: PriceCandle[];
  /** Points for `area`; derived from candle closes when omitted. */
  points?: PricePoint[];
  /** Accessible summary of what the chart shows, e.g. "NVDAon price, last 24 hours, up 4.2%". */
  label: string;
  height?: number;
  loading?: boolean;
  /** Header slot: symbol, price and the timeframe tabs. */
  toolbar?: ReactNode;
  /** Price formatter for the scale and crosshair. */
  formatPrice?: (n: number) => string;
  className?: string;
}

type Palette = {
  card: string;
  text: string;
  line: string;
  gain: string;
  loss: string;
  area: string;
  font: string;
};

/** Read the theme tokens at mount (and when the theme class changes): canvas cannot use CSS vars. */
function readPalette(el: HTMLElement): Palette {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  // Fallbacks only matter if the token sheet failed to load; they mirror Direction A light.
  return {
    card: v("--card", v("--paper-card", "white")),
    text: v("--ink-muted", "gray"),
    line: v("--line", "lightgray"),
    gain: v("--gain", "green"),
    loss: v("--loss", "red"),
    area: v("--chart-1", v("--sage", "green")),
    font: css.fontFamily || "monospace",
  };
}

/** `#rrggbb` + alpha → `rgba()`, anything else passes through. */
function alpha(color: string, a: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return color;
  return `rgba(${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)}, ${a})`;
}

/**
 * Client-only price chart on lightweight-charts. The library is imported inside an effect, so it
 * never runs during static export; a skeleton holds the space until the canvas is ready. Colours
 * come from the CSS tokens and are re-read when the `dark` class flips. Size follows the container
 * through a ResizeObserver. The canvas is summarised for assistive tech by `label`.
 */
export function PriceChart({
  kind = "candles",
  candles = [],
  points,
  label,
  height = 360,
  loading = false,
  toolbar,
  formatPrice,
  className,
}: PriceChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Area"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const paletteRef = useRef<Palette | null>(null);
  const [ready, setReady] = useState(false);
  const [themeTick, setThemeTick] = useState(0);
  const formatRef = useRef(formatPrice);
  useEffect(() => {
    formatRef.current = formatPrice;
  });

  // Create the chart once per kind.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let resize: ResizeObserver | null = null;
    let themeWatch: MutationObserver | null = null;

    void import("lightweight-charts").then((lib) => {
      if (disposed || !host.current) return;
      const p = readPalette(el);
      paletteRef.current = p;
      const chart = lib.createChart(el, {
        width: el.clientWidth,
        height,
        // TradingView's logo links off-site; attribution is carried in the site credits instead.
        layout: {
          background: { type: lib.ColorType.Solid, color: p.card },
          textColor: p.text,
          fontFamily: p.font,
          fontSize: 12,
          attributionLogo: false,
        },
        grid: { vertLines: { color: alpha(p.line, 0.6) }, horzLines: { color: alpha(p.line, 0.6) } },
        rightPriceScale: { borderColor: p.line },
        timeScale: { borderColor: p.line, timeVisible: true, secondsVisible: false },
        crosshair: { mode: lib.CrosshairMode.Magnet },
        localization: { priceFormatter: (n: number) => (formatRef.current ? formatRef.current(n) : n.toFixed(n < 1 ? 6 : 2)) },
      });
      chartRef.current = chart;

      if (kind === "candles") {
        priceRef.current = chart.addSeries(lib.CandlestickSeries, {
          upColor: p.gain,
          downColor: p.loss,
          borderUpColor: p.gain,
          borderDownColor: p.loss,
          wickUpColor: p.gain,
          wickDownColor: p.loss,
        });
        const volume = chart.addSeries(lib.HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "" });
        volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
        priceRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.25 } });
        volumeRef.current = volume;
      } else {
        priceRef.current = chart.addSeries(lib.AreaSeries, {
          lineColor: p.area,
          topColor: alpha(p.area, 0.28),
          bottomColor: alpha(p.area, 0.02),
          lineWidth: 2,
        });
      }

      resize = new ResizeObserver(([entry]) => {
        if (entry) chart.resize(Math.floor(entry.contentRect.width), height);
      });
      resize.observe(el);

      themeWatch = new MutationObserver(() => {
        const q = readPalette(el);
        paletteRef.current = q;
        chart.applyOptions({
          layout: { background: { type: lib.ColorType.Solid, color: q.card }, textColor: q.text, fontFamily: q.font },
          grid: { vertLines: { color: alpha(q.line, 0.6) }, horzLines: { color: alpha(q.line, 0.6) } },
          rightPriceScale: { borderColor: q.line },
          timeScale: { borderColor: q.line },
        });
        if (kind === "candles") {
          priceRef.current?.applyOptions({
            upColor: q.gain,
            downColor: q.loss,
            borderUpColor: q.gain,
            borderDownColor: q.loss,
            wickUpColor: q.gain,
            wickDownColor: q.loss,
          });
        } else {
          priceRef.current?.applyOptions({ lineColor: q.area, topColor: alpha(q.area, 0.28), bottomColor: alpha(q.area, 0.02) });
        }
        setThemeTick((t) => t + 1); // re-run the data effect so volume bar colours follow
      });
      themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
      setReady(true);
    });

    return () => {
      disposed = true;
      resize?.disconnect();
      themeWatch?.disconnect();
      chartRef.current?.remove();
      chartRef.current = null;
      priceRef.current = null;
      volumeRef.current = null;
      setReady(false);
    };
  }, [kind, height]);

  // Push data whenever it (or readiness) changes.
  useEffect(() => {
    if (!ready || !priceRef.current) return;
    const p = paletteRef.current;
    if (kind === "candles") {
      const data: CandlestickData<UTCTimestamp>[] = candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      (priceRef.current as ISeriesApi<"Candlestick">).setData(data);
      const vol: HistogramData<UTCTimestamp>[] = candles
        .filter((c) => c.volume !== undefined)
        .map((c) => ({
          time: c.time as UTCTimestamp,
          value: c.volume!,
          color: p ? alpha(c.close >= c.open ? p.gain : p.loss, 0.35) : undefined,
        }));
      volumeRef.current?.setData(vol);
    } else {
      const series: SingleValueData<UTCTimestamp>[] = (points ?? candles.map((c) => ({ time: c.time, value: c.close }))).map((pt) => ({
        time: pt.time as UTCTimestamp,
        value: pt.value,
      }));
      (priceRef.current as ISeriesApi<"Area">).setData(series);
    }
    chartRef.current?.timeScale().fitContent();
  }, [ready, kind, candles, points, themeTick]);

  const showSkeleton = loading || !ready;

  return (
    <div data-slot="price-chart" className={cn("flex flex-col gap-3", className)}>
      {toolbar ? <div className="flex flex-wrap items-center justify-between gap-3">{toolbar}</div> : null}
      <div className="relative overflow-hidden rounded-xl" style={{ height }}>
        <div ref={host} role="img" aria-label={label} className="absolute inset-0 font-mono" />
        {showSkeleton ? (
          <div aria-hidden="true" className="absolute inset-0 flex items-end gap-1.5 bg-card p-4">
            {Array.from({ length: 28 }, (_, i) => (
              <span
                key={i}
                className="flex-1 animate-pulse rounded-sm bg-sand"
                style={{ height: `${30 + ((i * 37) % 50)}%`, animationDelay: `${(i % 7) * 80}ms` }}
              />
            ))}
          </div>
        ) : null}
        {loading ? (
          <span role="status" className="sr-only">
            Loading chart
          </span>
        ) : null}
      </div>
    </div>
  );
}

export interface ChartTimeframesProps {
  options: readonly string[];
  value: string;
  onChange: (value: string) => void;
  /** Accessible name for the group, e.g. "Chart timeframe". */
  label?: string;
  className?: string;
}

/** Segmented timeframe switch (1H, 24H, 7D…) for the chart toolbar; buttons with `aria-pressed`. */
export function ChartTimeframes({ options, value, onChange, label = "Chart timeframe", className }: ChartTimeframesProps) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex rounded-full bg-sand p-1", className)}>
      {options.map((opt) => {
        const on = opt === value;
        return (
          <button
            key={opt}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(opt)}
            className={cn(
              "num inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full px-3 text-sm font-semibold transition-colors",
              on ? "bg-paper-card text-ink shadow-paper" : "text-ink-muted hover:text-ink",
            )}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
