"use client";
// Adapted from 21st.dev @wensity/drawer (id 31360): bottom sheet with a grab handle, header block,
// scrolling body and a close corner. Its Base UI foundation (@base-ui/react) and Tabler icons are
// replaced with `vaul` (drag to dismiss, snap points, focus trap) and lucide.
import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { Drawer as DrawerPrimitive } from "vaul";
import { cn } from "@verada/ui/lib/utils";

/** Mobile-first bottom sheet: drag the handle (or swipe) down to dismiss; Escape also closes it. */
export function Drawer({ shouldScaleBackground = false, ...props }: ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root data-slot="drawer" shouldScaleBackground={shouldScaleBackground} {...props} />;
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

export interface DrawerContentProps extends ComponentProps<typeof DrawerPrimitive.Content> {
  /** The grab bar at the top (also a drag target). */
  showHandle?: boolean;
  /** A 44px close button in the top corner, for people who cannot drag. */
  showCloseButton?: boolean;
  closeLabel?: string;
}

/** The sheet itself. Needs a `DrawerTitle` (sr-only is fine). */
export function DrawerContent({ className, children, showHandle = true, showCloseButton = true, closeLabel = "Close", ...props }: DrawerContentProps) {
  return (
    <DrawerPortal>
      <DrawerOverlay />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[88dvh] w-full max-w-xl flex-col rounded-t-3xl border border-b-0 border-line bg-paper-card text-card-foreground shadow-float outline-none",
          "pb-[env(safe-area-inset-bottom)]",
          className,
        )}
        {...props}
      >
        {showHandle ? <DrawerPrimitive.Handle data-slot="drawer-handle" className="mt-3 mb-1 h-1.5! w-12! shrink-0 rounded-full! bg-ink-muted/50! opacity-100!" /> : null}
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

export function DrawerHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="drawer-header" className={cn("flex flex-col gap-1 px-5 pt-2 pb-4 pr-14", className)} {...props} />;
}

/** Scrolling content region; text inside stays selectable while the sheet is draggable. */
export function DrawerBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-body"
      data-vaul-no-drag=""
      className={cn("min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-5 pb-4 select-text", className)}
      {...props}
    />
  );
}

export function DrawerFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="drawer-footer" className={cn("mt-auto flex flex-col gap-2 border-t border-line p-5", className)} {...props} />;
}

export function DrawerTitle({ className, ...props }: ComponentProps<typeof DrawerPrimitive.Title>) {
  return <DrawerPrimitive.Title data-slot="drawer-title" className={cn("font-display text-xl font-semibold leading-tight text-ink", className)} {...props} />;
}

export function DrawerDescription({ className, ...props }: ComponentProps<typeof DrawerPrimitive.Description>) {
  return <DrawerPrimitive.Description data-slot="drawer-description" className={cn("text-sm text-ink-soft", className)} {...props} />;
}
