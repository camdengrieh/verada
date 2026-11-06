// Adapted from 21st.dev @haydenbleasel/ticker (id 19171) for the logo / name / price header and
// @8starlabs/partition-bar (id 26545) for the reserves split. Liquidity blocks from the A-Token board.
// Reworked for every quote kind: a quiet meta line instead of an uppercase kind chip, dividers between
// blocks, and container queries so the stat grid widens with the card rather than the viewport.
import { ArrowRight, CircleAlert, CircleCheck, CircleX } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Divider } from "@verada/ui/components/ui/divider";
import { cn } from "@verada/ui/lib/utils";
import { LiquidityMeter, formatUsdCompact, type LiquidityThresholds } from "./liquidity-meter";
import { MarketStatus, formatNewYorkTime, isPriceStale, usMarketSession, type MarketSessionInfo } from "./market-status";
import { PriceChange } from "./price-change";
import { PriceImpactLadder } from "./price-impact-ladder";
import {
  AlwaysOpen,
  DEFAULT_MIN_ROUTE_DEPTH,
  KIND_TONE,
  QuoteAssetIdentity,
  feeRouteHops,
  followsUsSession,
  formatAssetPrice,
  isDirectUsdc,
  launchability,
  type QuoteAsset,
} from "./quote-asset";

export interface QuoteAssetCardProps extends Omit<ComponentProps<"section">, "children"> {
  asset: QuoteAsset;
  /** Clock for the session pill (stocks, ETFs, RWAs). */
  now: Date;
  holidays?: readonly string[];
  earlyCloses?: readonly string[];
  /** Session computed once by a parent list. */
  session?: MarketSessionInfo;
  /** The coin being launched or traded, for the route line ("$HARAMBE → NVDAon → USDC"). */
  coinSymbol?: string;
  minDepthUsd?: number;
  thresholds?: LiquidityThresholds;
  /** Impact over which the ladder flags a size (percent, default 3). */
  impactWarnAt?: number;
  /** Buttons or links ("Pair with NVDAon"). */
  action?: ReactNode;
  headingLevel?: 2 | 3 | 4;
}

/** One quote asset in full: price, session (or 24/7), liquidity, route, impact and whether a coin can pair with it. */
export function QuoteAssetCard({
  asset,
  now,
  holidays,
  earlyCloses,
  session,
  coinSymbol,
  minDepthUsd = DEFAULT_MIN_ROUTE_DEPTH,
  thresholds,
  impactWarnAt = 3,
  action,
  headingLevel = 3,
  className,
  ...props
}: QuoteAssetCardProps) {
  const sessioned = followsUsSession(asset.kind);
  const info = session ?? usMarketSession(now, { holidays, earlyCloses });
  const current = asset.paused ? "paused" : info.session;
  const stale = sessioned && isPriceStale(current);
  const launch = launchability(asset, minDepthUsd);
  const hops = feeRouteHops(asset, coinSymbol);
  const direct = isDirectUsdc(asset);
  const reserves = asset.reserves;
  const reserveTotal = reserves ? reserves.base.usd + reserves.quote.usd : 0;
  const basePct = reserveTotal ? Math.round((reserves!.base.usd / reserveTotal) * 100) : 0;

  return (
    <section
      data-slot="quote-asset-card"
      data-kind={asset.kind}
      aria-label={`${asset.symbol}, ${asset.name}`}
      className={cn("@container flex flex-col gap-4 rounded-[26px] border border-line bg-card p-5", className)}
      {...props}
    >
      <header className="flex items-start justify-between gap-3">
        <QuoteAssetIdentity asset={asset} size={44} headingLevel={headingLevel} className="flex-1" />
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
          {asset.price !== undefined ? <span className="num text-lg font-semibold">{formatAssetPrice(asset.price)}</span> : <span className="text-sm text-ink-muted">No price</span>}
          {asset.change24h !== undefined ? <PriceChange value={asset.change24h} decimals={2} showPeriod className="text-[13px]" /> : null}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {sessioned ? <MarketStatus now={now} info={info} paused={asset.paused} /> : <AlwaysOpen />}
      </div>

      {stale ? (
        <p role="note" className="m-0 flex gap-2 rounded-xl bg-ochre-tint px-3 py-2.5 text-[13px] text-ochre-ink">
          <CircleAlert aria-hidden="true" className="mt-px size-[18px] shrink-0" />
          <span>
            {asset.paused
              ? `Ondo has paused ${asset.symbol}. The last price can be stale and fee conversions wait until it resumes.`
              : `US market ${current === "closed" ? "closed" : current === "pre" ? "in pre-market" : "in after-hours"}. ${asset.symbol} prices can be stale${
                  info.next ? ` until ${formatNewYorkTime(info.next)}` : ""
                }; large trades may get a worse rate.`}
          </span>
        </p>
      ) : null}

      <Divider variant="dashed" />

      <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3 @md:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-muted">Pool liquidity</dt>
          <dd className="num m-0 font-semibold">{asset.poolLiquidityUsd ? formatUsdCompact(asset.poolLiquidityUsd) : "None"}</dd>
        </div>
        {asset.volume24hUsd !== undefined ? (
          <div>
            <dt className="text-xs text-ink-muted">24h volume</dt>
            <dd className="num m-0 font-semibold">{formatUsdCompact(asset.volume24hUsd)}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-xs text-ink-muted">Coins paired</dt>
          <dd className="num m-0 font-semibold">{asset.coinsPaired ?? 0}</dd>
        </div>
      </dl>

      {direct ? null : <LiquidityMeter value={asset.routeDepthUsd} label="Route depth to USDC" variant="card" thresholds={thresholds} />}

      {reserves && reserveTotal > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-ink-muted">Pool reserves</span>
          <div
            role="img"
            aria-label={`Reserves: ${basePct}% ${reserves.base.symbol} (${formatUsdCompact(reserves.base.usd)}), ${100 - basePct}% ${reserves.quote.symbol} (${formatUsdCompact(reserves.quote.usd)})`}
            className="flex h-2.5 gap-[3px]"
          >
            <span className="rounded-full bg-stock-ink" style={{ flexBasis: `${basePct}%` }} />
            <span className="flex-1 rounded-full bg-sage" />
          </div>
          <div aria-hidden="true" className="flex justify-between gap-2 text-xs">
            <span className="text-stock-ink">
              <span className="font-semibold">{reserves.base.symbol}</span> <span className="num">{formatUsdCompact(reserves.base.usd)} · {basePct}%</span>
            </span>
            <span className="text-sage-ink">
              <span className="font-semibold">{reserves.quote.symbol}</span> <span className="num">{formatUsdCompact(reserves.quote.usd)} · {100 - basePct}%</span>
            </span>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <span className="text-xs text-ink-muted">{direct ? "Fee route: already USDC" : "Fee route"}</span>
        {hops ? (
          <ol aria-label="Fee route to USDC" className="m-0 flex list-none flex-wrap items-center gap-1 p-0 text-[13px] font-semibold">
            {hops.map((h, i) => (
              <li key={`${h}-${i}`} className="inline-flex items-center gap-1">
                {i > 0 ? <ArrowRight aria-hidden="true" className="size-3.5 text-ink-muted" /> : null}
                <span className={cn("rounded-full px-2 py-0.5", i === 0 ? "bg-sand" : h === "USDC" ? "bg-sage-tint text-sage-ink" : h === asset.symbol ? cn(KIND_TONE[asset.kind].tint, KIND_TONE[asset.kind].ink) : "bg-paper text-ink")}>{h}</span>
              </li>
            ))}
          </ol>
        ) : (
          <span className="text-[13px] font-semibold text-terracotta-strong">No route to USDC</span>
        )}
      </div>

      {asset.impact && asset.impact.length ? (
        <>
          <Divider variant="dashed" />
          <PriceImpactLadder steps={asset.impact} warnAt={impactWarnAt} route={hops ? hops.slice(1).join(" → ") : undefined} />
        </>
      ) : null}

      <div
        data-launchable={launch.ok ? "true" : "false"}
        className={cn("flex gap-2 rounded-xl px-3 py-2.5 text-[13px]", launch.ok ? "bg-sage-tint text-sage-ink" : "bg-terracotta-tint text-terracotta-strong")}
      >
        {launch.ok ? <CircleCheck aria-hidden="true" className="mt-px size-[18px] shrink-0" /> : <CircleX aria-hidden="true" className="mt-px size-[18px] shrink-0" />}
        <span>
          {launch.ok ? (
            <>
              <strong>Launchable.</strong> {direct ? "Fees are USDC already, no conversion needed." : `Fees reach USDC through a route at least ${formatUsdCompact(minDepthUsd)} deep.`}
            </>
          ) : (
            <>
              <strong>Not launchable.</strong> {launch.reason}.
            </>
          )}
        </span>
      </div>

      {action ? <div className="flex flex-wrap gap-2">{action}</div> : null}
    </section>
  );
}
