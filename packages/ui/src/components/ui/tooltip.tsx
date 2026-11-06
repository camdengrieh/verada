"use client";
// Adapted from 21st.dev @originui/tooltip (id 208): optional arrow, side-aware entry. Ink surface for
// contrast; each Tooltip carries its own provider so no app-level wrapper is required.
import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@verada/ui/lib/utils";

export function TooltipProvider({ delayDuration = 200, ...props }: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />;
}

/**
 * Short, non-interactive hint shown on hover and keyboard focus. Never put the only copy of
 * essential information here; use a Popover for anything interactive.
 */
export function Tooltip(props: ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  );
}

export function TooltipTrigger(props: ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

export function TooltipContent({
  className,
  sideOffset = 6,
  showArrow = true,
  children,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content> & { showArrow?: boolean }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-w-72 origin-(--radix-tooltip-content-transform-origin) rounded-lg bg-ink px-3 py-2 text-sm leading-snug text-paper text-balance",
          "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:fade-out-0 motion-safe:data-[state=closed]:zoom-out-95",
          "data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1",
          className,
        )}
        {...props}
      >
        {children}
        {showArrow ? <TooltipPrimitive.Arrow className="fill-ink" width={12} height={6} /> : null}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
