"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@verada/ui/components/ui/button";
import { AssetKindBadge } from "@verada/ui/components/varada/asset-kind-badge";
import { LiquidityMeter } from "@verada/ui/components/varada/liquidity-meter";
import { MarketStatus } from "@verada/ui/components/varada/market-status";
import { PairPicker } from "@verada/ui/components/varada/pair-picker";
import { PriceImpactLadder, type ImpactStep } from "@verada/ui/components/varada/price-impact-ladder";
import { AlwaysOpen, QuoteAssetIdentity, QuoteKindMark, type QuoteAsset } from "@verada/ui/components/varada/quote-asset";
import { QuoteAssetCard } from "@verada/ui/components/varada/quote-asset-card";
import { QuoteAssetList } from "@verada/ui/components/varada/quote-asset-list";
import type { ImageSource } from "@verada/ui/components/varada/shared";
import { quoteAssetLogo } from "@/lib/asset-packs";
import { siteBase } from "@/lib/base";
import { GallerySection } from "../section";

/* ---------- gallery helpers ---------- */

/**
 * A demo tile with a short sentence-case label (not the uppercase kicker), an optional source line and
 * an optional note under the demo.
 */
export function Demo({ label, source, note, children, className }: { label: string; source?: string; note?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <figure className={`m-0 flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-card p-4 sm:p-5 ${className ?? ""}`}>
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-sm font-semibold text-ink">{label}</span>
        {source ? <span className="text-xs text-muted-foreground">{source}</span> : null}
      </figcaption>
      {children}
      {note ? <p className="m-0 text-[13px] text-muted-foreground">{note}</p> : null}
    </figure>
  );
}

/**
 * A container you can drag wider or narrower (bottom-right handle), labelled with its width class, so
 * container-query components can be seen switching layout.
 */
export function Frame({ label, width, resizable, children }: { label: string; width?: string; resizable?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div
        className={`max-w-full rounded-2xl border border-dashed border-line-strong bg-paper p-3 ${resizable ? "min-w-[260px] resize-x overflow-auto" : ""}`}
        style={width ? { width } : undefined}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Real quote logos from the bundle (and the stocks pack once published). The first render uses "../"
 * (the gallery is one directory deep) so server and client agree; after mount the site base takes over.
 */
export function useQuoteLogo(displayWidth = 64): (symbol: string) => ImageSource | undefined {
  const [base, setBase] = useState("../");
  useEffect(() => setBase(siteBase()), []);
  return useMemo(
    () => (symbol: string) => quoteAssetLogo({ assetPacks: {}, swarmGatewayUrl: undefined }, symbol, (p) => base + p, displayWidth),
    [base, displayWidth],
  );
}

/* ---------- sample data (not live) ---------- */

/** NYSE / Nasdaq full-day closures and early closes for 2026. */
export const HOLIDAYS_2026 = ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"];
export const EARLY_CLOSES_2026 = ["2026-11-27", "2026-12-24"];

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

type Draft = Omit<QuoteAsset, "logo">;

function ondo(symbol: string, name: string, kind: QuoteAsset["kind"], price: number, change24h: number, depth: number, coinsPaired: number, extra: Partial<Draft> = {}): Draft {
  const viaWeth = depth > 0 && depth < 60_000;
  return {
    symbol,
    name,
    kind,
    price,
    change24h,
    routeDepthUsd: depth,
    poolLiquidityUsd: depth ? Math.round(depth * 1.08) : 0,
    volume24hUsd: Math.round(depth * 0.18),
    reserves: depth ? { base: { symbol, usd: Math.round(depth * 0.54) }, quote: { symbol: viaWeth ? "WETH" : "USDC", usd: Math.round(depth * 0.54 * 0.92) } } : undefined,
    route: depth ? (viaWeth ? [symbol, "WETH", "USDC"] : [symbol, "USDC"]) : [],
    impact: ladder(depth),
    coinsPaired,
    ...extra,
  };
}

function crypto(symbol: string, name: string, price: number, change24h: number, depth: number, coinsPaired: number, route: string[], extra: Partial<Draft> = {}): Draft {
  return {
    symbol,
    name,
    kind: "crypto",
    price,
    change24h,
    routeDepthUsd: depth,
    poolLiquidityUsd: Math.round(depth * 0.4),
    volume24hUsd: Math.round(depth * 0.35),
    route,
    impact: ladder(depth),
    coinsPaired,
    ...extra,
  };
}

const DRAFTS: Draft[] = [
  crypto("WETH", "Wrapped Ether", 3412.5, 1.84, 48_000_000, 212, ["WETH", "USDC"]),
  crypto("USDC", "USD Coin", 1.0, 0.0, 0, 64, ["USDC"], { poolLiquidityUsd: 22_000_000, reserves: undefined }),
  crypto("WBTC", "Wrapped Bitcoin", 98_240, 0.92, 21_000_000, 31, ["WBTC", "USDC"]),
  crypto("cbBTC", "Coinbase Wrapped BTC", 98_190, 0.88, 12_500_000, 18, ["cbBTC", "USDC"]),
  crypto("wstETH", "Lido Wrapped Staked ETH", 4051.2, 1.79, 9_400_000, 11, ["wstETH", "WETH", "USDC"]),
  crypto("USDT", "Tether USD", 1.0002, 0.01, 30_000_000, 22, ["USDT", "USDC"]),
  crypto("DAI", "Dai Stablecoin", 0.9998, -0.02, 6_200_000, 6, ["DAI", "USDC"]),
  crypto("LINK", "Chainlink", 18.42, -2.31, 3_100_000, 9, ["LINK", "WETH", "USDC"]),
  crypto("UNI", "Uniswap", 9.84, 3.12, 2_400_000, 7, ["UNI", "WETH", "USDC"]),
  crypto("AAVE", "Aave", 212.3, -0.64, 1_800_000, 5, ["AAVE", "WETH", "USDC"]),
  ondo("NVDAon", "NVIDIA", "stock", 129.48, 2.14, 1_240_000, 14),
  ondo("AAPLon", "Apple", "stock", 227.63, 0.82, 640_000, 9),
  ondo("MSFTon", "Microsoft", "stock", 418.2, -0.41, 520_000, 6),
  ondo("GOOGLon", "Alphabet Class A", "stock", 176.94, 1.37, 210_000, 4),
  ondo("METAon", "Meta Platforms", "stock", 589.1, -1.92, 96_000, 3),
  ondo("COINon", "Coinbase Global", "stock", 262.35, 6.48, 74_000, 5, { paused: true }),
  ondo("NFLXon", "Netflix", "stock", 752.6, 0.05, 41_000, 1),
  ondo("TSLAon", "Tesla", "stock", 248.5, -3.36, 880_000, 11),
  ondo("AMZNon", "Amazon.com", "stock", 201.7, 0.94, 330_000, 5),
  ondo("MSTRon", "Strategy", "stock", 341.2, 8.71, 0, 0),
  ondo("AMDon", "Advanced Micro Devices", "stock", 152.1, 0.38, 0, 0),
  ondo("PLTRon", "Palantir Technologies", "stock", 41.2, 5.62, 4_100, 1),
  ondo("CRWVon", "CoreWeave", "stock", 96.4, 4.05, 12_000, 0),
  ondo("SPYon", "SPDR S&P 500 ETF Trust", "etf", 571.3, 0.61, 1_720_000, 12),
  ondo("QQQon", "Invesco QQQ Trust", "etf", 492.8, 0.88, 930_000, 7),
  ondo("IWMon", "iShares Russell 2000 ETF", "etf", 221.4, -0.73, 8_600, 0),
  ondo("GLDon", "SPDR Gold Shares", "etf", 241.8, -0.21, 56_000, 2),
];

/** Sample assets with real logos; CRWVon has none in the bundle and shows the lettered fallback. */
export function useQuoteAssets(): { all: QuoteAsset[]; bySymbol: (s: string) => QuoteAsset } {
  const logo = useQuoteLogo();
  return useMemo(() => {
    const all = DRAFTS.map((d) => ({ ...d, logo: logo(d.symbol) }));
    return { all, bySymbol: (s: string) => all.find((a) => a.symbol === s)! };
  }, [logo]);
}

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

function PairStepDemo({ assets, bySymbol, harambe }: { assets: QuoteAsset[]; bySymbol: (s: string) => QuoteAsset; harambe?: ImageSource }) {
  const [value, setValue] = useState<string | null>("WETH");
  const picked = value ? bySymbol(value) : null;
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <PairPicker assets={assets} now={CLOCK.after} holidays={HOLIDAYS_2026} earlyCloses={EARLY_CLOSES_2026} coinSymbol="HARAMBE" coinImage={harambe} value={value} onValueChange={setValue} />
      {picked ? <QuoteAssetCard asset={picked} now={CLOCK.after} holidays={HOLIDAYS_2026} coinSymbol="HARAMBE" headingLevel={4} /> : null}
    </div>
  );
}

export function MarketsSection() {
  const { all, bySymbol } = useQuoteAssets();
  const [base, setBase] = useState("../");
  useEffect(() => setBase(siteBase()), []);
  const harambe = { src: `${base}assets/cutouts/gorilla-mog-320.webp` };
  const listProps = { assets: all, now: CLOCK.open, holidays: HOLIDAYS_2026, earlyCloses: EARLY_CLOSES_2026, coinSymbol: "HARAMBE", headingLevel: 3 as const, getHref: () => "#markets" };

  return (
    <GallerySection
      id="markets"
      title="Pairs, stocks and liquidity"
      intro="What a coin pairs with: major mainnet crypto (WETH, WBTC, cbBTC, wstETH, stablecoins, LINK, UNI, AAVE), which trades around the clock, or Ondo tokenized stocks and ETFs, whose prices go stale outside 9:30 to 16:00 ET or while Ondo pauses a token. How deep each route to USDC is, what a trade size does to the price, and whether a coin can pair with it. Sample data, not live."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Demo
          label="Asset identity"
          source="Written for Varada · header after 21st.dev @haydenbleasel/ticker (id 19171)"
          note="Logo with a small kind glyph on its corner, the symbol, then one quiet meta line. CRWVon has no logo in the bundle, so it gets the lettered fallback."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {["WETH", "WBTC", "NVDAon", "SPYon", "USDC", "CRWVon"].map((s) => (
              <QuoteAssetIdentity key={s} asset={bySymbol(s)} plain />
            ))}
          </div>
        </Demo>
        <Demo label="Kind marks and badges" source="Written for Varada" note="Kind is a hue plus a word, never colour alone. The quiet badge is the default; the filled tag is for dense legends.">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-4">
              {(["crypto", "stock", "etf", "rwa"] as const).map((k) => (
                <span key={k} className="inline-flex items-center gap-2 text-[13px] text-ink-soft">
                  <QuoteKindMark kind={k} size={22} />
                  <QuoteKindMark kind={k} variant="dot" />
                  <AssetKindBadge kind={k} />
                  <AssetKindBadge kind={k} variant="tag" />
                </span>
              ))}
            </div>
          </div>
        </Demo>
      </div>

      <Demo label="Market status, every session" source="21st.dev @diceui/status (id 25395) · America/New_York via Intl">
        <div className="flex flex-wrap items-center gap-2.5">
          <MarketStatus now={CLOCK.open} holidays={HOLIDAYS_2026} />
          <MarketStatus now={CLOCK.pre} holidays={HOLIDAYS_2026} />
          <MarketStatus now={CLOCK.after} holidays={HOLIDAYS_2026} />
          <MarketStatus now={CLOCK.overnight} holidays={HOLIDAYS_2026} />
          <MarketStatus now={CLOCK.weekend} holidays={HOLIDAYS_2026} />
          <MarketStatus now={CLOCK.holiday} holidays={HOLIDAYS_2026} earlyCloses={EARLY_CLOSES_2026} title="Thanksgiving: closed all day" />
          <MarketStatus now={CLOCK.earlyClose} holidays={HOLIDAYS_2026} earlyCloses={EARLY_CLOSES_2026} title="Early close at 13:00 ET" />
          <MarketStatus now={CLOCK.open} paused />
          <MarketStatus now={CLOCK.open} size="sm" showCountdown={false} />
          <AlwaysOpen />
        </div>
        <p className="m-0 text-[13px] text-muted-foreground">
          Open Tue 11:05 ET · pre-market 07:40 · after-hours 17:15 · overnight 22:00 · Saturday · Thanksgiving · early close · paused by Ondo · compact cell · crypto (no pill,
          it never closes).
        </p>
      </Demo>

      <div className="grid gap-4 md:grid-cols-2">
        <Demo label="Market status on your clock" source="Ticks every 30s from the app's now">
          <LiveStatus />
        </Demo>
        <Demo label="Liquidity meter in table cells" source="21st.dev @vijayksingh/meter (id 37294), log scale $1K to $10M">
          <div className="flex flex-col gap-3">
            <LiquidityMeter value={48_000_000} label="WETH route depth" />
            <LiquidityMeter value={96_000} label="METAon route depth" />
            <LiquidityMeter value={4_100} label="PLTRon route depth" />
            <LiquidityMeter value={0} label="AMDon route depth" />
          </div>
        </Demo>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {(
          [
            ["Deep", 1_240_000],
            ["OK", 56_000],
            ["Thin", 8_600],
            ["None", 0],
          ] as const
        ).map(([name, v]) => (
          <Demo key={name} label={`Liquidity meter card, ${name.toLowerCase()}`}>
            <LiquidityMeter value={v} label="Route depth to USDC" variant="card" />
          </Demo>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Demo label="Price impact, deep route" source="21st.dev @eugeneshilow/leaderboard-bars (id 29466)">
          <PriceImpactLadder steps={ladder(1_240_000)} route="NVDAon → USDC" />
        </Demo>
        <Demo label="Price impact, thin route" note="Sizes over 3% are flagged in words as well as colour.">
          <PriceImpactLadder steps={ladder(56_000)} route="GLDon → WETH → USDC" />
        </Demo>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        <Demo label="Crypto card, WETH" source="21st.dev @haydenbleasel/ticker (id 19171) + @8starlabs/partition-bar (id 26545)" note="No market-hours pill: crypto trades 24/7.">
          <QuoteAssetCard
            asset={bySymbol("WETH")}
            now={CLOCK.open}
            coinSymbol="HARAMBE"
            action={
              <Button size="md" className="w-full">
                Pair with WETH
              </Button>
            }
          />
        </Demo>
        <Demo label="Stock card, market open">
          <QuoteAssetCard asset={bySymbol("NVDAon")} now={CLOCK.open} holidays={HOLIDAYS_2026} coinSymbol="HARAMBE" />
        </Demo>
        <Demo label="Stock card, closed and too thin">
          <QuoteAssetCard asset={bySymbol("PLTRon")} now={CLOCK.weekend} holidays={HOLIDAYS_2026} coinSymbol="MOG" />
        </Demo>
        <Demo label="Stock card, paused by Ondo">
          <QuoteAssetCard asset={bySymbol("COINon")} now={CLOCK.open} holidays={HOLIDAYS_2026} coinSymbol="BASED" />
        </Demo>
        <Demo label="Stablecoin card, fees already USDC">
          <QuoteAssetCard asset={bySymbol("USDC")} now={CLOCK.open} coinSymbol="TIGR" />
        </Demo>
        <Demo label="Long-tail stock, lettered logo">
          <QuoteAssetCard asset={bySymbol("CRWVon")} now={CLOCK.open} holidays={HOLIDAYS_2026} coinSymbol="TIGR" />
        </Demo>
      </div>

      <Demo
        label="Pair list in three container widths"
        source="21st.dev @isaiahbjork/financial-markets-table (id 9045) · container queries"
        note="Columns follow the list's own width, not the screen: card rows under 36rem, then Price and 24h, then liquidity and market from 48rem, then fee route and coins from 64rem. The last frame can be dragged."
      >
        <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <Frame label="Narrow, 360px" width="360px">
            <QuoteAssetList {...listProps} title="Pair with" />
          </Frame>
          <Frame label="Medium, the rest of the row">
            <QuoteAssetList {...listProps} title="Pair with" defaultKind="crypto" />
          </Frame>
        </div>
        <Frame label="Wide, full width (drag the corner to resize)" resizable>
          <QuoteAssetList {...listProps} title="Discover pairs" />
        </Frame>
      </Demo>

      <Demo label="Pair step, radio rows with the picked asset's card" source="21st.dev @ssychui/swap-ticket (id 27122) picker rows" note="WETH is preselected. Stocks show after-hours here; assets without a deep enough route are disabled with the reason.">
        <PairStepDemo assets={all} bySymbol={bySymbol} harambe={harambe} />
      </Demo>

      <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        <Demo label="Pair step in a 360px column">
          <PairPicker assets={all} now={CLOCK.open} holidays={HOLIDAYS_2026} coinSymbol="MOG" defaultKind="crypto" />
        </Demo>
        <Demo label="No matches">
          <QuoteAssetList {...listProps} title="Stocks & RWA" defaultQuery="BRK" defaultLaunchableOnly />
        </Demo>
      </div>
    </GallerySection>
  );
}
