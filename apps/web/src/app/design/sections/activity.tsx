"use client";

import { useEffect, useState } from "react";
import { Badge } from "@verada/ui/components/ui/badge";
import { Button } from "@verada/ui/components/ui/button";
import { usePrefersReducedMotion } from "@verada/ui/components/motion/marquee";
import { HolderDistribution, holderSegments } from "@verada/ui/components/varada/holder-distribution";
import { HolderInsights, type HolderBucket, type HolderInsightsProps } from "@verada/ui/components/varada/holder-insights";
import { HoldersTable, type HolderItem } from "@verada/ui/components/varada/holders-table";
import { TradeFeed, TradeTicker, type TradeItem } from "@verada/ui/components/varada/trade-feed";
import { GallerySection } from "../section";
import { Demo, Frame } from "./markets";

/* ---------- sample data (not live) ---------- */

/** $HARAMBE, paired with NVDAon (the same numbers as the trade sheet and metrics boards). */
export const HARAMBE_PRICE_USD = 0.00000412;
export const NVDAON_PRICE_USD = 129.48;
/** 2.5% trading fee, 90% of it to the cause. */
const CAUSE_RATE = 0.025 * 0.9;
const SUPPLY = 1_000_000_000_000;

/** Visibly synthetic addresses: four hex digits, zeros, four more. */
function sampleAddress(seed: number): `0x${string}` {
  const a = ((seed * 7919) % 0xffff).toString(16).padStart(4, "0");
  const b = ((seed * 104_729) % 0xffff).toString(16).padStart(4, "0");
  return `0x${a}${"0".repeat(32)}${b}`;
}
function sampleHash(seed: number): `0x${string}` {
  return `0x${sampleAddress(seed).slice(2)}${"0".repeat(24)}`;
}

const NAMES = ["silverback.eth", "gorillagrove.eth", "banana.fund", undefined, undefined, "junglegym.eth", undefined];

/** Deterministic, so the server and the client draw the same rows. */
function rng(seed: number) {
  let x = seed;
  return () => {
    x = (x * 9301 + 49297) % 233_280;
    return x / 233_280;
  };
}

export function sampleTrade(n: number, timestamp: number): TradeItem {
  const r = rng(n + 11);
  r();
  const side = r() < 0.58 ? "buy" : "sell";
  // Mostly small tickets, now and then a whale; n === 0 is the $1,249 reference trade.
  const usd = n === 0 ? 1_249.48 : Math.round((r() < 0.12 ? 1_500 + r() * 6_000 : 20 + r() * 700) * 100) / 100;
  const quoteAmount = usd / NVDAON_PRICE_USD;
  const trader = n % 7;
  return {
    id: `s${n}`,
    side,
    trader: { address: sampleAddress(trader + 3), ens: NAMES[trader] },
    tokenAmount: usd / HARAMBE_PRICE_USD,
    tokenSymbol: "$HARAMBE",
    quoteAmount,
    quoteSymbol: "NVDAon",
    usd,
    causeUsd: Math.round(usd * CAUSE_RATE * 100) / 100,
    timestamp,
    txHash: sampleHash(n + 101),
  };
}

/** The first rows, spaced back from `now` (seconds). */
export function sampleTrades(now: number, count = 14): TradeItem[] {
  return Array.from({ length: count }, (_, i) => sampleTrade(i, now - 6 - i * 47));
}

/** Adds a sample trade every few seconds while on (never under reduced motion). */
export function useSampleStream(on: boolean, count = 14, cap = 40): TradeItem[] {
  const [trades, setTrades] = useState<TradeItem[]>(() => sampleTrades(Math.floor(Date.now() / 1000), count));
  useEffect(() => {
    if (!on) return;
    let n = count;
    const t = setInterval(() => {
      n += 1;
      setTrades((prev) => [sampleTrade(n, Math.floor(Date.now() / 1000)), ...prev].slice(0, cap));
    }, 2_600);
    return () => clearInterval(t);
  }, [on, count, cap]);
  return trades;
}

const holder = (seed: number, share: number, over: Partial<HolderItem> = {}): HolderItem => ({
  address: sampleAddress(seed),
  balance: (share / 100) * SUPPLY,
  share,
  usd: (share / 100) * SUPPLY * HARAMBE_PRICE_USD,
  ...over,
});

/** Pool 38.2%, top 10 wallets 24.1%, creator 3.0%: the metrics board's split. */
export const SAMPLE_HOLDERS: HolderItem[] = [
  holder(1, 38.2, { label: "pool", address: "0x000000000004444c5dc75cB358380D2e3dE08A90", change24h: -0.42 }),
  holder(3, 4.2, { ens: "silverback.eth", change24h: 0.31 }),
  holder(4, 3.6, { ens: "gorillagrove.eth", change24h: 0.12 }),
  holder(5, 3.1, { change24h: -0.08 }),
  holder(2, 3.0, { label: "creator", ens: "harambe.varada.eth" }),
  holder(6, 2.8, { ens: "banana.fund", change24h: 0.44 }),
  holder(7, 2.4),
  holder(8, 2.2, { ens: "junglegym.eth", change24h: -0.21 }),
  holder(9, 1.9, { change24h: 0.05 }),
  holder(10, 1.6),
  holder(11, 1.3, { change24h: 0.18 }),
  holder(12, 1.2, { label: "burn", address: "0x000000000000000000000000000000000000dEaD" }),
  holder(13, 1.0, { change24h: -0.02 }),
  holder(14, 0.8, { label: "vault" }),
  holder(15, 0.7),
  holder(16, 0.6, { change24h: 0.09 }),
  holder(17, 0.4, { label: "agent", ens: "wildlife.agent.varada.eth" }),
  holder(18, 0.35),
  holder(19, 0.3, { change24h: -0.04 }),
];

const BUCKETS: HolderBucket[] = [
  { label: "Under $100", holders: 2_110, share: 3.1 },
  { label: "$100–1K", holders: 940, share: 9.4 },
  { label: "$1K–10K", holders: 300, share: 18.2 },
  { label: "Over $10K", holders: 52, share: 31.1 },
];

export const SAMPLE_INSIGHTS: HolderInsightsProps = {
  holders: 3_402,
  newHolders24h: 132,
  top10Share: 24.1,
  creatorShare: 3.0,
  poolShare: 38.2,
  buckets: BUCKETS,
  history: [2_580, 2_700, 2_840, 2_990, 3_120, 3_260, 3_402],
};

const EARLY_INSIGHTS: HolderInsightsProps = {
  holders: 160,
  newHolders24h: 41,
  top10Share: 56.3,
  creatorShare: 12.4,
  poolShare: 21.5,
  buckets: [
    { label: "Under $100", holders: 98, share: 1.2 },
    { label: "$100–1K", holders: 41, share: 4.6 },
    { label: "$1K–10K", holders: 17, share: 22.0 },
    { label: "Over $10K", holders: 4, share: 50.7 },
  ],
  history: [12, 40, 88, 119, 160],
};

/* ---------- section ---------- */

export function ActivitySection() {
  const reduced = usePrefersReducedMotion();
  const [live, setLive] = useState(true);
  const streaming = live && !reduced;
  const trades = useSampleStream(streaming);

  return (
    <GallerySection
      id="activity"
      title="Trades & holders"
      intro="What a coin page shows below the chart: the live trade tape and who holds the supply. Every block lays out by its own width. The tape adds a sample trade every few seconds (not under reduced motion); point at it or tab into it and it holds still, with a pill for what arrived. Sample data, not live."
    >
      <Demo
        label="Live trade feed"
        source="21st.dev @ssychui/trade-journal-table (id 27124) · @kevingirelli/marquee (id 35200) · EnsAddress"
        note="Side is written out with an arrow, not left to green and red. Each row links to its transaction; the cause chip is the 90% fee share of that trade. Screen readers hear a short summary of new trades every few seconds at most."
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Badge tone="live" shape="pill" dot>
            {streaming ? "Streaming sample trades" : reduced ? "Paused: reduced motion" : "Paused"}
          </Badge>
          <Button variant="outline" size="sm" aria-pressed={live} disabled={!!reduced} onClick={() => setLive((v) => !v)}>
            {live ? "Pause the stream" : "Resume the stream"}
          </Button>
        </div>
        <TradeTicker trades={trades} />
        <Frame label="Wide (drag the corner to resize)" resizable>
          <TradeFeed trades={trades} action={<Badge tone="live" shape="pill" dot>Live</Badge>} />
        </Frame>
      </Demo>

      <div className="grid gap-4 xl:grid-cols-2">
        <Demo label="Trade feed, 360px" note="Three short lines per trade: side, amount and value; time and what was paid; trader and transaction.">
          <Frame label="360px" width="360px">
            <TradeFeed trades={trades} maxRows={6} title="Latest trades" />
          </Frame>
        </Demo>
        <Demo label="Loading and empty" note="Skeleton rows while the first page loads; a plain sentence when there is nothing to show, including for a filter.">
          <Frame label="Loading">
            <TradeFeed trades={[]} loading hideFilters />
          </Frame>
          <Frame label="New coin, no trades">
            <TradeFeed trades={[]} />
          </Frame>
          <Frame label="Large tab, none yet">
            <TradeFeed trades={trades.slice(0, 3).map((t) => ({ ...t, usd: 80 }))} defaultFilter="large" largeUsd={5_000} />
          </Frame>
        </Demo>
      </div>

      <Demo
        label="Top holders"
        source="21st.dev @dhxwhy/bar-race-chart (id 37544) · Switch · EnsAddress"
        note="Tags name the contracts (pool, burn address, cause vault, curator agent). Hide them and the rows slide to their new rank; shares stay as a share of the whole supply. Under 32rem the share bar folds under the name."
      >
        <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <Frame label="360px" width="360px">
            <HoldersTable holders={SAMPLE_HOLDERS} symbol="$HARAMBE" totalHolders={3_402} initialRows={6} defaultHideContracts />
          </Frame>
          <Frame label="Wide">
            <HoldersTable holders={SAMPLE_HOLDERS} symbol="$HARAMBE" totalHolders={3_402} />
          </Frame>
        </div>
      </Demo>

      <Demo
        label="Holder insights"
        source="21st.dev @sean0205/c-chart-3 (id 30675) · Sparkline · InfoTip"
        note="The verdict uses the thresholds HolderDistribution warns at (top 10 at 50%, creator at 10%); they are spelled out in its tooltip. Paired bars compare how many wallets are in each holding size with how much of the supply they hold."
      >
        <div className="grid gap-4 xl:grid-cols-2">
          <Frame label="$HARAMBE, spread out">
            <HolderInsights {...SAMPLE_INSIGHTS} />
          </Frame>
          <Frame label="Early coin, concentrated">
            <HolderInsights {...EARLY_INSIGHTS} title="Holder insights, early coin" />
          </Frame>
        </div>
        <Frame label="With the distribution bar">
          <div className="grid gap-4 lg:grid-cols-2">
            <HolderDistribution segments={holderSegments({ pool: 38.2, top10: 24.1, creator: 3.0, otherHolders: 3_391 })} totalHolders={3_402} />
            <HolderInsights {...SAMPLE_INSIGHTS} buckets={[]} history={undefined} title="In words" />
          </div>
        </Frame>
      </Demo>
    </GallerySection>
  );
}
