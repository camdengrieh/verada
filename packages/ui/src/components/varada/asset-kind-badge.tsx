// Written for Varada
import { Badge, type BadgeProps } from "@verada/ui/components/ui/badge";
import { cn } from "@verada/ui/lib/utils";
import type { QuoteKind } from "./stock-logo";

const KIND: Record<QuoteKind, { tone: NonNullable<BadgeProps["tone"]>; label: string; title: string; dot: string }> = {
  stock: { tone: "stock", label: "Stock", title: "Tokenized stock", dot: "bg-sky" },
  etf: { tone: "etf", label: "ETF", title: "Tokenized ETF", dot: "bg-etf-ink" },
  rwa: { tone: "rwa", label: "RWA", title: "Real-world asset", dot: "bg-sage" },
  crypto: { tone: "neutral", label: "Crypto", title: "Crypto asset", dot: "bg-ochre" },
};

export interface AssetKindBadgeProps extends Omit<BadgeProps, "tone" | "children"> {
  kind: QuoteKind;
  /**
   * `quiet` (default): sentence-case word after a tinted dot, no fill, for headers and rows.
   * `tag`: the filled tint, for dense filters and legends.
   */
  variant?: "quiet" | "tag";
}

/** What a coin is paired with: plain crypto (WETH), an Ondo stock or ETF, or another RWA. */
export function AssetKindBadge({ kind, variant = "quiet", className, ...props }: AssetKindBadgeProps) {
  const k = KIND[kind];
  if (variant === "quiet") {
    const { shape: _shape, dot: _dot, ...span } = props;
    return (
      <span
        data-slot="asset-kind-badge"
        data-kind={kind}
        title={k.title}
        className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-ink-soft", className)}
        {...span}
      >
        <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", k.dot)} />
        {k.label}
      </span>
    );
  }
  return (
    <Badge data-kind={kind} tone={k.tone} title={k.title} className={className} {...props}>
      {k.label}
    </Badge>
  );
}
