// Written for Varada
import type { ComponentProps } from "react";
import { cn } from "@verada/ui/lib/utils";
import type { ImageSource } from "./shared";
import { StockLogo, type QuoteKind } from "./stock-logo";

export interface PairChipProps extends ComponentProps<"span"> {
  /** Coin ticker without the dollar sign (`HARAMBE`). */
  coinSymbol: string;
  /** Coin art (ready URL). Omitted, a sand disc stands in. */
  coinImage?: ImageSource;
  quoteSymbol: string;
  quoteKind?: QuoteKind;
  /** Quote logo from the stocks pack; omitted, StockLogo shows its lettered badge. */
  quoteLogo?: ImageSource;
  /** Replaces the "$SYM / QUOTE" text, e.g. "Paired with NVDAon". */
  label?: string;
  /** Leave out the coin art (just the quote logo and label). */
  quoteOnly?: boolean;
}

/** Overlapping coin art and quote logo with "$SYM / NVDAon". */
export function PairChip({ coinSymbol, coinImage, quoteSymbol, quoteKind = "stock", quoteLogo, label, quoteOnly, className, ...props }: PairChipProps) {
  return (
    <span
      data-slot="pair-chip"
      className={cn(
        "inline-flex max-w-full items-center rounded-full border border-line bg-paper-card py-[3px] pl-[3px] pr-3 text-[13px] font-semibold text-ink",
        className,
      )}
      {...props}
    >
      {quoteOnly ? null : coinImage ? (
        <img
          src={coinImage.src}
          srcSet={coinImage.srcSet}
          sizes={coinImage.sizes ?? "26px"}
          alt=""
          aria-hidden="true"
          width={26}
          height={26}
          loading="lazy"
          className="size-[26px] shrink-0 rounded-full bg-sand object-cover"
        />
      ) : (
        <span aria-hidden="true" className="size-[26px] shrink-0 rounded-full bg-sand" />
      )}
      <StockLogo
        symbol={quoteSymbol}
        kind={quoteKind}
        src={quoteLogo?.src}
        srcSet={quoteLogo?.srcSet}
        size={22}
        decorative
        className={cn("ring-2 ring-paper-card", quoteOnly ? "" : "-ml-2")}
      />
      <span className="ml-2 truncate">{label ?? `$${coinSymbol} / ${quoteSymbol}`}</span>
    </span>
  );
}
