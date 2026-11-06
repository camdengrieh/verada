"use client";
// Adapted from 21st.dev @jshguo/interfaces-switch (id 11886), Direction A tokens and a 44px hit area.
import { Switch as SwitchPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";

/**
 * On/off setting that applies at once. Off is an ink-muted track (clear against paper); on is
 * terracotta, or sage with `tone="cause"` for giving and voting settings.
 */
export function Switch({
  className,
  tone = "primary",
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root> & { tone?: "primary" | "cause" }) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full p-0.5 outline-none transition-[background-color,box-shadow]",
        "after:absolute after:-inset-x-1 after:-inset-y-2 after:content-['']",
        "data-[state=unchecked]:bg-ink-muted focus-visible:ring-[3px] focus-visible:ring-ring/35 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-2 aria-invalid:ring-destructive",
        tone === "primary" ? "data-[state=checked]:bg-primary" : "data-[state=checked]:bg-sage",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-6 rounded-full bg-paper-card shadow-sm shadow-ink/30 transition-transform duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
      />
    </SwitchPrimitive.Root>
  );
}
