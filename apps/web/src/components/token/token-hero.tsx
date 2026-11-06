"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useAssetUrl } from "@varada/ui/lib/assets";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { ExternalLink } from "@varada/ui/components/ui/icons";
import { AssetKindBadge } from "@varada/ui/components/varada/asset-kind-badge";
import { CauseChip } from "@varada/ui/components/varada/cause-chip";
import { ensLimoUrl } from "@varada/ui/components/varada/ens-shared";
import { HeroToken } from "@varada/ui/components/varada/hero-token";
import { LogoMark } from "@varada/ui/components/varada/logo-mark";
import { MarketStatus } from "@varada/ui/components/varada/market-status";
import { PairChip } from "@varada/ui/components/varada/pair-chip";
import { regionLabel } from "@/components/catalog-browser";
import { useAppConfig } from "@/components/providers";
import { quoteAssetLogo } from "@/lib/asset-packs";
import type { TokenDetail } from "@/lib/indexer";
import { US_MARKET_EARLY_CLOSES, US_MARKET_HOLIDAYS, type QuoteInfo } from "@/lib/quote-info";
import { focusCauseNames, type LiveView } from "@/lib/token-data";
import { profileLinks } from "@/lib/token-view";
import { REGIONS } from "@varada/sdk";

export interface HeroStatsInput {
  /** Formatted price in the quote asset ("0.00004213 WETH"), or null before the first trade. */
  price: string | null;
  change24h: number | undefined;
  /** Market cap text in the quote asset, or null when price or supply is unknown. */
  marketCap: string | null;
  holders: number | null;
  /** Dollars of fees credited to causes since launch; null when the indexer has no totals. */
  raisedUsd: number | null;
}

/** A clock that ticks once a minute, for the market-open pill. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function TokenLogo({ url, symbol, size }: { url: string | null; symbol: string; size: number }) {
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    // A Swarm gateway URL chosen by the operator; it is not a bundled asset, so next/image does not apply.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={`${symbol || "Token"} logo`} width={size} height={size} referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-full object-contain" />;
  }
  return <LogoMark size={size} decorative />;
}

/** Quote asset pair, kind and (for Ondo assets) market-open state. */
export function PairStrip({ quote, symbol, logoUrl }: { quote: QuoteInfo; symbol: string; logoUrl: string | null }) {
  const config = useAppConfig();
  const resolve = useAssetUrl();
  const now = useNow();
  const logo = quoteAssetLogo(config, quote.symbol, resolve, 32);
  return (
    <>
      <PairChip coinSymbol={symbol} coinImage={logoUrl ? { src: logoUrl } : undefined} quoteSymbol={quote.symbol} quoteKind={quote.kind} quoteLogo={logo} />
      <AssetKindBadge kind={quote.kind} />
      {quote.ondo ? <MarketStatus now={now} holidays={US_MARKET_HOLIDAYS} earlyCloses={US_MARKET_EARLY_CLOSES} size="sm" /> : null}
    </>
  );
}

export function TokenHero({
  address,
  token,
  label,
  ensName,
  logoUrl,
  texts,
  live,
  quote,
  stats,
  onTrade,
  tradeLabel,
}: {
  address: string;
  token: TokenDetail;
  label: string | null;
  ensName: string | null;
  logoUrl: string | null;
  texts: Readonly<Record<string, string>>;
  live: LiveView | null;
  quote: QuoteInfo | null;
  stats: HeroStatsInput;
  /** Opens the trade ticket (scrolls to it on desktop, opens the sheet on a phone). Absent: no trade action. */
  onTrade?: () => void;
  tradeLabel: string;
}) {
  const symbol = token.symbol || "TOKEN";
  const focus = token.focus;
  const causes = focusCauseNames(focus);
  const main = causes[0];
  const rest = causes.slice(1);
  const regions = focus && focus.regions.length > 0 && focus.regions.length < REGIONS.length ? focus.regions.map(regionLabel) : undefined;
  const links = profileLinks(texts);

  const extra: ReactNode = (
    <>
      {rest.map((c) => (
        <CauseChip key={c} cause={c} />
      ))}
      {quote ? <PairStrip quote={quote} symbol={symbol} logoUrl={logoUrl} /> : null}
    </>
  );

  const statList = [
    ...(stats.marketCap ? [{ label: "Market cap", value: stats.marketCap }] : []),
    ...(stats.raisedUsd !== null ? [{ label: "Raised for causes", value: stats.raisedUsd, format: { style: "currency", currency: "USD", maximumFractionDigits: 2 } as Intl.NumberFormatOptions, live: true }] : []),
    ...(stats.holders !== null ? [{ label: "Holders", value: stats.holders }] : []),
  ];

  return (
    <div className="flex flex-col gap-3">
      <HeroToken
        headingLevel={1}
        name={token.name || symbol}
        symbol={symbol}
        ens={ensName ?? `${address.slice(0, 6)}…${address.slice(-4)}`}
        siteHref={label && ensName ? ensLimoUrl(ensName) : undefined}
        art={<TokenLogo url={logoUrl} symbol={symbol} size={256} />}
        price={stats.price ?? "No trades yet"}
        change24h={stats.price ? stats.change24h : undefined}
        cause={main}
        causeRegions={regions}
        extraChips={extra}
        giving={live ? { mode: "live", cadence: live.cadence ?? "24h" } : { mode: "weekly" }}
        wash={live ? "sky" : "sage"}
        tagline={texts.description}
        actions={onTrade ? [{ label: tradeLabel, onClick: onTrade, effect: "wash" }] : []}
        stats={statList}
      />
      {links.length > 0 ? (
        <ul aria-label="Links" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-sm">
          {links.map((l) => (
            <li key={l.key} className="flex min-w-0 items-center gap-1.5">
              <span className="text-ink-muted">{l.label}</span>
              {l.href ? (
                <a href={l.href} rel="noreferrer noopener" className="inline-flex min-w-0 items-center gap-1 truncate font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
                  <span className="truncate">{l.text}</span>
                  <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
                </a>
              ) : (
                <span className="truncate text-ink">{l.text}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function TokenHeroSkeleton({ title = "Loading token" }: { title?: string }) {
  return (
    <div role="status" aria-label={title} className="grid gap-6 rounded-[32px] border border-line bg-card p-5 @lg:grid-cols-[15rem_1fr] sm:p-7">
      {/* The page has no other heading until the token loads. */}
      <h1 className="sr-only">{title}</h1>
      <Skeleton className="mx-auto aspect-square w-full max-w-[15rem] rounded-[28px]" />
      <div className="flex flex-col gap-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-12 w-3/4" />
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-11 w-40" />
      </div>
    </div>
  );
}
