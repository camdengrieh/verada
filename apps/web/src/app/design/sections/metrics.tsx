"use client";

import { Coins, HandHeart, User } from "@varada/ui/components/ui/icons";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@varada/ui/components/ui/button";
import { BuySellPressure, type PressureWindow } from "@varada/ui/components/varada/buy-sell-pressure";
import { HolderDistribution, holderSegments } from "@varada/ui/components/varada/holder-distribution";
import { KpiTile, type KpiPeriod } from "@varada/ui/components/varada/kpi-tile";
import { PairChip } from "@varada/ui/components/varada/pair-chip";
import { TradingMetricsBar, tradingMetrics, type TradingMetricsInput } from "@varada/ui/components/varada/trading-metrics-bar";
import { VolumeBars, type VolumeBar } from "@varada/ui/components/varada/volume-bars";
import { siteBase } from "@/lib/base";
import { GallerySection } from "../section";
import { Demo, Frame, useQuoteLogo } from "./markets";

/* ---------- sample data (not live) ---------- */

const BASE_METRICS: TradingMetricsInput = {
  priceUsd: 0.00004213,
  change24h: 18.4,
  marketCapUsd: 4_213_000,
  marketCapChange: 18.4,
  volume24hUsd: 1_284_000,
  volumeChange: -6.2,
  liquidityUsd: 612_000,
  liquidityChange: 2.3,
  holders: 3_402,
  holdersChange: 4.1,
  feesToCausesUsd: 28_410,
  feesChange: 12.0,
};

/** Deterministic pseudo-random walk, so server and client draw the same bars. */
function walk(n: number, seed: number, start: number, spread: number): number[] {
  let x = seed;
  let v = start;
  return Array.from({ length: n }, () => {
    x = (x * 9301 + 49297) % 233280;
    v = Math.max(start * 0.3, v + (x / 233280 - 0.45) * spread);
    return Math.round(v);
  });
}

const HOURS: VolumeBar[] = walk(24, 7, 28_000, 16_000).map((value, h) => ({ label: `${String(h).padStart(2, "0")}:00`, value: h === 15 ? 118_400 : value }));
const DAYS: VolumeBar[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label, i) => ({ label, value: [820_000, 1_140_000, 960_000, 1_510_000, 1_284_000, 640_000, 590_000][i]! }));

const WINDOWS: PressureWindow[] = [
  { key: "1h", buys: 412, sells: 251, buyVolumeUsd: 48_200, sellVolumeUsd: 30_100 },
  { key: "24h", buys: 3_120, sells: 3_410, buyVolumeUsd: 610_000, sellVolumeUsd: 674_000 },
];
const SELL_OFF: PressureWindow[] = [
  { key: "1h", buys: 96, sells: 288 },
  { key: "24h", buys: 1_840, sells: 2_910 },
];

const VOLUME_KPI: KpiPeriod[] = [
  { key: "24h", value: 1_284_000, delta: -6.2, trend: walk(24, 3, 40_000, 20_000), deltaSuffix: "vs prior 24h" },
  { key: "7d", value: 6_944_000, delta: 22.5, trend: DAYS.map((d) => d.value), deltaSuffix: "vs prior 7d" },
  { key: "30d", value: 21_300_000, delta: 140, trend: walk(30, 11, 300_000, 260_000), deltaSuffix: "since launch" },
];
const HOLDER_KPI: KpiPeriod[] = [
  { key: "24h", value: 3_402, delta: 4.1, trend: [3270, 3290, 3301, 3330, 3352, 3360, 3381, 3402] },
  { key: "7d", value: 3_402, delta: 31.8, trend: [2580, 2700, 2840, 2990, 3120, 3260, 3402] },
];
const FEES_KPI: KpiPeriod[] = [
  { key: "24h", value: 2_140, delta: 12, trend: walk(24, 5, 80, 60) },
  { key: "7d", value: 11_820, delta: 9.4, trend: [1200, 1420, 1610, 1880, 1950, 1700, 2060] },
  { key: "All", value: 28_410, trend: [0, 2100, 5200, 9800, 14_900, 21_000, 28_410], deltaSuffix: "since launch" },
];

const COMPACT_USD: Intl.NumberFormatOptions = { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 };

/** Nudges the sample numbers every few seconds while on, so the tickers can be seen springing. */
function useLiveMetrics(on: boolean): TradingMetricsInput {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setTick((n) => n + 1), 2_500);
    return () => clearInterval(t);
  }, [on]);
  return useMemo(() => {
    if (tick === 0) return BASE_METRICS;
    const k = 1 + Math.sin(tick * 1.7) * 0.03;
    return {
      ...BASE_METRICS,
      priceUsd: BASE_METRICS.priceUsd! * k,
      marketCapUsd: Math.round(BASE_METRICS.marketCapUsd! * k),
      volume24hUsd: BASE_METRICS.volume24hUsd! + tick * 4_200,
      holders: BASE_METRICS.holders! + tick * 3,
      feesToCausesUsd: BASE_METRICS.feesToCausesUsd! + tick * 38,
      change24h: Number((BASE_METRICS.change24h! + (k - 1) * 100).toFixed(2)),
    };
  }, [tick]);
}

export function MetricsSection() {
  const [live, setLive] = useState(false);
  const metrics = tradingMetrics(useLiveMetrics(live));
  const logo = useQuoteLogo(48);
  const [base, setBase] = useState("../");
  useEffect(() => setBase(siteBase()), []);
  const coin = { src: `${base}assets/cutouts/gorilla-mog-320.webp` };

  return (
    <GallerySection
      id="metrics"
      title="Trading metrics"
      intro="The numbers on a coin page: price and its 24h move, market cap, volume, liquidity, holders and the fees already sent to causes, plus who holds the supply, whether buyers or sellers lead, and when the volume came in. Every block lays out by its own width (container queries), so it works in a 360px sidebar and a full-width header alike. Sample data, not live."
    >
      <Demo
        label="Metrics bar, full width"
        source="21st.dev @kuratlielia/stats-band (id 35089) · NumberTicker · Delta"
        note="One ruled row when wide; hairline dividers between metrics. Turn on live updates to watch the tickers spring between values."
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PairChip coinSymbol="MOG" coinImage={coin} quoteSymbol="WETH" quoteKind="crypto" quoteLogo={logo("WETH")} />
          <Button variant="outline" size="sm" aria-pressed={live} onClick={() => setLive((v) => !v)}>
            {live ? "Stop live updates" : "Start live updates"}
          </Button>
        </div>
        <Frame label="Wide (drag the corner to resize)" resizable>
          <TradingMetricsBar metrics={metrics} />
        </Frame>
      </Demo>

      <div className="grid gap-4 lg:grid-cols-2">
        <Demo label="Metrics bar, narrow grid" note="Two columns, price across the top.">
          <Frame label="360px" width="360px">
            <TradingMetricsBar metrics={metrics} />
          </Frame>
        </Demo>
        <Demo label="Metrics bar, narrow scroll strip" note="One row that scrolls sideways (focusable, so arrow keys scroll it).">
          <Frame label="360px" width="360px">
            <TradingMetricsBar metrics={metrics} narrow="scroll" />
          </Frame>
        </Demo>
      </div>

      <Demo label="KPI tiles with a period switch" source="21st.dev @mirukullacode/tweenly-chart-kpi (id 39900) · Sparkline" note="The sparkline sits beside the number once a tile is 24rem wide, under it when narrower.">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <KpiTile label="Volume" icon={<Coins />} periods={VOLUME_KPI} format={COMPACT_USD} />
          <KpiTile label="Holders" icon={<User />} periods={HOLDER_KPI} format={{ maximumFractionDigits: 0 }} />
          <KpiTile label="Fees to causes" icon={<HandHeart />} periods={FEES_KPI} format={COMPACT_USD} tone="cause" hint="90% of trading fees, converted to USDC and sent through Endaoment." />
        </div>
        <div className="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
          <Frame label="260px">
            <KpiTile label="Volume" periods={VOLUME_KPI} format={COMPACT_USD} defaultValue="7d" />
          </Frame>
          <Frame label="Wide">
            <KpiTile label="Volume" periods={VOLUME_KPI} format={COMPACT_USD} defaultValue="30d" />
          </Frame>
        </div>
      </Demo>

      <Demo label="Holder distribution" source="21st.dev @8starlabs/partition-bar (id 26545) · Tooltip" note="Hover a segment for what it means; the legend says the same in words. Concentration is flagged in a note, not just in colour.">
        <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <Frame label="360px" width="360px">
            <HolderDistribution segments={holderSegments({ pool: 38.2, top10: 24.1, creator: 3.0, otherHolders: 3_391 })} totalHolders={3_402} />
          </Frame>
          <Frame label="Wide">
            <HolderDistribution segments={holderSegments({ pool: 38.2, top10: 24.1, creator: 3.0, otherHolders: 3_391 })} totalHolders={3_402} />
          </Frame>
        </div>
        <Frame label="Concentrated supply">
          <HolderDistribution title="Holder distribution, early coin" segments={holderSegments({ pool: 21.5, top10: 56.3, creator: 12.4, otherHolders: 148 })} totalHolders={160} />
        </Frame>
      </Demo>

      <Demo label="Buy and sell pressure" source="21st.dev @designali-in/gauge (id 1757)" note="Share of trades that were buys, over 1h or 24h. Direction is written out (▲ Buyers lead / ▼ Sellers lead), not left to green and red.">
        <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <Frame label="360px, gauge" width="360px">
            <BuySellPressure windows={WINDOWS} />
          </Frame>
          <Frame label="Wide, gauge beside the counts">
            <BuySellPressure windows={WINDOWS} />
          </Frame>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Frame label="Split bar, by volume">
            <BuySellPressure windows={WINDOWS} variant="bar" basis="volume" />
          </Frame>
          <Frame label="Sellers leading">
            <BuySellPressure windows={SELL_OFF} variant="bar" />
          </Frame>
        </div>
      </Demo>

      <Demo label="Volume by hour" source="21st.dev @kevingirelli/bar-chart (id 35239)" note="The peak is labelled in words. Hover, or focus the chart and use the arrow keys, to read any hour; axis labels thin out in narrow containers.">
        <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <Frame label="360px" width="360px">
            <VolumeBars data={HOURS} />
          </Frame>
          <Frame label="Wide">
            <VolumeBars data={HOURS} height={160} />
          </Frame>
        </div>
        <Frame label="By day, no peak marker">
          <VolumeBars title="Volume by day" data={DAYS} highlight="none" caption={null} />
        </Frame>
      </Demo>
    </GallerySection>
  );
}
