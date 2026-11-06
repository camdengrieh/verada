"use client";

import { createContext, useContext, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { BottomTabBar, varadaTabs } from "@verada/ui/components/mobile/bottom-tab-bar";
import { FilterButton, FilterSheet, countFilters, type FilterGroup, type FilterValue } from "@verada/ui/components/mobile/filter-sheet";
import { MobileHeader } from "@verada/ui/components/mobile/mobile-header";
import { MobilePairPicker, type PairOption } from "@verada/ui/components/mobile/mobile-pair-picker";
import type { MobileSearchResult } from "@verada/ui/components/mobile/mobile-search-sheet";
import { MobileTradeSheet } from "@verada/ui/components/mobile/mobile-trade-sheet";
import { MobileTradesSheet } from "@verada/ui/components/mobile/mobile-trades-sheet";
import { MobileVoteSheet } from "@verada/ui/components/mobile/mobile-vote-sheet";
import { PullToRefresh } from "@verada/ui/components/mobile/pull-to-refresh";
import { StickyActionBar } from "@verada/ui/components/mobile/sticky-action-bar";
import { TokenSwipeRow } from "@verada/ui/components/mobile/swipe-row";
import { TokenCarousel } from "@verada/ui/components/mobile/token-carousel";
import { Sparkline } from "@verada/ui/components/data/sparkline";
import { Button } from "@verada/ui/components/ui/button";
import { ActivityFeed, type ActivityFeedItem } from "@verada/ui/components/varada/activity-feed";
import type { BallotOptionData } from "@verada/ui/components/varada/ballot-option";
import { CausePoolCard } from "@verada/ui/components/varada/cause-pool-card";
import { LiquidityPanel } from "@verada/ui/components/varada/liquidity-panel";
import { PriceChange } from "@verada/ui/components/varada/price-change";
import type { VaradaLinkProps } from "@verada/ui/components/varada/shared";
import { TokenCard, type TokenSummary } from "@verada/ui/components/varada/token-card";
import { TradeTicker } from "@verada/ui/components/varada/trade-feed";
import { usePrefersReducedMotion } from "@verada/ui/components/motion/marquee";
import type { TradeSide, TradeToken } from "@verada/ui/components/varada/trade-panel";
import { useAssetUrl } from "@verada/ui/lib/assets";
import { quoteAssetLogo } from "@/lib/asset-packs";
import { siteBase } from "@/lib/base";
import { GallerySection, Specimen } from "../section";
import { SAMPLE_HOLDERS, SAMPLE_INSIGHTS, useSampleStream } from "./activity";

/* ---------- sample data (not live) ---------- */

const NO_PACKS = { assetPacks: {}, swarmGatewayUrl: undefined };
const logo = (symbol: string) => quoteAssetLogo(NO_PACKS, symbol, (p) => siteBase() + p);

function useTokens(): TokenSummary[] {
  const url = useAssetUrl();
  return useMemo(() => {
    const art = (path: string) => ({ src: url(path) });
    return [
      {
        name: "Harambe's Wish",
        symbol: "HARAMBE",
        ens: "harambe.varada.eth",
        art: art("assets/scenes/harambe-v1-960.webp"),
        artAlt: "Painted gorilla in rainbow shades",
        wash: "sage",
        giving: { mode: "weekly" },
        change24h: 18.42,
        quote: { symbol: "NVDAon", kind: "stock", logo: logo("NVDAon") },
        cause: "wildlife",
        marketCap: "$412K",
        volume24h: "$96K",
        liquidity: "$58K",
        raised: "$3,210",
        raisedPct: 64,
      },
      {
        name: "Tiger Wif Hat",
        symbol: "TIGR",
        ens: "tigr.varada.eth",
        art: art("assets/cutouts/tiger-wif-hat-320.webp"),
        artAlt: "Tiger in a knitted hat",
        wash: "ochre",
        giving: { mode: "live", cadence: "24h" },
        change24h: -4.2,
        quote: { symbol: "WETH", kind: "crypto", logo: logo("WETH") },
        cause: "children",
        marketCap: "$268K",
        volume24h: "$41K",
        liquidity: "$36K",
        raised: "$1,905",
        raisedPct: 38,
      },
      {
        name: "Party King",
        symbol: "CROWN",
        ens: "crown.varada.eth",
        art: art("assets/cutouts/party-hat-320.webp"),
        artAlt: "Painted figure in a party hat",
        wash: "etf",
        giving: { mode: "weekly" },
        change24h: 2.3,
        quote: { symbol: "QQQon", kind: "etf", logo: logo("QQQon") },
        cause: "hunger",
        marketCap: "$530K",
        volume24h: "$64K",
        liquidity: "$71K",
        raised: "$4,120",
        raisedPct: 82,
      },
      {
        name: "Gorilla Mog",
        symbol: "MOG",
        ens: "mog.varada.eth",
        art: art("assets/cutouts/gorilla-mog-320.webp"),
        artAlt: "Painted gorilla giving a sideways look",
        wash: "sky",
        giving: { mode: "live", cadence: "1h" },
        change24h: 7.9,
        quote: { symbol: "WBTC", kind: "crypto", logo: logo("WBTC") },
        cause: "environment",
        marketCap: "$151K",
        volume24h: "$22K",
        liquidity: "$19K",
        raised: "$720",
        raisedPct: 21,
      },
    ];
  }, [url]);
}

const FEED: ActivityFeedItem[] = [
  { id: "f1", symbol: "$TIGR", text: "gave to Save the Children", ago: "just now", amount: "$212", cause: "children", fresh: true },
  { id: "f2", symbol: "$MOG", text: "gave to Rainforest Trust", ago: "40 min ago", amount: "$84", cause: "environment" },
  { id: "f3", symbol: "$HARAMBE", text: "epoch 12 closed, Save the Elephants won", ago: "3 h ago", cause: "wildlife" },
];

const BALLOT: BallotOptionData[] = [
  { id: "1", org: "Save the Elephants", category: "wildlife", region: "Africa", source: "pinned" },
  { id: "2", org: "Wildlife SOS", category: "wildlife", region: "Asia", source: "pinned" },
  { id: "3", org: "African Parks", category: "environment", region: "Africa", source: "curated", score: "79/100" },
  { id: "4", org: "Panthera", category: "wildlife", region: "Global", source: "curated", score: "77/100" },
  { id: "5", org: "Born Free USA", category: "animals", region: "North America", source: "rotation" },
  { id: "6", org: "Rainforest Trust", category: "environment", region: "Latin America & Caribbean", source: "rotation" },
  { id: "7", org: "Snow Leopard Trust", category: "wildlife", region: "Asia", source: "rotation" },
];

const FILTER_GROUPS: FilterGroup[] = [
  {
    id: "sort",
    label: "Sort by",
    type: "single",
    options: [
      { value: "trending", label: "Trending" },
      { value: "new", label: "New" },
      { value: "raised", label: "Most raised" },
      { value: "mcap", label: "Market cap" },
    ],
  },
  {
    id: "pair",
    label: "Paired with",
    type: "multi",
    options: [
      { value: "crypto", label: "Crypto", count: 2 },
      { value: "stock", label: "Stocks", count: 1 },
      { value: "etf", label: "ETFs", count: 1 },
    ],
  },
  {
    id: "giving",
    label: "Giving",
    type: "multi",
    options: [
      { value: "weekly", label: "Weekly vote", count: 2 },
      { value: "live", label: "Live donation", count: 2 },
    ],
  },
];
const DEFAULT_FILTERS: FilterValue = { sort: ["trending"] };

const crypto = (symbol: string, name: string, depthPct: number, depthLabel: string): PairOption => ({ symbol, name, kind: "crypto", logo: logo(symbol), depthPct, depthLabel });
const stock = (symbol: string, name: string, depthPct: number, depthLabel: string, kind: "stock" | "etf" = "stock"): PairOption => ({
  symbol,
  name,
  kind,
  logo: logo(symbol),
  depthPct,
  depthLabel,
});
const PAIRS_CRYPTO: PairOption[] = [
  crypto("WETH", "Wrapped Ether", 100, "$48M deep"),
  crypto("WBTC", "Wrapped Bitcoin", 82, "$21M deep"),
  crypto("USDC", "USD Coin", 100, "Direct to USDC"),
  crypto("USDT", "Tether USD", 90, "$30M deep"),
  crypto("DAI", "Dai", 70, "$9M deep"),
  crypto("wstETH", "Lido wrapped staked ETH", 74, "$12M deep"),
  crypto("cbBTC", "Coinbase wrapped BTC", 66, "$8M deep"),
  crypto("LINK", "Chainlink", 48, "$3.1M deep"),
  crypto("UNI", "Uniswap", 40, "$2.4M deep"),
  crypto("AAVE", "Aave", 36, "$1.9M deep"),
];
const PAIRS_STOCKS: PairOption[] = [
  stock("NVDAon", "NVIDIA (Ondo)", 64, "$212K deep"),
  stock("TSLAon", "Tesla (Ondo)", 58, "$180K deep"),
  stock("AAPLon", "Apple (Ondo)", 61, "$198K deep"),
  stock("MSFTon", "Microsoft (Ondo)", 44, "$120K deep"),
  stock("SPYon", "S&P 500 ETF (Ondo)", 72, "$260K deep", "etf"),
  stock("QQQon", "Nasdaq 100 ETF (Ondo)", 66, "$230K deep", "etf"),
  stock("COINon", "Coinbase (Ondo)", 30, "$64K deep"),
  stock("GLDon", "Gold ETF (Ondo)", 38, "$90K deep", "etf"),
];

/* ---------- frame and demo links ---------- */

/** Links inside the phones don't navigate; they report their href (e.g. to move the active tab). */
const DemoNav = createContext<(href: string) => void>(() => undefined);

function DemoLink({ href, children, onClick, ...props }: VaradaLinkProps) {
  const go = useContext(DemoNav);
  return (
    <a
      href={href}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault();
        onClick?.(e);
        go(href);
      }}
      {...props}
    >
      {children}
    </a>
  );
}

const TABS = varadaTabs({ discover: "#m-discover", trade: "#m-trade", vote: "#m-vote", me: "#m-me" }, { vote: { badge: 1, badgeLabel: "1 open ballot" } });

/**
 * A 390 × 844 phone outline (CSS only). It is a size container with layout containment, so the
 * components inside lay out for 390px and fixed bars and sheets (portalled into it) stay inside.
 */
function Phone({ label, children }: { label: string; children: (frame: HTMLElement | null) => ReactNode }) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  return (
    <div
      ref={setFrame}
      role="group"
      aria-label={`${label}, phone preview`}
      className="@container relative isolate mx-auto flex h-[844px] w-full max-w-[390px] flex-col overflow-hidden rounded-[44px] border-[6px] border-ink bg-paper shadow-float [transform:translateZ(0)]"
    >
      {children(frame)}
    </div>
  );
}

/**
 * The frames show their sheets open at first, in place (`inline`), because several are open at once.
 * After the first close a sheet reopens as the real vaul drawer inside its frame (drag, snap points,
 * focus trap).
 */
function usePreviewSheet() {
  const [open, setOpenState] = useState(true);
  const [inline, setInline] = useState(true);
  const setOpen = (o: boolean) => {
    setOpenState(o);
    if (!o) setInline(false);
  };
  return { open, inline, setOpen };
}

const connect = (
  <Button size="md" className="h-12 px-4">
    Connect
  </Button>
);

/* ---------- screens ---------- */

function DiscoverScreen() {
  const tokens = useTokens();
  const [active, setActive] = useState("#m-discover");
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [watching, setWatching] = useState<string[]>(["TIGR"]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filters, setFilters] = useState<FilterValue>(DEFAULT_FILTERS);
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState(tokens);

  const q = query.trim().toLowerCase();
  const results: MobileSearchResult[] = q
    ? tokens
        .filter((t) => `${t.name} ${t.symbol} ${t.ens} ${t.quote.symbol}`.toLowerCase().includes(q))
        .map((t) => ({
          id: t.symbol,
          title: t.name,
          subtitle: `$${t.symbol} / ${t.quote.symbol} · ${t.ens}`,
          group: "Coins",
          href: `#m-token-${t.symbol.toLowerCase()}`,
          // The site is a static Swarm export; the library's images are plain <img> too.
          // eslint-disable-next-line @next/next/no-img-element
          media: t.art ? <img src={t.art.src} alt="" className="size-10 object-contain" /> : null,
          trailing: <PriceChange value={t.change24h} />,
        }))
    : [];

  return (
    <DemoNav.Provider value={(href) => (href.startsWith("#m-") && TABS.some((t) => t.href === href) ? setActive(href) : setStatus(`Would open ${href.replace("#m-", "")}`))}>
      <Phone label="Discover">
        {(frame) => (
          <>
            <MobileHeader
              homeHref="#m-discover"
              LinkComponent={DemoLink}
              privacy="private"
              wallet={connect}
              search={{
                value: query,
                onValueChange: setQuery,
                results,
                recent: ["NVDAon", "wildlife"],
                suggestions: ["$HARAMBE", "Tigers", "WBTC pairs", "Live donation"],
                container: frame,
              }}
            />
            <PullToRefresh
              className="min-h-0 flex-1 pt-1"
              scrollClassName="h-full"
              scrollRef={setScroller}
              onRefresh={() =>
                new Promise<void>((done) =>
                  setTimeout(() => {
                    setRows((r) => [...r.slice(1), r[0]!]);
                    setStatus("Refreshed");
                    done();
                  }, 900),
                )
              }
            >
              <div className="flex flex-col gap-5 pb-28 pt-1">
                <TokenCarousel label="Featured coins">
                  {tokens.map((t, i) => (
                    <TokenCard key={t.symbol} token={t} href={`#m-token-${t.symbol.toLowerCase()}`} onBuy={() => setStatus(`Buy $${t.symbol}`)} LinkComponent={DemoLink} priority={i === 0} />
                  ))}
                </TokenCarousel>
                <div className="flex items-center justify-between gap-3 px-4">
                  <h2 className="m-0 font-display text-xl font-semibold">Trending</h2>
                  <FilterButton count={countFilters(filters, DEFAULT_FILTERS)} onClick={() => setFiltersOpen(true)} />
                </div>
                <ul className="m-0 flex list-none flex-col gap-2.5 px-4 py-0">
                  {rows.map((t) => (
                    <li key={t.symbol}>
                      <TokenSwipeRow
                        token={t}
                        href={`#m-token-${t.symbol.toLowerCase()}`}
                        LinkComponent={DemoLink}
                        watching={watching.includes(t.symbol)}
                        onWatch={() => setWatching((w) => (w.includes(t.symbol) ? w.filter((s) => s !== t.symbol) : [...w, t.symbol]))}
                        onBuy={() => setStatus(`Buy $${t.symbol}`)}
                      />
                    </li>
                  ))}
                </ul>
                <p role="status" className="m-0 min-h-5 px-4 text-[13px] text-ink-muted">
                  {status}
                </p>
                <div className="px-4">
                  <ActivityFeed items={FEED} />
                </div>
              </div>
            </PullToRefresh>
            <BottomTabBar tabs={TABS} activeHref={active} launch={{ href: "#m-launch" }} LinkComponent={DemoLink} hideOnScroll scrollContainer={scroller} />
            <FilterSheet
              open={filtersOpen}
              onOpenChange={setFiltersOpen}
              container={frame}
              groups={FILTER_GROUPS}
              value={filters}
              resetValue={DEFAULT_FILTERS}
              onApply={setFilters}
              applyLabel={(d) => {
                const n = countFilters(d, DEFAULT_FILTERS);
                return n ? `Show coins · ${n} ${n === 1 ? "filter" : "filters"}` : "Show all coins";
              }}
            />
          </>
        )}
      </Phone>
    </DemoNav.Provider>
  );
}

type PayAsset = "WETH" | "WBTC" | "USDC" | "NVDAon";
const PAY: Record<PayAsset, { token: TradeToken; priceUsd: number; raw: string }> = {
  WETH: { token: { symbol: "WETH", kind: "crypto", balance: "1.8421" }, priceUsd: 3050.12, raw: "1.8421" },
  WBTC: { token: { symbol: "WBTC", kind: "crypto", balance: "0.0842" }, priceUsd: 97_120, raw: "0.0842" },
  USDC: { token: { symbol: "USDC", kind: "crypto", balance: "2,450.00" }, priceUsd: 1, raw: "2450" },
  NVDAon: { token: { symbol: "NVDAon", kind: "stock", balance: "3,402.18" }, priceUsd: 129.48, raw: "3402.18" },
};
const PAY_ORDER: PayAsset[] = ["WETH", "WBTC", "USDC", "NVDAon"];
const HARAMBE_USD = 0.00000412;
const HARAMBE_BALANCE = 38_900_000;
const CHART = [3.1, 3.0, 3.3, 3.2, 3.5, 3.4, 3.8, 3.7, 3.9, 4.0, 3.95, 4.12];

function TradeScreen() {
  const tokens = useTokens();
  const coin = tokens[0]!;
  const { open, inline, setOpen } = usePreviewSheet();
  const [side, setSide] = useState<TradeSide>("buy");
  const [asset, setAsset] = useState<PayAsset>("WETH");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(1);
  const [status, setStatus] = useState("");
  const pay = PAY[asset];
  const n = parseFloat(amount) || 0;
  const buying = side === "buy";
  const usd = buying ? n * pay.priceUsd : n * HARAMBE_USD;
  const out = buying ? usd / HARAMBE_USD : usd / pay.priceUsd;
  const fee = usd * 0.025;
  const fmtUsd = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

  return (
    <DemoNav.Provider value={() => undefined}>
      <Phone label="Trade">
        {(frame) => (
          <>
            <MobileHeader homeHref="#m-discover" LinkComponent={DemoLink} privacy="private" wallet={connect} title="Harambe's Wish" />
            <div className="flex flex-col gap-3 px-4 pt-4">
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element -- static Swarm export, like the library's own images */}
                <img src={coin.art?.src} alt="" className="size-14 rounded-2xl bg-sage-tint object-contain" />
                <div className="flex flex-col">
                  <strong className="font-display text-xl">Harambe&apos;s Wish</strong>
                  <span className="text-[13px]">
                    <span className="num">$0.00000412</span> <PriceChange value={18.42} className="text-[13px]" />
                  </span>
                </div>
              </div>
              <Sparkline data={CHART} width={358} height={140} label="24 hour price, up 18%" className="h-auto w-full" />
              <p role="status" className="m-0 min-h-5 text-[13px] text-ink-muted">
                {status}
              </p>
              {!open ? (
                <Button size="lg" className="h-13" onClick={() => setOpen(true)}>
                  Trade $HARAMBE
                </Button>
              ) : null}
            </div>
            {open && inline ? <div aria-hidden="true" className="absolute inset-0 z-40 bg-ink/40" onClick={() => setOpen(false)} /> : null}
            <MobileTradeSheet
              open={open}
              onOpenChange={setOpen}
              container={frame}
              inline={inline}
              coin={{ name: coin.name, symbol: coin.symbol, art: coin.art, wash: coin.wash, price: "$0.00000412", change24h: 18.42 }}
              side={side}
              onSideChange={(s) => {
                setSide(s);
                setAmount("");
              }}
              pay={buying ? { ...pay.token, logo: logo(asset) } : { symbol: "$HARAMBE", kind: "crypto", balance: "38,900,000" }}
              receive={buying ? { symbol: "$HARAMBE" } : { ...pay.token, logo: logo(asset) }}
              payAmount={amount}
              onPayAmountChange={setAmount}
              payFiat={n ? fmtUsd(usd) : undefined}
              receiveAmount={n ? out.toLocaleString("en-US", { maximumFractionDigits: buying ? 0 : 6 }) : ""}
              payPriceUsd={buying ? pay.priceUsd : undefined}
              payBalanceRaw={buying ? pay.raw : String(HARAMBE_BALANCE)}
              maxAmount={buying && asset === "WETH" ? "1.8371" : undefined}
              onPickPayToken={
                buying
                  ? () => {
                      setAsset(PAY_ORDER[(PAY_ORDER.indexOf(asset) + 1) % PAY_ORDER.length]!);
                      setAmount("");
                    }
                  : undefined
              }
              slippage={slippage}
              onSlippageChange={setSlippage}
              priceImpact={usd > 5000 ? 4.8 : usd > 1500 ? 1.6 : 0.42}
              minReceived={n ? (out * (1 - slippage / 100)).toLocaleString("en-US", { maximumFractionDigits: buying ? 0 : 6 }) : undefined}
              fee="2.5%"
              sniperFee={{ active: false }}
              causeAmount={n ? fmtUsd(fee * 0.9) : "$0"}
              platformAmount={n ? fmtUsd(fee * 0.1) : undefined}
              causeName="this week's wildlife cause"
              causeIcon="wildlife"
              blocker={buying && n > Number(pay.raw) ? { label: `Insufficient ${asset} balance` } : !buying && n > HARAMBE_BALANCE ? { label: "Insufficient $HARAMBE balance" } : null}
              onSubmit={() => setStatus(`Review: ${amount} ${buying ? asset : "$HARAMBE"}`)}
            />
          </>
        )}
      </Phone>
    </DemoNav.Provider>
  );
}

function VoteScreen() {
  const { open, inline, setOpen } = usePreviewSheet();
  const [choice, setChoice] = useState("1");
  const [voted, setVoted] = useState<string | null>(null);
  return (
    <DemoNav.Provider value={() => undefined}>
      <Phone label="Vote">
        {(frame) => (
          <>
            <MobileHeader homeHref="#m-discover" LinkComponent={DemoLink} privacy="private" wallet={connect} />
            <div className="flex flex-col gap-3 px-4 pt-4">
              <CausePoolCard
                epoch={12}
                countdown="closes in 2d 14h"
                amount="$1,284.60"
                attributed="$1,112.40"
                carriedForward="$172.20"
                ballot={{ pinned: 2, curated: 2, rotation: 3 }}
                curator="wildlife.agent.varada.eth"
                onVote={() => setOpen(true)}
                voteLabel={voted ? "Change your vote" : "Vote privately"}
              />
              <p role="status" className="m-0 min-h-5 text-[13px] text-ink-muted">
                {voted ? `Encrypted vote for ${voted} ready to sign.` : ""}
              </p>
            </div>
            {open && inline ? <div aria-hidden="true" className="absolute inset-0 z-40 bg-ink/40" onClick={() => setOpen(false)} /> : null}
            <MobileVoteSheet
              open={open}
              onOpenChange={setOpen}
              container={frame}
              inline={inline}
              kicker="$HARAMBE · Epoch 12"
              title="Where should $1,284 go?"
              meta="Closes in 2d 14h · your weight 0.04%"
              options={BALLOT}
              value={choice}
              onValueChange={setChoice}
              onVote={(o) => {
                setVoted(o.org);
                setOpen(false);
              }}
            />
          </>
        )}
      </Phone>
    </DemoNav.Provider>
  );
}

function ActivityScreen() {
  const tokens = useTokens();
  const coin = tokens[0]!;
  const reduced = usePrefersReducedMotion();
  const { open, inline, setOpen } = usePreviewSheet();
  const trades = useSampleStream(!reduced, 10, 30);
  return (
    <DemoNav.Provider value={() => undefined}>
      <Phone label="Trades and holders">
        {(frame) => (
          <>
            <MobileHeader homeHref="#m-discover" LinkComponent={DemoLink} privacy="private" wallet={connect} title="Harambe's Wish" />
            <div className="flex flex-col gap-3 px-4 pt-4">
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element -- static Swarm export, like the library's own images */}
                <img src={coin.art?.src} alt="" className="size-14 rounded-2xl bg-sage-tint object-contain" />
                <div className="flex flex-col">
                  <strong className="font-display text-xl">Harambe&apos;s Wish</strong>
                  <span className="text-[13px]">
                    <span className="num">$0.00000412</span> <PriceChange value={18.42} className="text-[13px]" />
                  </span>
                </div>
              </div>
              <TradeTicker trades={trades} limit={6} />
              {!open ? (
                <Button size="lg" className="h-13" onClick={() => setOpen(true)}>
                  Trades and holders
                </Button>
              ) : null}
            </div>
            {open && inline ? <div aria-hidden="true" className="absolute inset-0 z-40 bg-ink/40" onClick={() => setOpen(false)} /> : null}
            <MobileTradesSheet
              open={open}
              onOpenChange={setOpen}
              container={frame}
              inline={inline}
              symbol="$HARAMBE"
              name="Harambe's Wish"
              trades={trades}
              holders={SAMPLE_HOLDERS}
              totalHolders={3_402}
              insights={SAMPLE_INSIGHTS}
            />
          </>
        )}
      </Phone>
    </DemoNav.Provider>
  );
}

function LaunchScreen() {
  const { open, inline, setOpen } = usePreviewSheet();
  const [pair, setPair] = useState("NVDAon");
  const [status, setStatus] = useState("");
  const chosen = [...PAIRS_CRYPTO, ...PAIRS_STOCKS].find((p) => p.symbol === pair) ?? PAIRS_STOCKS[0]!;
  return (
    <DemoNav.Provider value={() => undefined}>
      <Phone label="Launch, step 3">
        {(frame) => (
          <>
            <header className="flex flex-col gap-2.5 border-b border-line bg-paper-card px-4 pb-4 pt-5">
              <ol aria-label="Launch progress" className="m-0 grid list-none grid-cols-6 gap-1.5 p-0">
                {["Name", "Art", "Pair", "Cause", "Giving", "Review"].map((s, i) => (
                  <li key={s} aria-current={i === 2 ? "step" : undefined} className={i < 3 ? "h-2 rounded-full bg-ink" : "h-2 rounded-full bg-line"}>
                    <span className="sr-only">
                      {s}
                      {i < 2 ? " (done)" : i === 2 ? " (current)" : ""}
                    </span>
                  </li>
                ))}
              </ol>
              <span className="kicker text-xs">Step 3 of 6</span>
              <h3 className="m-0 font-display text-[26px] font-semibold leading-tight">Pair it with crypto or a stock</h3>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-32 pt-4">
              <LiquidityPanel
                quote={{ symbol: chosen.symbol, name: chosen.name, kind: chosen.kind, logo: chosen.logo, description: chosen.depthLabel }}
                poolLiquidity="$0 (seeded at launch)"
                quotePrice={chosen.kind === "crypto" ? "Live" : "$129.48"}
                routeDepth={chosen.depthLabel ?? "—"}
                lpStatus="Locked forever"
                route={`Fees convert your coin → ${chosen.symbol}${chosen.symbol === "USDC" ? "" : " → USDC"} before donation.`}
                warning={chosen.kind !== "crypto" ? true : undefined}
              />
              <Button variant="outline" size="lg" className="h-13" onClick={() => setOpen(true)}>
                Change pair
              </Button>
              <p role="status" className="m-0 min-h-5 text-[13px] text-ink-muted">
                {status}
              </p>
            </div>
            <StickyActionBar
              secondary={{ label: "Back", onClick: () => setStatus("Back to step 2") }}
              primary={{ label: "Next: cause", onClick: () => setStatus(`Paired with ${pair}; next, the cause`) }}
            />
            {open && inline ? <div aria-hidden="true" className="absolute inset-0 z-40 bg-ink/40" onClick={() => setOpen(false)} /> : null}
            <MobilePairPicker
              open={open}
              onOpenChange={setOpen}
              container={frame}
              inline={inline}
              crypto={PAIRS_CRYPTO}
              stocks={PAIRS_STOCKS}
              value={pair}
              onValueChange={setPair}
              onConfirm={(p) => setStatus(`Paired with ${p.symbol}`)}
            />
          </>
        )}
      </Phone>
    </DemoNav.Provider>
  );
}

/* ---------- section ---------- */

export function MobileSection() {
  return (
    <GallerySection
      id="mobile"
      title="Mobile"
      intro="Phone screens built from the mobile components, inside 390 × 844 frames. Each frame is a size container, so the Varada components in it lay out for a phone. Sheets open inside their frame; drag the handles, or use the buttons. Sample data."
    >
      <div className="grid gap-6 [grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr))]">
        <Specimen label="Discover" source="Header, carousel, swipe rows, filters, pull to refresh, tab bar">
          <DiscoverScreen />
        </Specimen>
        <Specimen label="Trade sheet" source="vaul snap points: compact quote, then the full ticket">
          <TradeScreen />
        </Specimen>
        <Specimen label="Vote sheet" source="Ballot list in a drawer with a pinned vote button">
          <VoteScreen />
        </Specimen>
        <Specimen label="Trades and holders" source="Trade tape and holders tabs in a drawer; the tape keeps streaming">
          <ActivityScreen />
        </Specimen>
        <Specimen label="Launch pair picker" source="Crypto and stock tabs in a drawer, sticky Back / Next">
          <LaunchScreen />
        </Specimen>
      </div>
      <p className="m-0 text-sm text-ink-muted">
        Swipe a coin row right to watch it or left to buy; the round actions button does the same from the keyboard. Pull the list down, or use Refresh. The tab bar hides as the
        list scrolls down. In the trade sheet, the token button cycles WETH, WBTC, USDC and NVDAon to show each preset set.
      </p>
    </GallerySection>
  );
}
