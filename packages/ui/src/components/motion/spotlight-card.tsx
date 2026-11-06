"use client";
// Adapted from 21st.dev @kevingirelli/spotlight (id 35180): a soft radial light that follows the
// pointer across a surface, plus a lit edge nearest the pointer, updated through two CSS variables
// so nothing re-renders. Varada version: the light is a pigment bloom (ochre, sage or sky wash on
// paper rather than a glow), the edge picks up the same pigment, and keyboard focus inside shows
// the bloom at the centre. Touch skips it; under reduced motion it stays where it first appears.
import { Slot } from "radix-ui";
import { useEffect, useRef, type ComponentProps, type CSSProperties } from "react";
import { cn } from "@verada/ui/lib/utils";

const RING_MASK = "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)";

export interface SpotlightCardProps extends ComponentProps<"div"> {
  /** Light the single child (e.g. a Card) instead of wrapping it. */
  asChild?: boolean;
  /** Pigment; any CSS colour or token. */
  pigment?: string;
  /** Radius of the bloom, in px. */
  size?: number;
  /** Also tint the edge nearest the pointer. */
  ring?: boolean;
}

const layer = cn(
  "pointer-events-none absolute inset-0 -z-10 rounded-[inherit] opacity-0 transition-opacity duration-500 motion-reduce:transition-none",
  "group-hover/spotlight:opacity-100 group-focus-within/spotlight:opacity-100",
);

/** A surface where pigment blooms under the pointer, for hoverable cards (causes, coins, curators). */
export function SpotlightCard({ asChild = false, pigment = "var(--ochre)", size = 300, ring = true, className, children, onPointerMove, ...props }: SpotlightCardProps) {
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const Comp = asChild ? Slot.Root : "div";
  const circle = `${size}px circle at var(--spot-x, 50%) var(--spot-y, 50%)`;
  const ringStyle: CSSProperties = {
    background: `radial-gradient(${circle}, color-mix(in oklab, ${pigment} 70%, transparent), transparent 60%)`,
    mask: RING_MASK,
    maskComposite: "exclude",
    WebkitMask: RING_MASK,
    WebkitMaskComposite: "xor",
  };
  return (
    <Comp
      data-slot="spotlight-card"
      className={cn("group/spotlight relative isolate", className)}
      onPointerMove={(e) => {
        onPointerMove?.(e);
        if (e.pointerType === "touch") return;
        const el = e.currentTarget;
        const { clientX, clientY } = e;
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => {
          const r = el.getBoundingClientRect();
          el.style.setProperty("--spot-x", `${clientX - r.left}px`);
          el.style.setProperty("--spot-y", `${clientY - r.top}px`);
        });
      }}
      {...props}
    >
      <span
        aria-hidden="true"
        data-slot="spotlight-bloom"
        className={layer}
        style={{ background: `radial-gradient(${circle}, color-mix(in oklab, ${pigment} 22%, transparent), color-mix(in oklab, ${pigment} 8%, transparent) 40%, transparent 70%)` }}
      />
      {ring ? <span aria-hidden="true" data-slot="spotlight-ring" className={cn(layer, "-inset-px p-px")} style={ringStyle} /> : null}
      <Slot.Slottable>{children}</Slot.Slottable>
    </Comp>
  );
}
