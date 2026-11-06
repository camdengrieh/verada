"use client";
// Adapted from 21st.dev @reshaped/reshaped-modal (id 17821): sizes, a mobile bottom-sheet position and
// a dismissible close corner. That component wraps the `reshaped` package, so this is rebuilt on Radix
// Dialog (focus trap, Escape, focus return, scroll lock) with Direction A tokens.
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";

export function Dialog(props: ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

export function DialogTrigger(props: ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

export function DialogPortal(props: ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

export function DialogClose(props: ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

export function DialogOverlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-ink/45",
        "motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0 motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

const dialogContentVariants = cva(
  "fixed z-50 flex max-h-[calc(100dvh-2rem)] w-full flex-col gap-5 overflow-y-auto border border-line bg-paper-card p-6 text-card-foreground shadow-float outline-none motion-safe:data-[state=open]:animate-in motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=open]:fade-in-0 motion-safe:data-[state=closed]:fade-out-0",
  {
    variants: {
      size: { sm: "sm:max-w-sm", md: "sm:max-w-lg", lg: "sm:max-w-2xl" },
      position: {
        center:
          "top-1/2 left-1/2 max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-3xl motion-safe:data-[state=open]:zoom-in-95 motion-safe:data-[state=closed]:zoom-out-95",
        /** Bottom sheet on phones, centred from the `sm` breakpoint up. */
        bottom:
          "inset-x-0 bottom-0 rounded-t-3xl pb-[max(1.5rem,env(safe-area-inset-bottom))] motion-safe:data-[state=open]:slide-in-from-bottom-8 motion-safe:data-[state=closed]:slide-out-to-bottom-8 sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl sm:pb-6",
      },
    },
    defaultVariants: { size: "md", position: "center" },
  },
);

export interface DialogContentProps extends ComponentProps<typeof DialogPrimitive.Content>, VariantProps<typeof dialogContentVariants> {
  /** Renders a 44px close button in the top corner. */
  showCloseButton?: boolean;
  closeLabel?: string;
}

/**
 * Centred modal. Needs a `DialogTitle` (use `className="sr-only"` if the design has no heading).
 * Escape and the overlay close it; focus returns to the trigger.
 */
export function DialogContent({ className, children, size, position, showCloseButton = true, closeLabel = "Close", ...props }: DialogContentProps) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content data-slot="dialog-content" className={cn(dialogContentVariants({ size, position }), className)} {...props}>
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close
            data-slot="dialog-close-button"
            aria-label={closeLabel}
            className="absolute top-3 right-3 inline-flex size-11 items-center justify-center rounded-full text-ink-muted transition-colors outline-none hover:bg-sand hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/35"
          >
            <X aria-hidden="true" className="size-5" />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-1.5 pr-10", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="dialog-footer" className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("font-display text-2xl font-semibold leading-tight text-ink", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn("text-[15px] text-ink-soft", className)} {...props} />;
}
