"use client";

import { useState, type ComponentProps } from "react";
import { useAssetUrl } from "@verada/ui/lib/assets";
import { cn } from "@verada/ui/lib/utils";

/** Shape of an entry in apps/web's generated asset manifest (ASSETS in assets.generated.ts). */
export interface RasterAssetEntry {
  width: number;
  height: number;
  avif?: readonly number[];
  webp?: readonly number[];
  blur?: string;
}

export interface PaintedImageProps extends Omit<ComponentProps<"img">, "src" | "srcSet" | "width" | "height"> {
  /** Manifest key, e.g. "scenes/harambe-v1". Files live at assets/<key>-<width>.<format>. */
  name: string;
  asset: RasterAssetEntry;
  /** The `sizes` attribute; defaults to full width. */
  sizes?: string;
  /** Eager-load art above the fold. */
  priority?: boolean;
  alt: string;
}

/**
 * Responsive art from the asset pipeline: AVIF first, WebP fallback, explicit dimensions so the
 * layout doesn't jump, and the inline blur placeholder (when the asset has one) until it loads.
 */
export function PaintedImage({ name, asset, sizes = "100vw", priority, alt, className, style, onLoad, ...props }: PaintedImageProps) {
  const url = useAssetUrl();
  const [loaded, setLoaded] = useState(false);
  const set = (format: "avif" | "webp") =>
    asset[format]?.map((w) => `${url(`assets/${name}-${w}.${format}`)} ${w}w`).join(", ");
  const webp = asset.webp ?? [];
  const avif = asset.avif ?? [];
  const fallbackWidth = webp[webp.length - 1] ?? avif[avif.length - 1];
  const fallbackFormat = webp.length ? "webp" : "avif";
  return (
    <picture>
      {avif.length ? <source type="image/avif" srcSet={set("avif")} sizes={sizes} /> : null}
      {webp.length ? <source type="image/webp" srcSet={set("webp")} sizes={sizes} /> : null}
      <img
        src={url(`assets/${name}-${fallbackWidth}.${fallbackFormat}`)}
        width={asset.width}
        height={asset.height}
        alt={alt}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        fetchPriority={priority ? "high" : undefined}
        onLoad={(e) => {
          setLoaded(true);
          onLoad?.(e);
        }}
        className={cn("h-auto max-w-full", className)}
        style={{
          ...(asset.blur && !loaded ? { backgroundImage: `url(${asset.blur})`, backgroundSize: "cover" } : null),
          ...style,
        }}
        {...props}
      />
    </picture>
  );
}
