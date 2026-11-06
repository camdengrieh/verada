// Written for Varada
import { Badge, type BadgeProps } from "@verada/ui/components/ui/badge";
import type { QuoteKind } from "./stock-logo";

const KIND: Record<QuoteKind, { tone: NonNullable<BadgeProps["tone"]>; label: string; title: string }> = {
  stock: { tone: "stock", label: "STOCK", title: "Tokenized stock" },
  etf: { tone: "etf", label: "ETF", title: "Tokenized ETF" },
  rwa: { tone: "rwa", label: "RWA", title: "Real-world asset" },
  crypto: { tone: "neutral", label: "CRYPTO", title: "Crypto asset" },
};

export interface AssetKindBadgeProps extends Omit<BadgeProps, "tone" | "children"> {
  kind: QuoteKind;
}

/** What a coin is paired with: an Ondo stock or ETF, another RWA, or plain crypto (WETH). */
export function AssetKindBadge({ kind, ...props }: AssetKindBadgeProps) {
  const k = KIND[kind];
  return (
    <Badge tone={k.tone} title={k.title} {...props}>
      {k.label}
    </Badge>
  );
}
