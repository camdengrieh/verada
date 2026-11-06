// Adapted from 21st.dev @haydenbleasel/ticker (id 19171) for the logo / symbol / price / change header
// and @8starlabs/partition-bar (id 26545) for the reserves split. Liquidity blocks from the A-Token board.
import { ArrowRight, CircleAlert, CircleCheck, CircleX } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@verada/ui/lib/utils";
import { AssetKindBadge } from "./asset-kind-badge";
import { LiquidityMeter, formatUsdCompact, type LiquidityThresholds } from "./liquidity-meter";
import { MarketStatus, formatNewYorkTime, isPriceStale, usMarketSession, type MarketSessionInfo } from "./market-status";
import { PriceChange } from "./price-change";
import { PriceImpactLadder, type ImpactStep } from "./price-impact-ladder";
import type { ImageSource } from "./shared";
import { StockLogo } from "./stock-logo";

/** An Ondo tokenized asset as the explorer and the launch Pair step show it. All data comes from the app. */
export interface OndoAsset {
  /** `NVDAon` */
  symbol: string;
  /** Company or fund name: "NVIDIA", "SPDR S&P 500 ETF Trust". */
  name: string;
  /** Ondo's Stock and ETF; Portfolio and Currency tokens show as RWA. */
  kind: "stock" | "etf" | "rwa";
  logo?: ImageSource;
  /** USD price. */
  price?: number;
  /** 24h change in percent. */
  change24h?: number;
  /** Ondo has paused minting and redemption for this token. */
  paused?: boolean;
  /** Liquidity of the token's own pool, USD. */
  poolLiquidityUsd?: number;
  /** Depth on the route that turns this token into USDC, USD. 0 or missing: no usable route. */
  routeDepthUsd?: number;
  /** The pool's two sides in USD, for the split bar. */
  reserves?: { base: { symbol: string; usd: number }; quote: { symbol: string; usd: number } };
  /** Hops from this token to USDC, starting with the token: ["NVDAon", "WETH", "USDC"]. Empty: no route. */
  route?: readonly string[];
  /** Estimated impact by trade size on that route. */
  impact?: readonly ImpactStep[];
  /** Varada coins already paired with this token. */
  coinsPaired?: number;
  /** Overrides the computed launchability (e.g. the app knows of a compliance block). */
  launchable?: { ok: boolean; reason?: string };
}

export interface Launchability {
  ok: boolean;
  /** Why not, in a sentence fragment ("Route depth $3.1K is under the $10K minimum"). */
  reason?: string;
}

export const DEFAULT_MIN_ROUTE_DEPTH = 10_000;

/** A coin can pair with an asset when fees can reach USDC (a route exists) and that route is deep enough. */
export function launchability(asset: OndoAsset, minDepthUsd = DEFAULT_MIN_ROUTE_DEPTH): Launchability {
  if (asset.launchable) return asset.launchable;
  if (!asset.route || asset.route.length < 2 || !asset.routeDepthUsd) return { ok: false, reason: "No route to USDC" };
  if (asset.routeDepthUsd < minDepthUsd) {
    return { ok: false, reason: `Route depth ${formatUsdCompact(asset.routeDepthUsd)} is under the ${formatUsdCompact(minDepthUsd)} minimum` };
  }
  return { ok: true };
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "$129.48"; prices under $1 keep four decimals. */
export function formatAssetPrice(price: number): string {
  return price < 1 ? `$${price.toFixed(4)}` : usd.format(price);
}

export const ASSET_KIND_NAME: Record<OndoAsset["kind"], string> = { stock: "Tokenized stock", etf: "Tokenized ETF", rwa: "Tokenized asset" };

export interface StockMarketCardProps extends Omit<ComponentProps<"section">, "children"> {
  asset: OndoAsset;
  /** Clock for the session pill. */
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

/** One Ondo asset in full: price, session, liquidity, route, impact and whether a coin can pair with it. */
export function StockMarketCard({
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
}: StockMarketCardProps) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  const info = session ?? usMarketSession(now, { holidays, earlyCloses });
  const current = asset.paused ? "paused" : info.session;
  const stale = isPriceStale(current);
  const launch = launchability(asset, minDepthUsd);
  const hops = asset.route && asset.route.length > 1 ? [coinSymbol ? `$${coinSymbol.replace(/^\$/, "")}` : "Your coin", ...asset.route] : null;
  const reserves = asset.reserves;
  const reserveTotal = reserves ? reserves.base.usd + reserves.quote.usd : 0;
  const basePct = reserveTotal ? Math.round((reserves!.base.usd / reserveTotal) * 100) : 0;

  return (
    <section
      data-slot="stock-market-card"
      aria-label={`${asset.symbol}, ${asset.name}`}
      className={cn("flex flex-col gap-4 rounded-[26px] border border-line bg-card p-5", className)}
      {...props}
    >
      <header className="flex items-start gap-3">
        <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-[14px] border border-line bg-paper-card">
          <StockLogo symbol={asset.symbol} kind={asset.kind} src={asset.logo?.src} srcSet={asset.logo?.srcSet} size={36} decorative />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Heading className="m-0 flex flex-wrap items-center gap-x-2 font-sans text-lg font-semibold leading-tight">
            {asset.symbol}
            <AssetKindBadge kind={asset.kind} />
          </Heading>
          <span className="truncate text-sm text-ink-muted">
            {asset.name} · {ASSET_KIND_NAME[asset.kind]}
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
          {asset.price !== undefined ? <span className="num text-lg font-semibold">{formatAssetPrice(asset.price)}</span> : <span className="text-sm text-ink-muted">No price</span>}
          {asset.change24h !== undefined ? <PriceChange value={asset.change24h} decimals={2} showPeriod className="text-[13px]" /> : null}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <MarketStatus now={now} info={info} paused={asset.paused} />
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

      <div className="flex flex-col gap-3 rounded-2xl bg-paper p-3.5">
        <dl className="m-0 grid grid-cols-2 gap-2.5">
          <div>
            <dt className="text-xs text-ink-muted">Pool liquidity</dt>
            <dd className="num m-0 font-semibold">{asset.poolLiquidityUsd ? formatUsdCompact(asset.poolLiquidityUsd) : "None"}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Coins paired</dt>
            <dd className="num m-0 font-semibold">{asset.coinsPaired ?? 0}</dd>
          </div>
        </dl>
        <LiquidityMeter value={asset.routeDepthUsd} label="Route depth to USDC" variant="card" thresholds={thresholds} />
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
          <span className="text-xs text-ink-muted">Fee route</span>
          {hops ? (
            <ol aria-label="Fee route to USDC" className="m-0 flex list-none flex-wrap items-center gap-1 p-0 text-[13px] font-semibold">
              {hops.map((h, i) => (
                <li key={`${h}-${i}`} className="inline-flex items-center gap-1">
                  {i > 0 ? <ArrowRight aria-hidden="true" className="size-3.5 text-ink-muted" /> : null}
                  <span className={cn("rounded-full px-2 py-0.5", i === 0 ? "bg-sand" : h === asset.symbol ? "bg-stock-tint text-stock-ink" : "bg-sage-tint text-sage-ink")}>{h}</span>
                </li>
              ))}
            </ol>
          ) : (
            <span className="text-[13px] font-semibold text-terracotta-strong">No route to USDC</span>
          )}
        </div>
      </div>

      {asset.impact && asset.impact.length ? <PriceImpactLadder steps={asset.impact} warnAt={impactWarnAt} route={hops ? hops.slice(1).join(" → ") : undefined} /> : null}

      <div
        data-launchable={launch.ok ? "true" : "false"}
        className={cn("flex gap-2 rounded-xl px-3 py-2.5 text-[13px]", launch.ok ? "bg-sage-tint text-sage-ink" : "bg-terracotta-tint text-terracotta-strong")}
      >
        {launch.ok ? <CircleCheck aria-hidden="true" className="mt-px size-[18px] shrink-0" /> : <CircleX aria-hidden="true" className="mt-px size-[18px] shrink-0" />}
        <span>
          {launch.ok ? (
            <>
              <strong>Launchable.</strong> Fees reach USDC through a route at least {formatUsdCompact(minDepthUsd)} deep.
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
