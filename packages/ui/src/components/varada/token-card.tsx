// Written for Varada (Direction A discover card, from the A-Discover board)
"use client";

import { useId, type ComponentProps } from "react";
import { Button, buttonVariants } from "@verada/ui/components/ui/button";
import { cn } from "@verada/ui/lib/utils";
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
  /** 24h change in percent. */
  change24h: number;
  quote: { symbol: string; kind: QuoteKind; logo?: ImageSource };
  cause: CauseName;
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

/** Discover-grid card: painted art on a wash, mode, change, pair and cause, stats, raised bar, actions. */
export function TokenCard({ token: t, href, onBuy, LinkComponent = DefaultLink, priority, className, ...props }: TokenCardProps) {
  const wash = t.wash ?? "sage";
  const pct = Math.min(100, Math.max(0, t.raisedPct));
  const headingId = `token-${useId().replace(/:/g, "")}`;
  return (
    <article
      aria-labelledby={headingId}
      className={cn(
        "flex flex-col overflow-hidden rounded-[24px] border border-line bg-card transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-paper motion-reduce:hover:translate-y-0",
        className,
      )}
      {...props}
    >
      <div className={cn("relative h-32 overflow-hidden", WASH_FILL[wash])}>
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
            className="absolute bottom-0 right-2.5 h-[124px] w-[140px] object-contain object-bottom"
          />
        ) : null}
        <ModeBadge giving={t.giving} className="absolute left-3.5 top-3.5 rounded-lg" />
      </div>
      <div className="flex flex-1 flex-col gap-3 px-[18px] pb-[18px] pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 id={headingId} className="font-display text-[22px] font-semibold leading-tight">
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
          <CauseChip cause={t.cause} />
        </div>
        <dl className="m-0 grid grid-cols-3 gap-2">
          {(
            [
              ["MCap", t.marketCap],
              ["Vol 24h", t.volume24h],
              ["Liquidity", t.liquidity],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="min-w-0">
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
        <div className="mt-auto flex gap-2 pt-1">
          <Button className="flex-1" onClick={onBuy} aria-label={`Buy $${t.symbol}`}>
            Buy
          </Button>
          <LinkComponent href={href} aria-label={`Details for ${t.name}`} className={buttonVariants({ variant: "outline" })}>
            Details
          </LinkComponent>
        </div>
      </div>
    </article>
  );
}
