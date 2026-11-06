"use client";

import { useId, type ComponentProps } from "react";
import { cn } from "@verada/ui/lib/utils";

/**
 * Watercolour texture drawn in code (SVG turbulence + displacement), so the painted look costs a few
 * hundred bytes instead of texture images. Purely decorative: aria-hidden and pointer-events off.
 */

export interface WashBlob {
  /** Centre and radii in a 600×200 view box. */
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Any CSS colour; theme tokens work, e.g. "var(--sage)". */
  color: string;
  opacity?: number;
}

const DEFAULT_BLOBS: WashBlob[] = [
  { cx: 150, cy: 100, rx: 130, ry: 60, color: "var(--ochre)", opacity: 0.35 },
  { cx: 310, cy: 90, rx: 120, ry: 55, color: "var(--sky)", opacity: 0.35 },
  { cx: 460, cy: 105, rx: 130, ry: 58, color: "var(--sage)", opacity: 0.3 },
];

export interface WashProps extends Omit<ComponentProps<"svg">, "children"> {
  blobs?: WashBlob[];
  /** Higher = wobblier edges. */
  bleed?: number;
  seed?: number;
}

/** Soft pigment blooms. Position it absolutely behind content (`absolute inset-0 -z-0`). */
export function Wash({ blobs = DEFAULT_BLOBS, bleed = 38, seed = 7, className, ...props }: WashProps) {
  const id = `wash-${useId().replace(/:/g, "")}`;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 600 200"
      preserveAspectRatio="none"
      className={cn("pointer-events-none select-none", className)}
      {...props}
    >
      <defs>
        <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves={4} seed={seed} />
          <feDisplacementMap in="SourceGraphic" scale={bleed} />
          <feGaussianBlur stdDeviation="1.4" />
        </filter>
      </defs>
      <g filter={`url(#${id})`}>
        {blobs.map((b, i) => (
          <ellipse key={i} cx={b.cx} cy={b.cy} rx={b.rx} ry={b.ry} fill={b.color} opacity={b.opacity ?? 0.35} />
        ))}
      </g>
    </svg>
  );
}

/** Fine paper grain over a surface. Put it last inside a `relative` container. */
export function PaperGrain({ className, opacity = 0.06, ...props }: Omit<ComponentProps<"svg">, "children"> & { opacity?: number }) {
  const id = `grain-${useId().replace(/:/g, "")}`;
  return (
    <svg aria-hidden="true" className={cn("pointer-events-none absolute inset-0 size-full", className)} {...props}>
      <filter id={id}>
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={2} seed={3} />
        <feColorMatrix values={`0 0 0 0 0.45  0 0 0 0 0.35  0 0 0 0 0.22  0 0 0 ${opacity} 0`} />
      </filter>
      <rect width="100%" height="100%" filter={`url(#${id})`} />
    </svg>
  );
}

/** A painted underline for a word in a heading. */
export function BrushUnderline({ color = "var(--ochre)", className, ...props }: Omit<ComponentProps<"svg">, "children"> & { color?: string }) {
  const id = `brush-${useId().replace(/:/g, "")}`;
  return (
    <svg aria-hidden="true" viewBox="0 0 300 24" preserveAspectRatio="none" className={cn("pointer-events-none", className)} {...props}>
      <filter id={id}>
        <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves={2} seed={2} />
        <feDisplacementMap in="SourceGraphic" scale={6} />
      </filter>
      <path d="M4 14 C 80 6, 200 22, 296 10" stroke={color} strokeWidth="10" strokeLinecap="round" fill="none" opacity="0.55" filter={`url(#${id})`} />
    </svg>
  );
}
