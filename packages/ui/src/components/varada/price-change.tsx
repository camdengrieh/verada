// Written for Varada
import type { ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";

export interface PriceChangeProps extends Omit<ComponentProps<"span">, "children"> {
  /** Change in percent (18.4 means +18.4%). `null` when there is nothing to compare (no trades in the window): shows a dash. */
  value: number | null;
  /** Window named in the screen-reader text and, with `showPeriod`, on screen. */
  period?: string;
  showPeriod?: boolean;
  decimals?: number;
}

export function formatPercent(value: number, decimals = 1): string {
  return `${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}%`;
}

/**
 * ▲ 18.4% in the gain colour or ▼ 4.2% in the loss colour. Direction is carried by the glyph and the
 * screen-reader sentence as well as colour.
 */
export function PriceChange({ value, period = "24h", showPeriod = false, decimals = 1, className, ...props }: PriceChangeProps) {
  if (value === null) {
    return (
      <span data-slot="price-change" data-direction="none" className={cn("num inline-flex items-baseline whitespace-nowrap font-semibold text-ink-muted", className)} {...props}>
        <span aria-hidden="true">–</span>
        <span className="sr-only">No trades in {period}</span>
      </span>
    );
  }
  const rounded = Number(value.toFixed(decimals));
  const dir = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  const pct = formatPercent(rounded, decimals);
  const glyph = dir === "up" ? "▲" : dir === "down" ? "▼" : "–";
  const spoken = dir === "flat" ? `Unchanged in ${period}` : `${dir === "up" ? "Up" : "Down"} ${pct} in ${period}`;
  return (
    <span
      data-slot="price-change"
      data-direction={dir}
      className={cn(
        "num inline-flex items-baseline gap-1 whitespace-nowrap font-semibold",
        dir === "up" && "text-gain",
        dir === "down" && "text-loss",
        dir === "flat" && "text-ink-muted",
        className,
      )}
      {...props}
    >
      <span aria-hidden="true">
        {glyph} {pct}
        {showPeriod ? ` · ${period}` : null}
      </span>
      <span className="sr-only">{spoken}</span>
    </span>
  );
}
