"use client";
// Adapted from 21st.dev @isaiahbjork/primitive-sonner (id 27363): a Sonner Toaster themed through CSS
// variables and classNames (no next-themes; Varada tokens already follow the `.dark` class).
import type { CSSProperties, ComponentProps } from "react";
import { Toaster as Sonner, toast } from "sonner";

export { toast };

/**
 * Mount once near the root. Then call `toast("Vote cast", { description })`, `toast.success`,
 * `toast.error` or `toast.promise`, or the transaction toasts in varada/tx-toast (`txToast`).
 * Toasts are announced politely and pause on hover and focus. The house styling applies to Sonner's
 * own toasts only (`data-styled`), so custom cards such as `txToast` bring their own.
 */
export function Toaster({ style, toastOptions, ...props }: ComponentProps<typeof Sonner>) {
  return (
    <Sonner
      className="toaster group"
      position="bottom-right"
      gap={10}
      richColors
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--line-strong)",
          "--success-bg": "var(--sage-tint)",
          "--success-text": "var(--sage-ink)",
          "--success-border": "var(--sage-tint)",
          "--error-bg": "var(--terracotta-tint)",
          "--error-text": "var(--terracotta-strong)",
          "--error-border": "var(--terracotta-tint)",
          "--warning-bg": "var(--ochre-tint)",
          "--warning-text": "var(--ochre-ink)",
          "--warning-border": "var(--ochre-tint)",
          "--info-bg": "var(--stock-tint)",
          "--info-text": "var(--stock-ink)",
          "--info-border": "var(--stock-tint)",
          "--border-radius": "var(--radius-xl)",
          ...style,
        } as CSSProperties
      }
      toastOptions={{
        ...toastOptions,
        classNames: {
          toast: "group toast font-sans! data-[styled=true]:gap-3! data-[styled=true]:px-4! data-[styled=true]:py-3.5! data-[styled=true]:shadow-float!",
          title: "text-[15px]! font-semibold!",
          description: "text-sm! text-ink-soft!",
          actionButton: "h-9! rounded-full! bg-primary! px-3.5! text-sm! font-semibold! text-primary-foreground!",
          cancelButton: "h-9! rounded-full! bg-sand! px-3.5! text-sm! font-semibold! text-ink!",
          closeButton: "border-line! bg-paper-card! text-ink-muted!",
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  );
}
