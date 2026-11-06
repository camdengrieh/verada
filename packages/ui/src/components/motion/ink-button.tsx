// Hover effects for Button, adapted from 21st.dev: "wash" from @hyperiux/arrow-fill-button (id 26022,
// a fill that grows from a point until it covers the pill) crossed with @vaib215/wet-paint-button
// (id 4764, paint that reads as wet), "shine" from @klyv-ui/klyv-shimmer-button (id 38278, a sheen
// driven by CSS variables rather than React state) and "magnetic" from
// @mohammadshehadeh/magnetic-button (id 26725). "brush" is written for Varada. Use them through
// `<Button effect="…">`; this file holds the client-side half so button.tsx stays server-safe.
"use client";

import { Slot } from "radix-ui";
import { useId, type ComponentProps, type PointerEvent, type ReactNode } from "react";
import { usePrefersReducedMotion } from "@varada/ui/components/motion/marquee";
import { cn } from "@varada/ui/lib/utils";

/**
 * - `wash`: the hover pigment soaks in from where the pointer entered (or the centre, on keyboard
 *   focus), with the darker edge watercolour gets as it dries, and drains toward where it left.
 * - `brush`: a painted stroke sweeps under the label.
 * - `shine`: a soft paper-gloss sheen crosses the pill once.
 * - `magnetic`: the pill leans up to 8px toward a mouse pointer and springs back.
 * All are aria-hidden decoration and all switch off under prefers-reduced-motion.
 */
export type ButtonEffect = "none" | "wash" | "brush" | "shine" | "magnetic";

type Variant = "primary" | "cause" | "ink" | "outline" | "soft" | "ghost" | "link" | "destructive";

/** The colour each variant soaks to: the same colour its plain hover flips to. */
const PIGMENT: Record<Variant, string> = {
  primary: "var(--terracotta-strong)",
  cause: "var(--sage-ink)",
  ink: "var(--ink-soft)",
  outline: "var(--ochre-tint)",
  soft: "var(--line)",
  ghost: "var(--sand)",
  link: "var(--terracotta-tint)",
  destructive: "var(--terracotta-strong)",
};

/** With `wash` the variant's instant hover fill is held back, so the bleed is what you see. */
const HOLD_HOVER: Record<Variant, string> = {
  primary: "hover:bg-primary",
  cause: "hover:bg-sage",
  ink: "hover:bg-ink",
  outline: "hover:bg-transparent",
  soft: "hover:bg-sand",
  ghost: "hover:bg-transparent",
  link: "",
  destructive: "hover:opacity-100",
};

/** Stroke colour for `brush`; it sits below the glyphs, so it never sits behind label text. */
const BRUSH: Record<Variant, string> = {
  primary: "var(--ochre)",
  cause: "var(--ochre)",
  ink: "var(--terracotta)",
  outline: "var(--terracotta)",
  soft: "var(--terracotta)",
  ghost: "var(--ochre)",
  link: "var(--ochre)",
  destructive: "var(--ochre)",
};

const MAGNET_MAX = 8;

export interface EffectButtonProps extends ComponentProps<"button"> {
  effect: Exclude<ButtonEffect, "none">;
  variant: Variant;
  /** buttonVariants() output for the variant and size. */
  baseClassName: string;
  asChild?: boolean;
}

/** Rendered by Button when `effect` is set. Prefer `<Button effect="wash">` over using it directly. */
export function EffectButton({
  effect,
  variant,
  baseClassName,
  asChild = false,
  className,
  type,
  children,
  onPointerEnter,
  onPointerMove,
  onPointerLeave,
  ...props
}: EffectButtonProps) {
  const reduced = usePrefersReducedMotion();
  const filterId = `ink-${useId().replace(/:/g, "")}`;
  const live = !reduced;

  // Pointer positions are written to CSS custom properties: pointer moves fire far more often than
  // React needs to re-render, and only the compositor reads them.
  const place = (event: PointerEvent<HTMLElement>) => {
    const node = event.currentTarget;
    const rect = node.getBoundingClientRect();
    node.style.setProperty("--ink-x", `${event.clientX - rect.left}px`);
    node.style.setProperty("--ink-y", `${event.clientY - rect.top}px`);
  };
  const pull = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== "mouse") return;
    const node = event.currentTarget;
    const rect = node.getBoundingClientRect();
    const clamp = (n: number) => Math.max(-MAGNET_MAX, Math.min(MAGNET_MAX, n));
    const dx = clamp((event.clientX - (rect.left + rect.width / 2)) * 0.22);
    const dy = clamp((event.clientY - (rect.top + rect.height / 2)) * 0.32);
    node.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`;
  };

  let layers: ReactNode = null;
  if (live && effect === "wash") {
    const pigment = PIGMENT[variant];
    layers = (
      <>
        <InkFilter id={filterId} scale={12} />
        <span
          aria-hidden="true"
          data-slot="button-effect"
          className="pointer-events-none absolute -z-10 aspect-square w-[340%] -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full opacity-0 transition-[scale,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover/btn:scale-100 group-hover/btn:opacity-100 group-focus-visible/btn:scale-100 group-focus-visible/btn:opacity-100 motion-reduce:hidden"
          style={{
            left: "var(--ink-x, 50%)",
            top: "var(--ink-y, 50%)",
            background: `radial-gradient(circle closest-side, ${pigment} 0 64%, color-mix(in oklab, ${pigment} 82%, var(--ink)) 71%, transparent 75%)`,
            filter: `url(#${filterId})`,
          }}
        />
      </>
    );
  } else if (live && effect === "brush") {
    layers = (
      <>
        <InkFilter id={filterId} scale={5} frequency={0.08} />
        <svg
          aria-hidden="true"
          focusable="false"
          data-slot="button-effect"
          viewBox="0 0 200 14"
          preserveAspectRatio="none"
          className="pointer-events-none absolute bottom-[10%] left-[10%] -z-10 h-[22%] w-[80%] overflow-visible motion-reduce:hidden"
        >
          <path
            d="M4 9 C 50 3, 120 13, 196 6"
            pathLength={1}
            fill="none"
            stroke={BRUSH[variant]}
            strokeWidth={9}
            strokeLinecap="round"
            opacity={0.75}
            filter={`url(#${filterId})`}
            className="[stroke-dasharray:1] [stroke-dashoffset:1] transition-[stroke-dashoffset] duration-500 ease-[cubic-bezier(0.65,0,0.35,1)] group-hover/btn:[stroke-dashoffset:0] group-focus-visible/btn:[stroke-dashoffset:0]"
          />
        </svg>
      </>
    );
  } else if (live && effect === "shine") {
    layers = (
      <span
        aria-hidden="true"
        data-slot="button-effect"
        className="pointer-events-none absolute inset-y-[-20%] left-0 -z-10 w-1/3 -translate-x-[150%] skew-x-[-18deg] bg-paper-card/45 blur-[6px] group-hover/btn:translate-x-[360%] group-hover/btn:transition-[translate] group-hover/btn:duration-700 group-hover/btn:ease-[cubic-bezier(0.4,0,0.2,1)] group-focus-visible/btn:translate-x-[360%] group-focus-visible/btn:transition-[translate] group-focus-visible/btn:duration-700 motion-reduce:hidden"
      />
    );
  }

  const handlers = {
    onPointerEnter: (e: PointerEvent<HTMLButtonElement>) => {
      onPointerEnter?.(e);
      if (live && effect === "wash") place(e);
    },
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
      onPointerMove?.(e);
      if (live && effect === "magnetic") pull(e);
    },
    onPointerLeave: (e: PointerEvent<HTMLButtonElement>) => {
      onPointerLeave?.(e);
      if (live && effect === "wash") place(e);
      if (effect === "magnetic") e.currentTarget.style.transform = "";
    },
  };

  const classes = cn(
    baseClassName,
    "group/btn relative isolate",
    live && effect !== "magnetic" && "overflow-hidden",
    live && effect === "wash" && HOLD_HOVER[variant],
    live && effect === "magnetic" && "duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
    className,
  );

  if (asChild) {
    return (
      <Slot.Root data-slot="button" data-effect={effect} className={classes} {...handlers} {...props}>
        <Slot.Slottable>{children}</Slot.Slottable>
        {layers}
      </Slot.Root>
    );
  }
  return (
    <button data-slot="button" data-effect={effect} type={type ?? "button"} className={classes} {...handlers} {...props}>
      {children}
      {layers}
    </button>
  );
}

/** A tiny turbulence + displacement filter that roughens an edge like pigment on cotton paper. */
function InkFilter({ id, scale, frequency = 0.035 }: { id: string; scale: number; frequency?: number }) {
  return (
    <svg aria-hidden="true" focusable="false" width="0" height="0" className="pointer-events-none absolute">
      <filter id={id} x="-10%" y="-10%" width="120%" height="120%">
        <feTurbulence type="fractalNoise" baseFrequency={frequency} numOctaves={2} seed={4} />
        <feDisplacementMap in="SourceGraphic" scale={scale} />
      </filter>
    </svg>
  );
}
