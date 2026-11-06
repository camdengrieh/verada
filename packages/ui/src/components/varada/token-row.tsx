// Written for Varada (compact row from the A-Mobile board)
"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "@varada/ui/lib/utils";
import { CauseIcon } from "./cause-icon";
import { PriceChange } from "./price-change";
import { DefaultLink, WASH_FILL, type LinkComponent } from "./shared";
import { StockLogo } from "./stock-logo";
import type { TokenSummary } from "./token-card";

export type TokenRowData = Pick<TokenSummary, "name" | "symbol" | "art" | "wash" | "change24h" | "quote" | "cause" | "marketCap" | "raised">;

export interface TokenRowProps extends Omit<ComponentProps<"article">, "children"> {
  token: TokenRowData;
  href: string;
  LinkComponent?: LinkComponent;
  /** Controls at the end of the row (e.g. a watchlist toggle). They stay clickable above the row link. */
  trailing?: ReactNode;
}

/**
 * Compact coin row for mobile lists and watchlists. The whole row is the link (the name's link is
 * stretched over it), so it is one tab stop with a 64px+ target.
 *
 * A size container: under 288px the art shrinks to 48px; from 512px (a desktop watchlist) market cap
 * and the raised total move into their own right-hand columns.
 */
export function TokenRow({ token: t, href, LinkComponent = DefaultLink, trailing, className, ...props }: TokenRowProps) {
  return (
    <article
      data-slot="token-row"
      className={cn(
        "@container relative flex items-center gap-3 rounded-[20px] border border-line bg-card p-3 transition-colors focus-within:border-line-strong hover:bg-paper-card hover:shadow-paper",
        className,
      )}
      {...props}
    >
      {t.art ? (
        <img
          src={t.art.src}
          srcSet={t.art.srcSet}
          sizes={t.art.sizes ?? "64px"}
          alt=""
          width={64}
          height={64}
          loading="lazy"
          className={cn("size-12 shrink-0 rounded-2xl object-contain @2xs:size-16", WASH_FILL[t.wash ?? "sage"])}
        />
      ) : (
        <span aria-hidden="true" className={cn("size-12 shrink-0 rounded-2xl @2xs:size-16", WASH_FILL[t.wash ?? "sage"])} />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <LinkComponent
            href={href}
            className="truncate font-display text-base font-semibold text-ink no-underline after:absolute after:inset-0 after:rounded-[20px] after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring @2xs:text-[17px]"
          >
            {t.name}
            <span className="sr-only"> (${t.symbol})</span>
          </LinkComponent>
          <PriceChange value={t.change24h} className="shrink-0 text-[13px]" />
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
          <StockLogo symbol={t.quote.symbol} kind={t.quote.kind} src={t.quote.logo?.src} srcSet={t.quote.logo?.srcSet} size={16} decorative />
          <span className="truncate">
            ${t.symbol} / {t.quote.symbol}
            <span className="@lg:hidden">
              {" "}
              · MCap <span className="num">{t.marketCap}</span>
            </span>
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-xs font-medium text-sage-ink @lg:hidden">
          <CauseIcon cause={t.cause} size={18} decorative />
          <span>
            <span className="num">{t.raised}</span> raised
          </span>
        </div>
      </div>
      <dl className="m-0 hidden shrink-0 grid-cols-[5.5rem_6.5rem] gap-3 text-right @lg:grid">
        <div className="flex flex-col">
          <dt className="text-xs text-ink-muted">MCap</dt>
          <dd className="num m-0 text-sm font-semibold">{t.marketCap}</dd>
        </div>
        <div className="flex flex-col items-end">
          <dt className="inline-flex items-center gap-1 text-xs text-sage-ink">
            <CauseIcon cause={t.cause} size={16} decorative />
            Raised
          </dt>
          <dd className="num m-0 text-sm font-semibold text-sage-ink">{t.raised}</dd>
        </div>
      </dl>
      {trailing ? <div className="relative z-10 flex shrink-0 items-center">{trailing}</div> : null}
    </article>
  );
}
