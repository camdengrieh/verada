"use client";
// Adapted from 21st.dev @originui/radio-group (id 747), including its card layout as RadioCard;
// Direction A tokens and a 44px hit area.
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@varada/ui/lib/utils";

/** Arrow keys move between options; name the group with `aria-label` or `aria-labelledby`. */
export function RadioGroup({ className, ...props }: ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root data-slot="radio-group" className={cn("grid gap-3", className)} {...props} />;
}

export function RadioGroupItem({
  className,
  tone = "primary",
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Item> & { tone?: "primary" | "cause" }) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "peer relative aspect-square size-5 shrink-0 rounded-full border-[1.5px] border-ink-muted bg-paper-card outline-none transition-[border-color,box-shadow]",
        "after:absolute after:-inset-3 after:content-['']",
        "focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        tone === "primary" ? "data-[state=checked]:border-primary text-primary" : "data-[state=checked]:border-sage text-sage",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator data-slot="radio-group-indicator" className="flex items-center justify-center">
        <span className="size-2.5 rounded-full bg-current motion-safe:animate-in motion-safe:zoom-in-50" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

/**
 * A whole-card option: the radio sits in the corner and the card outline turns to the tone colour
 * when chosen. The card is the label, so clicking anywhere selects it.
 */
export function RadioCard({
  value,
  id,
  title,
  description,
  tone = "primary",
  disabled,
  className,
  children,
}: {
  value: string;
  id: string;
  title: ReactNode;
  description?: ReactNode;
  tone?: "primary" | "cause";
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <label
      htmlFor={id}
      data-slot="radio-card"
      className={cn(
        "relative flex cursor-pointer items-start gap-3 rounded-xl border-[1.5px] border-line bg-paper-card p-4 transition-colors hover:bg-sand/40",
        tone === "primary"
          ? "has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-terracotta-tint/40"
          : "has-[[data-state=checked]]:border-sage has-[[data-state=checked]]:bg-sage-tint/50",
        "has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/30 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
        className,
      )}
    >
      <span className="grid grow gap-1">
        <span className="font-semibold text-ink">{title}</span>
        {description ? (
          <span id={`${id}-description`} className="text-sm text-ink-soft">
            {description}
          </span>
        ) : null}
        {children}
      </span>
      <RadioGroupItem
        id={id}
        value={value}
        tone={tone}
        disabled={disabled}
        aria-describedby={description ? `${id}-description` : undefined}
        className="mt-0.5"
      />
    </label>
  );
}
