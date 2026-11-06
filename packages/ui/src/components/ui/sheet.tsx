"use client";
// Adapted from 21st.dev @kevingirelli/sheet (id 35214): edge panels with motion-safe slides, a close
// corner and overlay class hook; moved to the unified radix-ui package, Direction A tokens, 44px close.
import { cva } from "class-variance-authority";
import { X } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";

/**
 * A dialog that slides in from an edge: navigation, filters, detail panels. Focus moves in, stays
 * trapped, and returns to the trigger on close; Escape and the overlay close it. It needs a
 * `SheetTitle`. With reduced motion it appears without sliding.
 */
export function Sheet(props: ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

export function SheetTrigger(props: ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

/** Closes the sheet. Wrap a link with `asChild` so following it closes the panel. */
export function SheetClose(props: ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

export function SheetPortal(props: ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

export function SheetOverlay({ className, ...props }: ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-ink/45",
        "motion-safe:data-[state=open]:animate-in data-[state=open]:fade-in-0",
        "motion-safe:data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

const sheetContentVariants = cva(
  [
    "fixed z-50 flex flex-col gap-4 bg-paper-card text-card-foreground shadow-float outline-none",
    "motion-safe:data-[state=open]:animate-in motion-safe:data-[state=closed]:animate-out data-[state=open]:duration-300 data-[state=closed]:duration-200",
  ],
  {
    variants: {
      side: {
        top: "data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top inset-x-0 top-0 h-auto rounded-b-3xl border-b border-line",
        right: "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right inset-y-0 right-0 h-full w-[88%] border-l border-line sm:max-w-md",
        bottom: "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom inset-x-0 bottom-0 h-auto max-h-[90dvh] rounded-t-3xl border-t border-line",
        left: "data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left inset-y-0 left-0 h-full w-[88%] border-r border-line sm:max-w-md",
      },
    },
    defaultVariants: { side: "right" },
  },
);

export type SheetSide = "top" | "right" | "bottom" | "left";

export interface SheetContentProps extends ComponentProps<typeof SheetPrimitive.Content> {
  /** The edge the panel slides in from. */
  side?: SheetSide;
  /** Renders a 44px icon button in the top corner that closes the sheet. */
  showCloseButton?: boolean;
  /** Accessible name of the close button. */
  closeLabel?: string;
  /** Classes for the overlay behind the panel (opacity, blur, z-index). */
  overlayClassName?: string;
}

export function SheetContent({ className, children, side = "right", showCloseButton = true, closeLabel = "Close", overlayClassName, ...props }: SheetContentProps) {
  return (
    <SheetPortal>
      <SheetOverlay className={overlayClassName} />
      <SheetPrimitive.Content data-slot="sheet-content" data-side={side} className={cn(sheetContentVariants({ side }), className)} {...props}>
        {children}
        {showCloseButton ? (
          <SheetPrimitive.Close
            data-slot="sheet-close-button"
            aria-label={closeLabel}
            className="absolute top-3 right-3 inline-flex size-11 items-center justify-center rounded-full text-ink-muted transition-colors outline-none hover:bg-sand hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/35"
          >
            <X aria-hidden="true" className="size-5" />
          </SheetPrimitive.Close>
        ) : null}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

export function SheetHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="sheet-header" className={cn("flex flex-col gap-1.5 p-6 pr-16 pb-0", className)} {...props} />;
}

/** Scrolling middle region between header and footer. */
export function SheetBody({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="sheet-body" className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-6", className)} {...props} />;
}

export function SheetFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="sheet-footer" className={cn("mt-auto flex flex-col gap-2 border-t border-line p-6", className)} {...props} />;
}

/** Names the sheet for screen readers. */
export function SheetTitle({ className, ...props }: ComponentProps<typeof SheetPrimitive.Title>) {
  return <SheetPrimitive.Title data-slot="sheet-title" className={cn("font-display text-2xl font-semibold leading-tight text-ink", className)} {...props} />;
}

/** Read out after the title when the sheet opens. */
export function SheetDescription({ className, ...props }: ComponentProps<typeof SheetPrimitive.Description>) {
  return <SheetPrimitive.Description data-slot="sheet-description" className={cn("text-[15px] text-ink-soft", className)} {...props} />;
}
