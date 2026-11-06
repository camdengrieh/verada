// Adapted from 21st.dev @designali-in/gauge (id 1757): an SVG arc whose dash length shows a share, with
// the value in the middle. Turned into a half-circle buy/sell gauge (or a split bar) with a window
// switch, counts and a written verdict, so direction never rests on green and red alone.
"use client";

import { useId, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@verada/ui/components/ui/toggle-group";
import { cn } from "@verada/ui/lib/utils";
import { formatUsdCompact } from "./liquidity-meter";

export interface PressureWindow {
  /** "1h", "24h". */
  key: string;
  /** Shown on the switch; defaults to the key. */
  label?: string;
  buys: number;
  sells: number;
  buyVolumeUsd?: number;
  sellVolumeUsd?: number;
}

export type PressureVerdict = "buyers" | "sellers" | "balanced";

/** Buy share (0–1) by trade count, or by volume when `basis` is volume and both volumes are known. */
export function buyShare(w: PressureWindow, basis: "count" | "volume" = "count"): number {
  const [b, s] = basis === "volume" && w.buyVolumeUsd !== undefined && w.sellVolumeUsd !== undefined ? [w.buyVolumeUsd, w.sellVolumeUsd] : [w.buys, w.sells];
  const total = b + s;
  return total > 0 ? b / total : 0.5;
}

/** Buyers lead at 55% or more, sellers at 45% or less; in between is balanced. */
export function pressureVerdict(share: number, band = 0.05): PressureVerdict {
  if (share >= 0.5 + band) return "buyers";
  if (share <= 0.5 - band) return "sellers";
  return "balanced";
}

const VERDICT: Record<PressureVerdict, string> = { buyers: "Buyers lead", sellers: "Sellers lead", balanced: "Balanced" };
const count = new Intl.NumberFormat("en-US");

export interface BuySellPressureProps {
  windows: readonly PressureWindow[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (key: string) => void;
  /** `gauge` (half circle) or `bar` (split bar). */
  variant?: "gauge" | "bar";
  /** Share by number of trades (default) or by USD volume. */
  basis?: "count" | "volume";
  title?: string;
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

/** Buys against sells over a window: gauge or split bar, the counts, and who is leading in words. */
export function BuySellPressure({
  windows,
  value,
  defaultValue,
  onValueChange,
  variant = "gauge",
  basis = "count",
  title = "Buy and sell pressure",
  headingLevel = 3,
  className,
}: BuySellPressureProps) {
  const id = useId();
  const [internal, setInternal] = useState(defaultValue ?? windows[0]?.key ?? "");
  const current = value ?? internal;
  const w = windows.find((x) => x.key === current) ?? windows[0];
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  if (!w) return null;
  const share = buyShare(w, basis);
  const buyPct = Math.round(share * 100);
  const sellPct = 100 - buyPct;
  const verdict = pressureVerdict(share);
  const windowName = w.label ?? w.key;
  const spoken = `Last ${windowName}: ${buyPct}% buys, ${sellPct}% sells ${basis === "volume" ? "by volume" : "by trades"}. ${count.format(w.buys)} buys, ${count.format(w.sells)} sells. ${VERDICT[verdict]}.`;

  return (
    <section data-slot="buy-sell-pressure" data-verdict={verdict} aria-labelledby={`${id}-title`} className={cn("@container flex flex-col gap-4 rounded-2xl border border-line bg-card p-4 @md:p-5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Heading id={`${id}-title`} className="m-0 font-sans text-base font-semibold">
          {title}
        </Heading>
        {windows.length > 1 ? (
          <ToggleGroup
            type="single"
            value={w.key}
            onValueChange={(k) => {
              if (!k) return;
              if (value === undefined) setInternal(k);
              onValueChange?.(k);
            }}
            aria-label="Time window"
          >
            {windows.map((x) => (
              <ToggleGroupItem key={x.key} value={x.key} className="px-3.5">
                {x.label ?? x.key}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
      </div>

      <div className={cn("flex flex-col gap-4", variant === "gauge" && "@md:flex-row @md:items-center @md:gap-6")}>
        <div role="img" aria-label={spoken} className={cn(variant === "gauge" ? "mx-auto w-full max-w-[15rem] shrink-0 @md:mx-0" : "w-full")}>
          {variant === "gauge" ? <Gauge share={share} buyPct={buyPct} /> : <SplitBar buyPct={buyPct} />}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <p className={cn("m-0 text-sm font-semibold", verdict === "buyers" ? "text-gain" : verdict === "sellers" ? "text-loss" : "text-ink-soft")} aria-hidden="true">
            {verdict === "buyers" ? "▲ " : verdict === "sellers" ? "▼ " : "– "}
            {VERDICT[verdict]} over the last {windowName}
          </p>
          <dl className="m-0 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-line">
            <div className="flex flex-col gap-0.5 bg-paper px-3 py-2.5">
              <dt className="text-xs text-ink-muted">
                <span aria-hidden="true" className="text-gain">▲ </span>Buys
              </dt>
              <dd className="m-0">
                <span className="num font-semibold text-ink">{count.format(w.buys)}</span>{" "}
                <span className="num text-xs text-gain">{buyPct}%</span>
              </dd>
              {w.buyVolumeUsd !== undefined ? <dd className="num m-0 text-xs text-ink-muted">{formatUsdCompact(w.buyVolumeUsd)}</dd> : null}
            </div>
            <div className="flex flex-col gap-0.5 bg-paper px-3 py-2.5 text-right">
              <dt className="text-xs text-ink-muted">
                Sells<span aria-hidden="true" className="text-loss"> ▼</span>
              </dt>
              <dd className="m-0">
                <span className="num text-xs text-loss">{sellPct}%</span> <span className="num font-semibold text-ink">{count.format(w.sells)}</span>
              </dd>
              {w.sellVolumeUsd !== undefined ? <dd className="num m-0 text-xs text-ink-muted">{formatUsdCompact(w.sellVolumeUsd)}</dd> : null}
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}

function SplitBar({ buyPct }: { buyPct: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div aria-hidden="true" className="flex justify-between text-xs font-semibold">
        <span className="text-gain">▲ Buys {buyPct}%</span>
        <span className="text-loss">Sells {100 - buyPct}% ▼</span>
      </div>
      <div aria-hidden="true" className="relative flex h-3 gap-[3px]">
        <span className="rounded-full bg-gain transition-[flex-basis] duration-500" style={{ flexBasis: `${buyPct}%` }} />
        <span className="flex-1 rounded-full bg-loss" />
        <span className="absolute -inset-y-1 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-ink" />
      </div>
    </div>
  );
}

/** Half circle: buys fill from the left, sells take the rest; a marker sits where they meet. */
function Gauge({ share, buyPct }: { share: number; buyPct: number }) {
  // Arc from (10,60) to (110,60) around (60,60), radius 50; pathLength 100 makes the dash a percentage.
  const arc = "M10 60 A50 50 0 0 1 110 60";
  const angle = Math.PI * (1 - share);
  const mx = 60 + 50 * Math.cos(angle);
  const my = 60 - 50 * Math.sin(angle);
  return (
    <svg aria-hidden="true" viewBox="0 0 120 76" className="block w-full overflow-visible">
      <path d={arc} pathLength={100} fill="none" stroke="var(--loss)" strokeWidth={10} strokeLinecap="round" />
      <path
        d={arc}
        pathLength={100}
        fill="none"
        stroke="var(--gain)"
        strokeWidth={10}
        strokeLinecap="round"
        strokeDasharray={`${Math.max(0.01, share * 100)} 100`}
        className="transition-[stroke-dasharray] duration-700 ease-out"
      />
      <circle cx={mx} cy={my} r={6.5} fill="var(--card)" stroke="var(--ink)" strokeWidth={2} />
      <text x={60} y={50} textAnchor="middle" className="fill-ink font-mono text-[18px] font-semibold">
        {buyPct}%
      </text>
      <text x={60} y={62} textAnchor="middle" className="fill-ink-muted text-[8px]">
        buys
      </text>
      <text x={10} y={75} textAnchor="middle" className="fill-ink-muted text-[7.5px]">
        ▲ Buys
      </text>
      <text x={110} y={75} textAnchor="middle" className="fill-ink-muted text-[7.5px]">
        Sells ▼
      </text>
    </svg>
  );
}
