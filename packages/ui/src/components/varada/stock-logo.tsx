// Written for Varada
"use client";

import { useState } from "react";
import { cn } from "@verada/ui/lib/utils";

export type QuoteKind = "stock" | "etf" | "rwa" | "crypto";

export interface StockLogoProps {
  /** Ondo symbol (`NVDAon`) or quote asset (`WETH`). */
  symbol: string;
  /** Ready URL from the stocks pack (`stockLogo(cfg, symbol)`); absent until the pack is published. */
  src?: string;
  srcSet?: string;
  /** Rendered size in CSS px. */
  size?: number;
  /** Picks the fallback badge colours. */
  kind?: QuoteKind;
  /** Hidden from assistive tech when the symbol is already written next to it. */
  decorative?: boolean;
  /** Accessible name when not decorative; defaults to "<symbol> logo". */
  alt?: string;
  className?: string;
}

/** The letters a fallback badge shows: the ticker without Ondo's `on` suffix, first two letters. */
export function stockLogoLetters(symbol: string): string {
  const base = symbol.replace(/on$/, "").replace(/^\$/, "");
  return (base || symbol).slice(0, 2).toUpperCase();
}

const FALLBACK_TONE: Record<QuoteKind, string> = {
  stock: "bg-stock-tint text-stock-ink",
  etf: "bg-etf-tint text-etf-ink",
  rwa: "bg-ochre-tint text-ochre-ink",
  crypto: "bg-sand text-ink",
};

/**
 * Logo for a quote asset. Shows the pack image when `src` is given and loads; otherwise a lettered
 * badge (`NVDAon` → "NV"), so nothing breaks while the stocks pack isn't published.
 */
export function StockLogo({ symbol, src, srcSet, size = 24, kind = "stock", decorative = false, alt, className }: StockLogoProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const name = alt ?? `${symbol} logo`;
  const showImage = src && failed !== src;
  const box = cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-paper-card", className);
  if (showImage) {
    return (
      <img
        src={src}
        srcSet={srcSet}
        sizes={srcSet ? `${size}px` : undefined}
        width={size}
        height={size}
        alt={decorative ? "" : name}
        aria-hidden={decorative ? true : undefined}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(src)}
        className={cn(box, "object-contain")}
        style={{ width: size, height: size }}
      />
    );
  }
  const letters = stockLogoLetters(symbol);
  return (
    <span
      data-slot="stock-logo-fallback"
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative ? true : undefined}
      className={cn(box, FALLBACK_TONE[kind], "num font-semibold leading-none tracking-tight")}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.38)) }}
    >
      {letters}
    </span>
  );
}
