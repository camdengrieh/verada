"use client";

import { useEffect, useMemo, useState } from "react";
import { PriceChart, ChartTimeframes } from "@varada/ui/components/data/price-chart";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { Button } from "@varada/ui/components/ui/button";
import { BuySellPressure } from "@varada/ui/components/varada/buy-sell-pressure";
import { TradingMetricsBar, type TradingMetric } from "@varada/ui/components/varada/trading-metrics-bar";
import { VolumeBars } from "@varada/ui/components/varada/volume-bars";
import { HandHeart } from "@varada/ui/components/ui/icons";
import type { HolderSummary, MarketSnapshot, MarketTrade } from "@/lib/indexer";
import type { QuoteInfo } from "@/lib/quote-info";
import { candlesFromHours, formatQuotePrice, HOUR, marketStats, percentChange, pressureWindows, quoteNumberFormat, RANGE_HOURS, RANGES, toUnits, tradePoints, TOKEN_DECIMALS, volumeBars, type Range } from "@/lib/token-market";
import { usdcToUsd } from "@/lib/token-data";
import type { TokenFeeTotals } from "@/lib/indexer";

/** Seconds since the epoch, refreshed on an interval so ranges and 24h windows keep moving. */
export function useNowSec(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

const COMPACT: Intl.NumberFormatOptions = { notation: "compact", maximumFractionDigits: 2 };
const USD_COMPACT: Intl.NumberFormatOptions = { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 };

/** Everything derived from the market snapshot that the header and the metrics bar share. */
export function useMarketFigures(market: MarketSnapshot | null | undefined, token: string, summary: HolderSummary | null | undefined, nowSec: number) {
  return useMemo(() => {
    if (!market) return null;
    const stats = marketStats(market, token, nowSec);
    const supply = summary ? toUnits(summary.supply, TOKEN_DECIMALS) : null;
    const marketCap = stats.price !== null && supply !== null ? stats.price * supply : null;
    return { stats, supply, marketCap };
  }, [market, token, summary, nowSec]);
}

export function metricList(opts: {
  quote: QuoteInfo | null;
  figures: ReturnType<typeof useMarketFigures>;
  summary: HolderSummary | null | undefined;
  feeTotals: TokenFeeTotals | null | undefined;
}): TradingMetric[] {
  const { quote, figures, summary, feeTotals } = opts;
  const sym = quote?.symbol ?? "";
  const usd = Boolean(quote?.usd);
  const unit = (n: number, compact: boolean): Intl.NumberFormatOptions => (usd ? (compact ? USD_COMPACT : { style: "currency", currency: "USD", ...quoteNumberFormat(n) }) : compact ? COMPACT : quoteNumberFormat(n));
  const suffix = (label: string) => (usd || !sym ? label : `${label} (${sym})`);
  const out: TradingMetric[] = [];
  const s = figures?.stats;
  if (s) {
    out.push({
      key: "price",
      label: suffix("Price"),
      value: s.price,
      format: s.price !== null ? unit(s.price, false) : undefined,
      delta: s.change24h ?? undefined,
      deltaPeriod: s.changeSince,
      lead: true,
    });
    out.push({ key: "mcap", label: suffix("Market cap"), value: figures.marketCap, format: unit(figures.marketCap ?? 1, true) });
    out.push({
      key: "volume",
      label: suffix("Volume 24h"),
      value: s.volume24h,
      format: unit(s.volume24h || 1, true),
      delta: percentChange(s.volume24h, s.volumePrior24h),
      deltaPeriod: "vs prior 24h",
      hint: `${s.trades24h} trade${s.trades24h === 1 ? "" : "s"}`,
    });
  }
  if (summary) {
    const before = summary.holders - summary.newHolders24h;
    out.push({ key: "holders", label: "Holders", value: summary.holders, format: { maximumFractionDigits: 0 }, delta: summary.newHolders24h > 0 && before > 0 ? (summary.newHolders24h / before) * 100 : undefined, deltaPeriod: "24h", hint: summary.newHolders24h > 0 ? `+${summary.newHolders24h} new in 24h` : undefined });
  }
  if (feeTotals) {
    out.push({
      key: "fees",
      label: "Fees to causes",
      value: usdcToUsd(BigInt(feeTotals.causeAmount)),
      format: USD_COMPACT,
      tone: "cause",
      icon: <HandHeart />,
      hint: "90% of fees, paid in USDC",
    });
  }
  return out;
}

export function MarketSkeleton() {
  return (
    <div role="status" aria-label="Loading market" className="flex flex-col gap-4">
      <Skeleton className="h-24 w-full rounded-2xl" />
      <Skeleton className="h-[340px] w-full rounded-2xl" />
    </div>
  );
}

export interface MarketSectionProps {
  address: string;
  symbol: string;
  quote: QuoteInfo | null;
  market: MarketSnapshot | null | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  summary: HolderSummary | null | undefined;
  feeTotals: TokenFeeTotals | null | undefined;
  /** Trades newest first, for the 1H line. */
  trades: readonly MarketTrade[];
  nowSec: number;
  onTrade?: () => void;
  /** Extra metrics (the pool's liquidity), when known. */
  extraMetrics?: TradingMetric[];
}

export function MarketSection({ address, symbol, quote, market, loading, error, onRetry, summary, feeTotals, trades, nowSec, onTrade, extraMetrics }: MarketSectionProps) {
  const [range, setRange] = useState<Range>("24H");
  const figures = useMarketFigures(market, address, summary, nowSec);
  const metrics = useMemo(() => {
    const list = metricList({ quote, figures, summary, feeTotals });
    if (extraMetrics?.length) list.splice(Math.min(3, list.length), 0, ...extraMetrics);
    return list;
  }, [quote, figures, summary, feeTotals, extraMetrics]);

  const candles = useMemo(() => (market && quote ? candlesFromHours(market, address, nowSec) : []), [market, quote, address, nowSec]);
  const shown = useMemo(() => {
    if (range === "1H") return [];
    const from = nowSec - (nowSec % HOUR) - (RANGE_HOURS[range] - 1) * HOUR;
    return candles.filter((c) => c.time >= from);
  }, [candles, range, nowSec]);
  const points = useMemo(() => (range === "1H" ? tradePoints(trades, nowSec) : []), [range, trades, nowSec]);
  const price = (n: number) => (quote?.usd ? n.toLocaleString("en-US", { style: "currency", currency: "USD", ...quoteNumberFormat(n) }) : formatQuotePrice(n, quote?.symbol ?? "").trim());

  if (loading) return <MarketSkeleton />;
  if (error && !market) {
    return (
      <div role="alert" className="rounded-2xl border border-line bg-card">
        <EmptyState size="compact" title="Market data is not available" body="The indexer could not be reached or has no market data for this pool. Prices and volume come from it." action={<Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>} />
      </div>
    );
  }
  const empty = !market || market.lifetime?.trades === 0 || (market.price === null && market.hourly.length === 0);
  if (empty) {
    return (
      <div className="flex flex-col gap-4">
        {metrics.length > 0 ? <TradingMetricsBar metrics={metrics} narrow="scroll" /> : null}
        <div className="rounded-2xl border border-line bg-card">
          <EmptyState
            title={`No trades in ${symbol} yet`}
            body="The chart starts with the first swap, and so does the giving: 90% of every trading fee goes to the token's cause."
            action={onTrade ? <Button onClick={onTrade}>Make the first trade</Button> : undefined}
          />
        </div>
      </div>
    );
  }

  const stats = figures?.stats;
  const direction = stats?.change24h === null || stats?.change24h === undefined ? "" : stats.change24h >= 0 ? `, up ${stats.change24h.toFixed(1)}%` : `, down ${Math.abs(stats.change24h).toFixed(1)}%`;
  const label = `${symbol} price in ${quote?.symbol ?? "the quote asset"}, ${range === "1H" ? "last hour, per trade" : range === "24H" ? "last 24 hours" : "last 7 days"}${direction}`;
  const noPoints = range === "1H" && points.length === 0;
  const barRange: "24H" | "7D" = range === "7D" ? "7D" : "24H";
  const bars = volumeBars(market.hourly, market.quoteDecimals, nowSec, barRange);
  const unitName = quote?.symbol ?? "";
  const qFormat = (n: number) => (n >= 1000 ? n.toLocaleString("en-US", COMPACT) : n.toLocaleString("en-US", quoteNumberFormat(n)));

  return (
    <div className="flex flex-col gap-4">
      <TradingMetricsBar metrics={metrics} narrow="scroll" />
      <div className="rounded-2xl border border-line bg-card p-3 sm:p-4">
        {noPoints ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <span className="num text-sm font-semibold text-ink">{symbol}</span>
              <ChartTimeframes options={[...RANGES]} value={range} onChange={(v) => setRange(v as Range)} />
            </div>
            <EmptyState size="compact" title="No trades in the last hour" body="The 1H chart draws every swap of the last hour. Pick 24H or 7D to see the hourly candles." />
          </div>
        ) : (
          <PriceChart
            kind={range === "1H" ? "area" : "candles"}
            candles={shown}
            points={points}
            label={label}
            height={320}
            formatPrice={price}
            toolbar={
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-baseline gap-2">
                  <span className="num text-sm font-semibold text-ink">{symbol}</span>
                  {quote ? <span className="text-xs text-ink-muted">in {unitName}</span> : null}
                </div>
                <ChartTimeframes options={[...RANGES]} value={range} onChange={(v) => setRange(v as Range)} />
              </div>
            }
          />
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <BuySellPressure windows={pressureWindows(market.hourly, market.quoteDecimals, nowSec, Boolean(quote?.usd))} defaultValue="24h" basis="count" title="Buy and sell pressure" headingLevel={2} />
        <VolumeBars data={bars} title={barRange === "24H" ? `Volume by hour (${unitName}, UTC)` : `Volume by day (${unitName}, UTC)`} headingLevel={2} format={qFormat} height={120} />
      </div>
    </div>
  );
}
