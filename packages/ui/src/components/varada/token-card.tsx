// Written for Varada (Direction A discover card, from the A-Discover board)
"use client";

import { useId, type ComponentProps } from "react";
import { Button, buttonVariants } from "@varada/ui/components/ui/button";
import { Divider } from "@varada/ui/components/ui/divider";
import { cn } from "@varada/ui/lib/utils";
import { CauseChip } from "./cause-chip";
import type { CauseName } from "./cause-icon";
import { ModeBadge, type GivingMode } from "./mode-badge";
import { PairChip } from "./pair-chip";
import { PriceChange } from "./price-change";
import { DefaultLink, WASH_FILL, WASH_PIGMENT, type ImageSource, type LinkComponent, type WashTone } from "./shared";
import type { QuoteKind } from "./stock-logo";
import { Wash } from "./watercolour";

export interface TokenSummary {
  name: string;
  /** Ticker without the dollar sign. */
  symbol: string;
  /** `<label>.varada.eth` */
  ens: string;
  /** Coin art, cut out on a transparent ground (ready URL). */
  art?: ImageSource;
  artAlt?: string;
  wash?: WashTone;
  giving: GivingMode;
  /** 24h change in percent; null when the coin has not traded in the window (shows a dash). */
  change24h: number | null;
  quote: { symbol: string; kind: QuoteKind; logo?: ImageSource };
  cause: CauseName;
  /** Overrides the cause chip's text ("3 causes", "Any cause") when the focus is not a single category. */
  causeLabel?: string;
  /** Formatted money ("$412K"). */
  marketCap: string;
  volume24h: string;
  liquidity: string;
  /** Raised for causes, formatted, and progress towards the card's goal (0–100). */
  raised: string;
  raisedPct: number;
}

export interface TokenCardProps extends Omit<ComponentProps<"article">, "children"> {
  token: TokenSummary;
  /** Token page URL; the name and Details link go here. */
  href: string;
  onBuy?: () => void;
  LinkComponent?: LinkComponent;
  /** Eager-load the art (first row above the fold). */
  priority?: boolean;
}

/**
 * Discover-grid card: painted art on a wash, mode, change, pair and cause, stats, raised bar, actions.
 * A size container: under 288px the stats fold to two columns and the art band shortens; from 576px
 * (a wide list or a feature slot) the art moves to the left of the details.
 */
export function TokenCard({ token: t, href, onBuy, LinkComponent = DefaultLink, priority, className, ...props }: TokenCardProps) {
  const wash = t.wash ?? "sage";
  const pct = Math.min(100, Math.max(0, t.raisedPct));
  const headingId = `token-${useId().replace(/:/g, "")}`;
  return (
    <article
      aria-labelledby={headingId}
      data-slot="token-card"
      className={cn(
        "@container overflow-hidden rounded-[24px] border border-line bg-card transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-paper motion-reduce:hover:translate-y-0",
        className,
      )}
      {...props}
    >
      <div className="flex h-full flex-col @xl:flex-row">
        <div className={cn("relative h-28 shrink-0 overflow-hidden @2xs:h-32 @xl:h-auto @xl:min-h-48 @xl:w-[40%]", WASH_FILL[wash])}>
          <Wash
            className="absolute inset-0 size-full opacity-60"
            blobs={[
              { cx: 420, cy: 120, rx: 200, ry: 70, color: WASH_PIGMENT[wash], opacity: 0.3 },
              { cx: 160, cy: 60, rx: 140, ry: 50, color: "var(--ochre)", opacity: 0.18 },
            ]}
          />
          {t.art ? (
            <img
              src={t.art.src}
              srcSet={t.art.srcSet}
              sizes={t.art.sizes ?? "140px"}
              alt={t.artAlt ?? ""}
              loading={priority ? "eager" : "lazy"}
              decoding="async"
              className="absolute bottom-0 right-2.5 h-[108px] w-[124px] object-contain object-bottom @2xs:h-[124px] @2xs:w-[140px] @xl:right-1/2 @xl:h-[78%] @xl:w-[84%] @xl:translate-x-1/2"
            />
          ) : null}
          <ModeBadge giving={t.giving} className="absolute left-3.5 top-3.5 rounded-lg" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3 px-4 pb-4 pt-4 @2xs:px-[18px] @2xs:pb-[18px]">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h3 id={headingId} className="font-display text-xl font-semibold leading-tight @2xs:text-[22px]">
                <LinkComponent href={href} className="rounded-sm text-ink no-underline hover:underline">
                  {t.name}
                </LinkComponent>
              </h3>
              <span className="truncate text-[13px] text-ink-muted">
                ${t.symbol} · {t.ens}
              </span>
            </div>
            <PriceChange value={t.change24h} className="text-[15px]" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <PairChip coinSymbol={t.symbol} quoteSymbol={t.quote.symbol} quoteKind={t.quote.kind} quoteLogo={t.quote.logo} label={t.quote.symbol} quoteOnly />
            <CauseChip cause={t.cause} label={t.causeLabel} />
          </div>
          <Divider variant="dashed" />
          <dl className="m-0 grid grid-cols-2 gap-2 @2xs:grid-cols-3">
            {(
              [
                ["MCap", t.marketCap],
                ["Vol 24h", t.volume24h],
                ["Liquidity", t.liquidity],
              ] as const
            ).map(([k, v], i) => (
              <div key={k} className={cn("min-w-0", i === 2 && "@max-2xs:col-span-2")}>
                <dt className="text-xs text-ink-muted">{k}</dt>
                <dd className="num m-0 truncate text-[15px] font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-[13px]">
              <span className="text-ink-soft">Raised for causes</span>
              <strong className="num">{t.raised}</strong>
            </div>
            <div
              role="progressbar"
              aria-label={`Raised for causes, ${pct}% of goal`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="h-2 overflow-hidden rounded-full bg-sand"
            >
              <div className="h-full rounded-full bg-sage" style={{ width: `${pct}%` }} />
            </div>
          </div>
          <div className="mt-auto flex gap-2 pt-1 @xl:max-w-sm">
            <Button className="flex-1" onClick={onBuy} aria-label={`Buy $${t.symbol}`}>
              Buy
            </Button>
            <LinkComponent href={href} aria-label={`Details for ${t.name}`} className={cn(buttonVariants({ variant: "outline" }), "@max-3xs:px-3.5")}>
              Details
            </LinkComponent>
          </div>
        </div>
      </div>
    </article>
  );
}
