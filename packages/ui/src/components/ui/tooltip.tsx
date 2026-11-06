"use client";
// Adapted from 21st.dev @originui/tooltip (id 208): optional arrow, side-aware entry. Ink surface for
// contrast; each Tooltip carries its own provider so no app-level wrapper is required.
// The `spring` entry and `followCursor` lean are adapted from @manuarora700/animated-tooltip
// (id 791: springs in, then sways and tilts with the pointer) and @unlumen/floating-tooltip
// (id 25221: velocity-aware spring follow); both rebuilt on Radix so focus, Escape and
// aria-describedby keep working. Tap-to-open on touch is written for Varada.
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform, type MotionValue } from "motion/react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { createContext, useCallback, useContext, useRef, useState, type ComponentProps } from "react";
import { usePrefersReducedMotion } from "@varada/ui/components/motion/marquee";
import { cn } from "@varada/ui/lib/utils";

export function TooltipProvider({ delayDuration = 200, ...props }: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />;
}

interface TooltipCtx {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Pointer position across the trigger, -1 (left edge) to 1 (right edge). */
  pointer: MotionValue<number>;
  /** Set during a touch tap so Radix's own close-on-click doesn't undo the tap. */
  holdRef: { current: boolean };
  wasOpenRef: { current: boolean };
}
const TooltipContext = createContext<TooltipCtx | null>(null);

/**
 * Short, non-interactive hint shown on hover and keyboard focus, and toggled by a tap on touch
 * screens. Escape, a tap outside and scrolling close it. Never put the only copy of essential
 * information here; use a Popover for anything interactive.
 */
export function Tooltip({ open: openProp, defaultOpen = false, onOpenChange, ...props }: ComponentProps<typeof TooltipPrimitive.Root>) {
  const [internal, setInternal] = useState(defaultOpen);
  const open = openProp ?? internal;
  const holdRef = useRef(false);
  const wasOpenRef = useRef(false);
  const pointer = useMotionValue(0);
  const setOpen = useCallback(
    (next: boolean) => {
      if (!next && holdRef.current) return;
      if (openProp === undefined) setInternal(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );
  return (
    <TooltipContext.Provider value={{ open, setOpen, pointer, holdRef, wasOpenRef }}>
      <TooltipProvider>
        <TooltipPrimitive.Root data-slot="tooltip" open={open} onOpenChange={setOpen} {...props} />
      </TooltipProvider>
    </TooltipContext.Provider>
  );
}

export function TooltipTrigger({ onPointerDown, onPointerMove, onClick, ...props }: ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const ctx = useContext(TooltipContext);
  const touch = useRef(false);
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onPointerDown={(e) => {
        touch.current = e.pointerType === "touch" || e.pointerType === "pen";
        if (ctx) ctx.wasOpenRef.current = ctx.open;
        onPointerDown?.(e);
      }}
      onPointerMove={(e) => {
        if (ctx && e.pointerType === "mouse") {
          const r = e.currentTarget.getBoundingClientRect();
          if (r.width > 0) ctx.pointer.set(Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1)));
        }
        onPointerMove?.(e);
      }}
      onClick={(e) => {
        onClick?.(e);
        if (!ctx || !touch.current) return;
        touch.current = false;
        // A tap toggles. Radix closes on click right after this handler, so hold the close off
        // until the event has finished.
        const next = !ctx.wasOpenRef.current;
        ctx.setOpen(next);
        if (next) {
          ctx.holdRef.current = true;
          window.setTimeout(() => {
            ctx.holdRef.current = false;
          }, 0);
        }
      }}
      {...props}
    />
  );
}

const SURFACE = {
  ink: "rounded-lg bg-ink px-3 py-2 text-sm leading-snug text-paper",
  paper: "rounded-xl border border-line bg-popover p-3 text-sm leading-snug text-popover-foreground shadow-float",
} as const;
const ARROW = { ink: "fill-ink", paper: "fill-popover" } as const;

export interface TooltipContentProps extends ComponentProps<typeof TooltipPrimitive.Content> {
  showArrow?: boolean;
  /** `ink` (default) for one-line hints; `paper` for rich content such as a fee breakdown. */
  tone?: keyof typeof SURFACE;
  /** `fade` (default) is the CSS fade and zoom; `spring` pops in on a spring, like a dab of paint. */
  animation?: "fade" | "spring";
  /** Sway and tilt with a mouse pointer moving across the trigger (implies `spring`). */
  followCursor?: boolean;
}

/** Entry offset per side; horizontal motion is left to `followCursor`. */
const OFFSET = { top: 8, bottom: -8, left: 0, right: 0 } as const;

export function TooltipContent({
  className,
  sideOffset = 6,
  showArrow = true,
  tone = "ink",
  animation = "fade",
  followCursor = false,
  side = "top",
  children,
  ...props
}: TooltipContentProps) {
  const ctx = useContext(TooltipContext);
  const reduced = usePrefersReducedMotion();
  const fallback = useMotionValue(0);
  const pointer = ctx?.pointer ?? fallback;
  const sway = useSpring(useTransform(pointer, [-1, 1], [-28, 28]), { stiffness: 160, damping: 14 });
  const tilt = useSpring(useTransform(pointer, [-1, 1], [-7, 7]), { stiffness: 160, damping: 12 });
  const surface = cn("z-50 max-w-72 text-balance", SURFACE[tone]);
  const arrow = showArrow ? <TooltipPrimitive.Arrow className={ARROW[tone]} width={12} height={6} /> : null;

  if ((animation === "spring" || followCursor) && ctx && !reduced) {
    const from = OFFSET[side];
    return (
      <AnimatePresence>
        {ctx.open ? (
          <TooltipPrimitive.Portal key="tooltip" forceMount>
            <TooltipPrimitive.Content forceMount asChild data-slot="tooltip-content" side={side} sideOffset={sideOffset} {...props}>
              <motion.div
                className={cn("origin-(--radix-tooltip-content-transform-origin)", surface, className)}
                initial={{ opacity: 0, scale: 0.6, y: from }}
                animate={{ opacity: 1, scale: 1, y: 0, transition: { type: "spring", stiffness: 300, damping: 14 } }}
                exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.12 } }}
                style={followCursor ? { x: sway, rotate: tilt } : undefined}
              >
                {children}
                {arrow}
              </motion.div>
            </TooltipPrimitive.Content>
          </TooltipPrimitive.Portal>
        ) : null}
      </AnimatePresence>
    );
  }

  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        side={side}
        sideOffset={sideOffset}
        className={cn(
          "origin-(--radix-tooltip-content-transform-origin)",
          surface,
          "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:fade-out-0 motion-safe:data-[state=closed]:zoom-out-95",
          "data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1",
          className,
        )}
        {...props}
      >
        {children}
        {arrow}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
