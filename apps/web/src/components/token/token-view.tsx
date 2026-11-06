"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { getTokenTextRecord, swarmGatewayUrl, TOKEN_TEXT_KEYS } from "@varada/sdk";
import { PullToRefresh } from "@varada/ui/components/mobile/pull-to-refresh";
import { StickyActionBar } from "@varada/ui/components/mobile/sticky-action-bar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@varada/ui/components/ui/tabs";
import { BallotSizeEditor } from "@/components/ballot-size-editor";
import { EditProfilePanel } from "@/components/edit-profile-panel";
import { EpochPanel } from "@/components/epoch-panel";
import { useAppConfig, useDeps } from "@/components/providers";
import { SendDonation } from "@/components/send-donation";
import { ShortlistEditor } from "@/components/shortlist-editor";
import { TakeoverPanel } from "@/components/takeover-panel";
import { sameAddress } from "@/components/use-tx";
import type { Source } from "@/lib/data";
import type { TokenDetail } from "@/lib/indexer";
import { quoteInfo } from "@/lib/quote-info";
import { loadLive } from "@/lib/token-data";
import { formatQuotePrice, formatUsdPrice } from "@/lib/token-market";
import { usdNotes } from "@varada/sdk";
import { useQuoteUsd } from "@/hooks/use-usd-quotes";
import { usdText } from "@/lib/token-view";
import { usdcToUsd } from "@/lib/token-data";
import { factoryAbi } from "@/lib/abis";
import { LiveActivityFeed } from "@/components/discover/live-activity";
import { AboutTab } from "./about-tab";
import { CuratedBy, FeeSplit, LiveSummary, PoolSummary } from "./giving";
import { HoldersTab } from "./holders-tab";
import { ImpactTab } from "./impact-tab";
import { MarketSection, useMarketFigures, useNowSec } from "./market-section";
import { TokenHero } from "./token-hero";
import { TradeAside, TradeSheet, useLiquidityMetric } from "./trade-surface";
import { TradesTab } from "./trades-tab";
import { useHolders, useHolderSummary, useMarket, useTradeTape } from "./use-token-data";
import { useEpochView } from "@/components/epoch-panel";
import { useCatalogNames } from "@/components/catalog-browser";
import { CAUSE_SHORT_LABELS } from "@varada/ui/components/varada/cause-icon";
import { focusCauseNames } from "@/lib/token-data";

const TEXT_KEYS = [TOKEN_TEXT_KEYS.description, TOKEN_TEXT_KEYS.url, TOKEN_TEXT_KEYS.twitter, TOKEN_TEXT_KEYS.telegram, TOKEN_TEXT_KEYS.discord, TOKEN_TEXT_KEYS.github];

/** True when the viewport matches `query`; decided on first render (this tree only renders in the browser). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

function logoUrl(gateway: string | undefined, ref: string | null | undefined): string | null {
  if (!gateway || !ref) return null;
  try {
    return swarmGatewayUrl(gateway, ref);
  } catch {
    return null;
  }
}

/** The profile's text records: the indexer's, or read through ENS when the indexer has none. */
function useProfileTexts(token: TokenDetail, label: string | null, source: Source | undefined): Record<string, string> {
  const config = useAppConfig();
  const deps = useDeps();
  const profile = token.profile;
  const needsChain = Boolean(label) && source === "indexer" && profile !== null && Object.keys(profile.textRecords).length === 0;
  const chainTexts = useQuery({
    queryKey: ["text-records", label, config.ensParentName],
    queryFn: async () => {
      const out: Record<string, string> = {};
      await Promise.all(
        TEXT_KEYS.map(async (key) => {
          const v = await getTokenTextRecord(deps.chain(), label as string, key, config.ensParentName).catch(() => null);
          if (v) out[key] = v;
        }),
      );
      return out;
    },
    enabled: needsChain,
    retry: false,
    staleTime: 60_000,
  });
  return useMemo(() => ({ ...(chainTexts.data ?? {}), ...(profile?.textRecords ?? {}) }), [chainTexts.data, profile?.textRecords]);
}

/** The pool's quote asset before its first trade: the factory records it at launch. */
function useQuoteAddress(token: Address, fromMarket: string | null | undefined): string | null {
  const config = useAppConfig();
  const deps = useDeps();
  const q = useQuery({
    queryKey: ["quote-of", token],
    queryFn: () => deps.chain().readContract({ address: config.factoryAddress as Address, abi: factoryAbi, functionName: "quoteAssetOf", args: [token] }) as Promise<string>,
    enabled: !fromMarket && Boolean(config.factoryAddress),
    retry: false,
    staleTime: 3_600_000,
  });
  return fromMarket ?? (q.data && !/^0x0{40}$/i.test(q.data) ? q.data : null);
}

type TabId = "trades" | "activity" | "holders" | "impact" | "governance" | "about" | "manage";

export function TokenView({ address, token, source }: { address: Address; token: TokenDetail; source: Source | undefined }) {
  const config = useAppConfig();
  const deps = useDeps();
  const qc = useQueryClient();
  const { address: account } = useAccount();
  const nowSec = useNowSec();
  const wide = useMediaQuery("(min-width: 1024px)");
  const tabBarHidden = useMediaQuery("(min-width: 768px)");

  const profile = token.profile;
  const label = profile?.label ?? token.label ?? null;
  const ensName = label ? `${label}.${config.ensParentName}` : null;
  const symbol = token.symbol || "TOKEN";
  const texts = useProfileTexts(token, label, source);
  const logo = logoUrl(config.swarmGatewayUrl, profile?.logoRef ?? token.logoRef);

  const market = useMarket(address);
  const summary = useHolderSummary(address);
  const holders = useHolders(address);
  const live = useQuery({ queryKey: ["token-live", address.toLowerCase()], queryFn: () => loadLive(deps.indexer, address), retry: false, staleTime: 30_000 });
  const quoteAddress = useQuoteAddress(address, market.data?.quote);
  const quote = useMemo(() => quoteInfo(quoteAddress ?? live.data?.quote), [quoteAddress, live.data?.quote]);
  const quoteDecimals = market.data?.quoteDecimals ?? null;
  const tape = useTradeTape(address, { quote: market.data?.quote ?? quoteAddress, decimals: quoteDecimals });
  const epochView = useEpochView(address);

  const figures = useMarketFigures(market.data, address, summary.data, nowSec);
  const feeTotals = token.feeTotals;
  const isLive = Boolean(live.data);
  const raisedUsd = isLive ? usdcToUsd(live.data!.totals.credited) : feeTotals ? usdcToUsd(BigInt(feeTotals.causeAmount)) : source === "indexer" ? 0 : null;
  const sym = quote?.symbol ?? "";
  // USD per quote asset: USDC is $1, WETH and the Ondo assets come from their pools (shared pricing layer).
  const { quote: usdQuote } = useQuoteUsd(quote?.address);
  const perQuote = quote?.usd ? 1 : (usdQuote?.priceUsd ?? null);
  const approx = !quote?.usd && perQuote !== null && Boolean(usdQuote && (usdQuote.confidence !== "high" || usdQuote.marketClosed));
  const heroPrice = figures?.stats.price ?? null;
  const priceNotes = perQuote !== null && !quote?.usd ? usdNotes(usdQuote) : [];
  const heroStats = {
    price: heroPrice != null ? (perQuote !== null ? formatUsdPrice(heroPrice * perQuote, approx) : formatQuotePrice(heroPrice, sym)) : null,
    priceNote: heroPrice != null && perQuote !== null && !quote?.usd ? [formatQuotePrice(heroPrice, sym), ...priceNotes].join(" · ") : undefined,
    change24h: figures?.stats.change24h ?? undefined,
    marketCap:
      figures?.marketCap != null
        ? perQuote !== null
          ? `${approx ? "~" : ""}${usdText(figures.marketCap * perQuote, true)}`
          : `${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(figures.marketCap)} ${sym}`.trim()
        : null,
    holders: summary.data?.holders ?? null,
    raisedUsd,
  };

  const liquidity = useLiquidityMetric(address, symbol);
  // One token in dollars (price in the quote asset times the quote's USD price), for the holders' values.
  const tokenUsd = heroPrice != null && perQuote !== null ? { priceUsd: heroPrice * perQuote, approx } : null;
  const causes = focusCauseNames(token.focus);
  const causeIcon = causes.length === 1 ? causes[0] : undefined;
  const designated = live.data?.designatedCause?.toLowerCase();
  const designatedName = useCatalogNames(designated ? [designated] : []).data?.get(designated ?? "")?.name;
  const causeName = causeIcon ? CAUSE_SHORT_LABELS[causeIcon] : designatedName ?? (live.data ? "the designated cause" : "the cause holders vote for");
  const onSwapped = useCallback(() => {
    const a = address.toLowerCase();
    void qc.invalidateQueries({ predicate: (q) => JSON.stringify(q.queryKey).toLowerCase().includes(a) });
  }, [qc, address]);

  const canManage = sameAddress(account, profile?.controller) || sameAddress(account, profile?.editor);
  const [tab, setTab] = useState<TabId>("trades");
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (tab === "manage" && !canManage) setTab("trades");
  }, [tab, canManage]);
  const showTab = useCallback((id: TabId) => {
    setTab(id);
    tabsRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, []);

  const [sheet, setSheet] = useState(false);
  const openTrade = useCallback(() => {
    if (wide) document.getElementById("trade")?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    else setSheet(true);
  }, [wide]);

  const refresh = useCallback(async () => {
    const a = address.toLowerCase();
    await qc.refetchQueries({ predicate: (q) => JSON.stringify(q.queryKey).toLowerCase().includes(a) });
  }, [qc, address]);

  const body = (
    <div className="flex flex-col gap-6">
      {source === "chain" ? (
        <p role="note" className="m-0 rounded-2xl bg-sand px-4 py-3 text-sm">
          Indexer unreachable; showing data read directly from the chain.
        </p>
      ) : null}
      <TokenHero
        address={address}
        token={token}
        label={label}
        ensName={ensName}
        logoUrl={logo}
        texts={texts}
        live={live.data ?? null}
        quote={quote}
        stats={heroStats}
        onTrade={openTrade}
        tradeLabel={`Buy $${symbol}`}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:grid-rows-[auto_1fr]">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <MarketSection
            address={address}
            symbol={symbol}
            quote={quote}
            market={market.data}
            loading={market.isLoading}
            error={market.error}
            onRetry={() => void market.refetch()}
            summary={summary.data}
            feeTotals={feeTotals}
            trades={tape.trades}
            nowSec={nowSec}
            onTrade={openTrade}
            extraMetrics={liquidity}
            usd={usdQuote}
          />
        </div>

        <aside aria-label="Trade and giving" className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-24 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start">
          <div id="trade" className="scroll-mt-24 empty:hidden">
            {wide ? <TradeAside token={address} symbol={symbol} causeName={causeName} causeIcon={causeIcon} onSwapped={onSwapped} /> : null}
          </div>
          {live.data ? <LiveSummary live={live.data} /> : <PoolSummary token={address} detail={token} onVote={() => showTab("governance")} />}
          <FeeSplit feeTotals={feeTotals} />
        </aside>

        <div ref={tabsRef} className="min-w-0 scroll-mt-24 lg:col-start-1 lg:row-start-2">
          <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)} variant="brush">
            <TabsList scrollable scrollLabels={{ previous: "Earlier tabs", next: "More tabs" }} aria-label="Token sections">
              <TabsTrigger value="trades">Trades</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
              <TabsTrigger value="holders">Holders</TabsTrigger>
              <TabsTrigger value="impact">Impact</TabsTrigger>
              <TabsTrigger value="governance">Governance</TabsTrigger>
              <TabsTrigger value="about">About</TabsTrigger>
              {canManage ? <TabsTrigger value="manage">Manage</TabsTrigger> : null}
            </TabsList>
            <TabsContent value="trades">
              <TradesTab symbol={symbol} quote={quote} quoteDecimals={quoteDecimals} tape={tape} onTrade={openTrade} usd={usdQuote} />
            </TabsContent>
            <TabsContent value="activity">
              <LiveActivityFeed token={address} symbol={symbol} title="Activity" />
            </TabsContent>
            <TabsContent value="holders">
              <HoldersTab symbol={symbol} holders={holders} summary={summary} tokenUsd={tokenUsd} />
            </TabsContent>
            <TabsContent value="impact">
              <ImpactTab token={address} symbol={symbol} live={live.data ?? null} feeTotals={feeTotals} epoch={epochView.data?.epoch} />
            </TabsContent>
            <TabsContent value="governance" className="flex flex-col gap-8">
              <EpochPanel token={address} detail={token} />
              <SendDonation token={address} />
              <CuratedBy focus={token.focus} />
              <TakeoverPanel token={address} controller={profile?.controller ?? null} />
            </TabsContent>
            <TabsContent value="about">
              <AboutTab address={address} token={token} ensName={ensName} label={label} logoUrl={logo} texts={texts} />
            </TabsContent>
            {canManage ? (
              <TabsContent value="manage" className="flex flex-col gap-8">
                <EditProfilePanel token={address} profile={profile} />
                <ShortlistEditor token={address} detail={token} />
                <BallotSizeEditor token={address} detail={token} />
              </TabsContent>
            ) : null}
          </Tabs>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {wide ? body : (
        <PullToRefresh pageScroll onRefresh={refresh} scrollClassName="" labels={{ button: "Refresh token" }}>
          {body}
        </PullToRefresh>
      )}
      {!wide ? (
        <>
          <StickyActionBar
            aboveTabBar={!tabBarHidden}
            primary={{ label: `Trade $${symbol}`, onClick: openTrade }}
            note={heroStats.price ? <span className="num">{heroStats.price}</span> : undefined}
          />
          <TradeSheet token={address} symbol={symbol} causeName={causeName} causeIcon={causeIcon} onSwapped={onSwapped} open={sheet} onOpenChange={setSheet} />
        </>
      ) : null}
    </>
  );
}
