// Written for Varada (pair and liquidity panel from the A-Token board)
import { CircleAlert } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Divider } from "@verada/ui/components/ui/divider";
import { cn } from "@verada/ui/lib/utils";
import { AssetKindBadge } from "./asset-kind-badge";
import type { ImageSource } from "./shared";
import { StockLogo, type QuoteKind } from "./stock-logo";

export interface LiquidityPanelProps extends Omit<ComponentProps<"section">, "children"> {
  quote: {
    symbol: string;
    /** "NVIDIA (Ondo)" */
    name: string;
    kind: QuoteKind;
    logo?: ImageSource;
    /** "Tokenized stock · 18 decimals" */
    description?: string;
  };
  /** All formatted. */
  poolLiquidity: string;
  quotePrice: string;
  routeDepth: string;
  /** "Locked forever" */
  lpStatus: string;
  /** "Fees convert $HARAMBE → NVDAon → USDC before donation." */
  route?: ReactNode;
  /**
   * Market-closed (or other) warning. Pass `true` for the default stale-price note, or your own
   * text, e.g. with the next open time.
   */
  warning?: ReactNode | true;
}

/**
 * The quote asset a coin trades against, its pool depth and how fees reach USDC. A size container:
 * the stats are one column under 256px, two up to 576px and four in a row from there.
 */
export function LiquidityPanel({ quote, poolLiquidity, quotePrice, routeDepth, lpStatus, route, warning, className, ...props }: LiquidityPanelProps) {
  const stats: [string, ReactNode, boolean][] = [
    ["Pool liquidity", poolLiquidity, true],
    [`${quote.symbol} price`, quotePrice, true],
    ["Route to USDC depth", routeDepth, true],
    ["LP", lpStatus, false],
  ];
  return (
    <section aria-label="Pair and liquidity" data-slot="liquidity-panel" className={cn("@container flex flex-col gap-3 rounded-[26px] border border-line bg-card p-5", className)} {...props}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-[14px] border border-line bg-paper-card">
          <StockLogo symbol={quote.symbol} kind={quote.kind} src={quote.logo?.src} srcSet={quote.logo?.srcSet} size={32} decorative />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <strong className="text-base @2xs:truncate">
            {quote.symbol} · {quote.name}
          </strong>
          {quote.description ? <span className="text-[13px] text-ink-muted">{quote.description}</span> : null}
        </div>
        <AssetKindBadge kind={quote.kind} className="@max-3xs:ml-14 @3xs:ml-auto" />
      </div>
      <dl className="m-0 grid grid-cols-1 gap-2.5 @3xs:grid-cols-2 @xl:grid-cols-4">
        {stats.map(([k, v, mono]) => (
          <div key={k} className="min-w-0 rounded-xl bg-paper p-2.5">
            <dt className="text-xs text-ink-muted">{k}</dt>
            <dd className={cn("m-0 font-semibold break-words", mono && "num")}>{v}</dd>
          </div>
        ))}
      </dl>
      {route ? (
        <>
          <Divider variant="dashed" />
          <p className="m-0 text-[13px] text-ink-soft">{route}</p>
        </>
      ) : null}
      {warning ? (
        <div role="note" className="flex gap-2 rounded-xl bg-terracotta-tint px-3 py-2.5 text-[13px] text-terracotta-strong">
          <CircleAlert aria-hidden="true" className="mt-px size-[18px] shrink-0" />
          <span>
            {warning === true
              ? `US market closed. ${quote.symbol} prices can be stale until the next open; large trades may get a worse rate.`
              : warning}
          </span>
        </div>
      ) : null}
    </section>
  );
}
