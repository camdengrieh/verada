"use client";
// Adapted from 21st.dev @kuratlielia/hover-card (id 35045): half-second open delay, short close grace
// so the pointer can travel into the card, and a grow-from-trigger entry. Rebuilt on Radix HoverCard
// (its CSS module, motion tokens and shared-card store are not included).
import { HoverCard as HoverCardPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";

/**
 * Read-only preview (a creator, a cause, a token) on hover or keyboard focus. Keep anything
 * actionable behind the trigger itself; touch users never see hover cards.
 */
export function HoverCard({ openDelay = 500, closeDelay = 140, ...props }: ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" openDelay={openDelay} closeDelay={closeDelay} {...props} />;
}

export function HoverCardTrigger(props: ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />;
}

export function HoverCardContent({ className, align = "start", sideOffset = 8, ...props }: ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal">
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn(
          "z-50 w-72 origin-(--radix-hover-card-content-transform-origin) rounded-2xl border border-line bg-popover p-4 text-popover-foreground shadow-float outline-none",
          "motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0 motion-safe:data-[state=open]:zoom-in-95 motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:fade-out-0 motion-safe:data-[state=closed]:zoom-out-95",
          "data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1",
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}
