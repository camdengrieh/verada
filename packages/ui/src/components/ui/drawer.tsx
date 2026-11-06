"use client";
// Adapted from 21st.dev @wensity/drawer (id 31360): bottom sheet with a grab handle, header block,
// scrolling body and a close corner. Its Base UI foundation (@base-ui/react) and Tabler icons are
// replaced with `vaul` (drag to dismiss, snap points, focus trap) and lucide. The springy entrance,
// staggered sections and snap-point sizing follow 21st.dev @coss.com/drawer (id 11442); the scaled
// background is vaul's own; the deckled "paper" variant is written for Varada.
import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { Drawer as DrawerPrimitive } from "vaul";
import { usePrefersReducedMotion } from "@verada/ui/components/motion/marquee";
import { PaperGrain, Wash } from "@verada/ui/components/varada/watercolour";
import { cn } from "@verada/ui/lib/utils";

/**
 * Mobile-first bottom sheet: drag the handle (or swipe) down to dismiss; Escape also closes it.
 *
 * - `shouldScaleBackground`: the page behind shrinks and rounds like the sheet under the top one.
 *   vaul scales the first `[data-vaul-drawer-wrapper]` in the document, so wrap the app's page
 *   content (not the drawer) once in `<DrawerScaleWrapper>`. Ignored under reduced motion.
 *   `setBackgroundColorOnScale` defaults to false here (vaul would paint the body black).
 * - `snapPoints={[0.45, 1]}` (fractions of the viewport, or px strings like "320px"): the sheet
 *   stops part-way and can be dragged up; the content takes full height automatically.
 * Every other vaul Root prop passes straight through.
 */
export function Drawer({ shouldScaleBackground = false, setBackgroundColorOnScale = false, ...props }: ComponentProps<typeof DrawerPrimitive.Root>) {
  const reduced = usePrefersReducedMotion();
  return (
    <DrawerPrimitive.Root
      data-slot="drawer"
      shouldScaleBackground={shouldScaleBackground && !reduced}
      setBackgroundColorOnScale={setBackgroundColorOnScale}
      {...props}
    />
  );
}

/**
 * What vaul scales when a drawer with `shouldScaleBackground` opens. Wrap the page content once,
 * near the root layout; vaul uses the first wrapper in the document.
 */
export function DrawerScaleWrapper({ className, ...props }: ComponentProps<"div">) {
  return <div data-vaul-drawer-wrapper="" data-slot="drawer-wrapper" className={cn("min-h-full bg-background", className)} {...props} />;
}

export function DrawerTrigger(props: ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

export function DrawerPortal(props: ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

export function DrawerClose(props: ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

export function DrawerOverlay({ className, ...props }: ComponentProps<typeof DrawerPrimitive.Overlay>) {
  return <DrawerPrimitive.Overlay data-slot="drawer-overlay" className={cn("fixed inset-0 z-50 bg-ink/45", className)} {...props} />;
}

/** A deckled (torn cotton-paper) edge as one deterministic path in a 600×14 box. */
const DECKLE_EDGE = (() => {
  let seed = 11;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  let d = "M0 8";
  for (let x = 6; x <= 600; x += 6) d += ` L${x} ${(3 + rand() * 8 - (x % 42 === 0 ? 2 : 0)).toFixed(1)}`;
  return d;
})();
const DECKLE_FILL = `${DECKLE_EDGE} L600 14 L0 14 Z`;

export interface DrawerContentProps extends ComponentProps<typeof DrawerPrimitive.Content> {
  /** The grab bar at the top (also a drag target). */
  showHandle?: boolean;
  /** A 44px close button in the top corner, for people who cannot drag. */
  showCloseButton?: boolean;
  closeLabel?: string;
  /** `paper`: a torn, deckled top edge, paper grain and a watercolour wash behind the header. */
  variant?: "default" | "paper";
  /** Overshoot the slide-in slightly and let the handle and sections settle in after it. */
  spring?: boolean;
}

/** The sheet itself. Needs a `DrawerTitle` (sr-only is fine). */
export function DrawerContent({
  className,
  children,
  showHandle = true,
  showCloseButton = true,
  closeLabel = "Close",
  variant = "default",
  spring = true,
  ...props
}: DrawerContentProps) {
  const paper = variant === "paper";
  return (
    <DrawerPortal>
      <DrawerOverlay />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        data-variant={variant}
        data-spring={spring ? "true" : undefined}
        className={cn(
          "group/drawer fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[88dvh] w-full max-w-xl flex-col rounded-t-3xl border border-b-0 border-line bg-paper-card text-card-foreground shadow-float outline-none",
          "pb-[env(safe-area-inset-bottom)]",
          // Snap points move the sheet by translating it, so it needs its full height up front.
          "data-[vaul-snap-points=true]:h-[96dvh] data-[vaul-snap-points=true]:max-h-[96dvh]",
          // A touch of overshoot on vaul's slide-in (vaul's stylesheet sets the ease; this wins).
          spring && "data-[state=open]:[animation-timing-function:cubic-bezier(0.2,1.18,0.32,1)]!",
          paper && "isolate rounded-t-none border-0",
          className,
        )}
        {...props}
      >
        {paper ? (
          <>
            <svg aria-hidden="true" viewBox="0 0 600 14" preserveAspectRatio="none" className="pointer-events-none absolute inset-x-0 -top-[13px] h-[14px] w-full">
              <path d={DECKLE_FILL} fill="var(--paper-card)" />
              <path d={DECKLE_EDGE} fill="none" stroke="var(--line-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            </svg>
            <Wash
              className={cn(
                "absolute inset-x-0 top-0 -z-10 h-36 w-full opacity-80",
                spring && "motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-90 motion-safe:fill-mode-both motion-safe:delay-150 motion-safe:duration-1000",
              )}
            />
            <PaperGrain className="-z-10" opacity={0.07} />
          </>
        ) : null}
        {showHandle ? (
          <DrawerPrimitive.Handle
            data-slot="drawer-handle"
            className={cn(
              "mt-3 mb-1 h-1.5! w-12! shrink-0 rounded-full! bg-ink-muted/50! opacity-100!",
              spring && "motion-safe:animate-in motion-safe:zoom-in-0 motion-safe:fill-mode-both motion-safe:delay-200 motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.34,1.8,0.64,1)]",
            )}
          />
        ) : null}
        {children}
        {showCloseButton ? (
          <DrawerPrimitive.Close
            data-slot="drawer-close-button"
            aria-label={closeLabel}
            className="absolute top-2 right-2 inline-flex size-11 items-center justify-center rounded-full text-ink-muted transition-colors outline-none hover:bg-sand hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/35"
          >
            <X aria-hidden="true" className="size-5" />
          </DrawerPrimitive.Close>
        ) : null}
      </DrawerPrimitive.Content>
    </DrawerPortal>
  );
}

/** Sections settle in just after the sheet when `spring` is on (the default). */
const SETTLE =
  "group-data-[spring=true]/drawer:motion-safe:animate-in group-data-[spring=true]/drawer:motion-safe:fade-in group-data-[spring=true]/drawer:motion-safe:slide-in-from-bottom-3 group-data-[spring=true]/drawer:motion-safe:fill-mode-both group-data-[spring=true]/drawer:motion-safe:duration-500";

export function DrawerHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="drawer-header" className={cn("flex flex-col gap-1 px-5 pt-2 pb-4 pr-14", SETTLE, "group-data-[spring=true]/drawer:delay-100", className)} {...props} />;
}

/** Scrolling content region; text inside stays selectable while the sheet is draggable. */
export function DrawerBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-body"
      data-vaul-no-drag=""
      className={cn("min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-5 pb-4 select-text", SETTLE, "group-data-[spring=true]/drawer:delay-150", className)}
      {...props}
    />
  );
}

export function DrawerFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="drawer-footer" className={cn("mt-auto flex flex-col gap-2 border-t border-line p-5", SETTLE, "group-data-[spring=true]/drawer:delay-200", className)} {...props} />;
}

export function DrawerTitle({ className, ...props }: ComponentProps<typeof DrawerPrimitive.Title>) {
  return <DrawerPrimitive.Title data-slot="drawer-title" className={cn("font-display text-xl font-semibold leading-tight text-ink", className)} {...props} />;
}

export function DrawerDescription({ className, ...props }: ComponentProps<typeof DrawerPrimitive.Description>) {
  return <DrawerPrimitive.Description data-slot="drawer-description" className={cn("text-sm text-ink-soft", className)} {...props} />;
}
