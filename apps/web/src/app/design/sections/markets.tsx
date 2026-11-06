"use client";

import { useEffect, useState } from "react";
import { Button } from "@verada/ui/components/ui/button";
import { LiquidityMeter } from "@verada/ui/components/varada/liquidity-meter";
import { MarketStatus } from "@verada/ui/components/varada/market-status";
import { PriceImpactLadder, type ImpactStep } from "@verada/ui/components/varada/price-impact-ladder";
import { StockMarketCard, type OndoAsset } from "@verada/ui/components/varada/stock-market-card";
import { StockMarketList } from "@verada/ui/components/varada/stock-market-list";
import { GallerySection, Specimen } from "../section";

/* ---------- sample data (not live) ---------- */

/** NYSE / Nasdaq full-day closures and early closes for 2026. */
const HOLIDAYS_2026 = ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"];
const EARLY_CLOSES_2026 = ["2026-11-27", "2026-12-24"];

/** Fixed clocks so the server and the browser render the same thing. */
const CLOCK = {
  open: new Date("2026-11-10T16:05:00Z"), // Tue 11:05 ET
  pre: new Date("2026-11-10T12:40:00Z"), // Tue 07:40 ET
  after: new Date("2026-11-10T22:15:00Z"), // Tue 17:15 ET
  overnight: new Date("2026-11-11T03:00:00Z"), // Tue 22:00 ET
  weekend: new Date("2026-11-07T17:00:00Z"), // Sat 12:00 ET
  holiday: new Date("2026-11-26T15:00:00Z"), // Thanksgiving
  earlyClose: new Date("2026-11-27T18:20:00Z"), // Fri 13:20 ET, early close at 13:00
};

const SIZES = [100, 1_000, 10_000, 50_000];

/** Rough constant-product impact for a route of `depth` USD; null where the route can't fill the size. */
function ladder(depth: number): ImpactStep[] {
  return SIZES.map((size) => ({ size, impact: depth > 0 && size < depth / 2 ? Number(((100 * size) / (depth / 2 + size)).toFixed(2)) : null }));
}

function asset(
  symbol: string,
  name: string,
  kind: OndoAsset["kind"],
  price: number,
  change24h: number,
  depth: number,
  coinsPaired: number,
  extra: Partial<OndoAsset> = {},
): OndoAsset {
  const viaWeth = depth > 0 && depth < 60_000;
  return {
    symbol,
    name,
    kind,
    price,
    change24h,
    routeDepthUsd: depth,
    poolLiquidityUsd: depth ? Math.round(depth * 1.08) : 0,
    reserves: depth ? { base: { symbol, usd: Math.round(depth * 0.54) }, quote: { symbol: viaWeth ? "WETH" : "USDC", usd: Math.round(depth * 0.54 * 0.92) } } : undefined,
    route: depth ? (viaWeth ? [symbol, "WETH", "USDC"] : [symbol, "USDC"]) : [],
    impact: ladder(depth),
    coinsPaired,
    ...extra,
  };
}

const ASSETS: OndoAsset[] = [
  asset("NVDAon", "NVIDIA", "stock", 129.48, 2.14, 1_240_000, 14),
  asset("AAPLon", "Apple", "stock", 227.63, 0.82, 640_000, 9),
  asset("MSFTon", "Microsoft", "stock", 418.2, -0.41, 520_000, 6),
  asset("GOOGLon", "Alphabet Class A", "stock", 176.94, 1.37, 210_000, 4),
  asset("METAon", "Meta Platforms", "stock", 589.1, -1.92, 96_000, 3),
  asset("COINon", "Coinbase Global", "stock", 262.35, 6.48, 74_000, 5, { paused: true }),
  asset("NFLXon", "Netflix", "stock", 752.6, 0.05, 41_000, 1),
  asset("TSLAon", "Tesla", "stock", 248.5, -3.36, 880_000, 11),
  asset("AMZNon", "Amazon.com", "stock", 201.7, 0.94, 330_000, 5),
  asset("MSTRon", "Strategy", "stock", 341.2, 8.71, 0, 0),
  asset("AMDon", "Advanced Micro Devices", "stock", 152.1, 0.38, 0, 0),
  asset("PLTRon", "Palantir Technologies", "stock", 41.2, 5.62, 4_100, 1),
  asset("SPYon", "SPDR S&P 500 ETF Trust", "etf", 571.3, 0.61, 1_720_000, 12),
  asset("QQQon", "Invesco QQQ Trust", "etf", 492.8, 0.88, 930_000, 7),
  asset("IWMon", "iShares Russell 2000 ETF", "etf", 221.4, -0.73, 8_600, 0),
  asset("GLDon", "SPDR Gold Shares", "etf", 241.8, -0.21, 56_000, 2),
];

const bySymbol = (s: string) => ASSETS.find((a) => a.symbol === s)!;

const LOGO_NOTE = "Lettered StockLogo fallback: the stocks logo pack isn't published in the gallery";

function useTickingNow(): Date {
  const [now, setNow] = useState<Date>(CLOCK.open);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function LiveStatus() {
  const now = useTickingNow();
  return <MarketStatus now={now} holidays={HOLIDAYS_2026} earlyCloses={EARLY_CLOSES_2026} />;
}

function PairStepDemo() {
  const [value, setValue] = useState<string | null>("NVDAon");
  const picked = value ? bySymbol(value) : null;
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <StockMarketList
        mode="select"
        title="Pair it with"
        headingLevel={3}
        assets={ASSETS}
        now={CLOCK.after}
        holidays={HOLIDAYS_2026}
        earlyCloses={EARLY_CLOSES_2026}
        value={value}
        onValueChange={setValue}
        groupLabel="Quote asset for your coin"
      />
      {picked ? <StockMarketCard asset={picked} now={CLOCK.after} holidays={HOLIDAYS_2026} coinSymbol="HARAMBE" headingLevel={4} /> : null}
    </div>
  );
}

export function MarketsSection() {
  return (
    <GallerySection
      id="markets"
      title="Ondo stocks and liquidity"
      intro="Ondo tokenized stocks and ETFs as quote assets: the US session (prices go stale outside 9:30 to 16:00 ET or when Ondo pauses a token), how deep each route to USDC is, what a trade size does to the price, and whether a coin can pair with it. Sample data, not live."
    >
      <Specimen label="Market status · every session" source="21st.dev @diceui/status (id 25395) · America/New_York via Intl">
        <div className="flex flex-wrap gap-2.5">
          <MarketStatus now={CLOCK.open} holidays={HOLIDAYS_2026} />
          <MarketStatus now={CLOCK.pre} holidays={HOLIDAYS_2026} />
          <MarketStatus now={CLOCK.after} holidays={HOLIDAYS_2026} />
          <MarketStatus now={CLOCK.overnight} holidays={HOLIDAYS_2026} />
          <MarketStatus now={CLOCK.weekend} holidays={HOLIDAYS_2026} />
          <MarketStatus now={CLOCK.holiday} holidays={HOLIDAYS_2026} earlyCloses={EARLY_CLOSES_2026} title="Thanksgiving: closed all day" />
          <MarketStatus now={CLOCK.earlyClose} holidays={HOLIDAYS_2026} earlyCloses={EARLY_CLOSES_2026} title="Early close at 13:00 ET" />
          <MarketStatus now={CLOCK.open} paused />
          <MarketStatus now={CLOCK.open} size="sm" showCountdown={false} />
        </div>
        <p className="text-[13px] text-muted-foreground">
          Open Tue 11:05 ET · pre-market 07:40 · after-hours 17:15 · overnight 22:00 · Saturday · Thanksgiving · day-after early close · paused by Ondo · compact
          table cell.
        </p>
      </Specimen>

      <div className="grid gap-4 md:grid-cols-2">
        <Specimen label="Market status · your clock" source="Ticks every 30s from the app's now">
          <LiveStatus />
        </Specimen>
        <Specimen label="Liquidity meter · table cells" source="21st.dev @vijayksingh/meter (id 37294), log scale $1K to $10M">
          <div className="flex flex-col gap-3">
            <LiquidityMeter value={1_720_000} label="SPYon route depth" />
            <LiquidityMeter value={96_000} label="METAon route depth" />
            <LiquidityMeter value={4_100} label="PLTRon route depth" />
            <LiquidityMeter value={0} label="AMDon route depth" />
          </div>
        </Specimen>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Specimen label="Liquidity meter · card, deep">
          <LiquidityMeter value={1_240_000} label="Route depth to USDC" variant="card" />
        </Specimen>
        <Specimen label="Liquidity meter · card, ok">
          <LiquidityMeter value={56_000} label="Route depth to USDC" variant="card" />
        </Specimen>
        <Specimen label="Liquidity meter · card, thin">
          <LiquidityMeter value={8_600} label="Route depth to USDC" variant="card" />
        </Specimen>
        <Specimen label="Liquidity meter · card, none">
          <LiquidityMeter value={0} label="Route depth to USDC" variant="card" />
        </Specimen>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Specimen label="Price impact ladder · deep route" source="21st.dev @eugeneshilow/leaderboard-bars (id 29466)">
          <PriceImpactLadder steps={ladder(1_240_000)} route="NVDAon → USDC" />
        </Specimen>
        <Specimen label="Price impact ladder · thin route, sizes over 3% flagged">
          <PriceImpactLadder steps={ladder(56_000)} route="GLDon → WETH → USDC" />
        </Specimen>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Specimen label={`Stock card · open, launchable · ${LOGO_NOTE}`} source="21st.dev @haydenbleasel/ticker (id 19171) + @8starlabs/partition-bar (id 26545)">
          <StockMarketCard
            asset={bySymbol("NVDAon")}
            now={CLOCK.open}
            holidays={HOLIDAYS_2026}
            coinSymbol="HARAMBE"
            action={
              <Button size="md" className="w-full">
                Pair with NVDAon
              </Button>
            }
          />
        </Specimen>
        <Specimen label="Stock card · market closed, thin route, not launchable">
          <StockMarketCard asset={bySymbol("PLTRon")} now={CLOCK.weekend} holidays={HOLIDAYS_2026} coinSymbol="MOG" />
        </Specimen>
        <Specimen label="Stock card · paused by Ondo">
          <StockMarketCard asset={bySymbol("COINon")} now={CLOCK.open} holidays={HOLIDAYS_2026} coinSymbol="BASED" />
        </Specimen>
      </div>

      <Specimen label={`Stock list · Discover "Stocks & RWA", link rows · ${LOGO_NOTE}`} source="21st.dev @isaiahbjork/financial-markets-table (id 9045)">
        <StockMarketList assets={ASSETS} now={CLOCK.open} holidays={HOLIDAYS_2026} earlyCloses={EARLY_CLOSES_2026} headingLevel={3} getHref={() => "#markets"} />
      </Specimen>

      <Specimen label="Stock list · launch Pair step, radio rows (after-hours), with the picked asset's card">
        <PairStepDemo />
      </Specimen>

      <Specimen label="Stock list · no matches">
        <StockMarketList title="Stocks & RWA" headingLevel={3} assets={ASSETS} now={CLOCK.open} defaultQuery="BRK" defaultLaunchableOnly getHref={() => "#markets"} />
      </Specimen>
    </GallerySection>
  );
}
