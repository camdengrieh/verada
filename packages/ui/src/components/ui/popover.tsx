"use client";
// shadcn/ui new-york, Direction A styling
import { Popover as PopoverPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";

/** Small interactive panel anchored to a trigger (slippage settings, share menus). */
export function Popover(props: ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

export function PopoverTrigger(props: ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

export function PopoverAnchor(props: ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

export function PopoverClose(props: ComponentProps<typeof PopoverPrimitive.Close>) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

export function PopoverContent({ className, align = "center", sideOffset = 8, ...props }: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn(
          "z-50 w-80 max-w-[calc(100vw-1.5rem)] origin-(--radix-popover-content-transform-origin) rounded-2xl border border-line bg-popover p-4 text-popover-foreground shadow-float outline-none",
          "motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0 motion-safe:data-[state=open]:zoom-in-95 motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:fade-out-0 motion-safe:data-[state=closed]:zoom-out-95",
          "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

/** Optional heading row for a popover. */
export function PopoverHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="popover-header" className={cn("mb-3 flex flex-col gap-1", className)} {...props} />;
}

export function PopoverTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 data-slot="popover-title" className={cn("font-display text-lg font-semibold leading-tight", className)} {...props} />;
}

export function PopoverDescription({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="popover-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
