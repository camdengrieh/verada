import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { EffectButton, type ButtonEffect } from "@verada/ui/components/motion/ink-button";
import { cn } from "@verada/ui/lib/utils";

export type { ButtonEffect };

/**
 * Pill buttons from Direction A. `primary` is terracotta (trade, launch), `cause` is sage (voting,
 * giving), `outline` is the ink-bordered secondary, `soft` the sand-filled tertiary. Every size
 * keeps a 44px touch target except `sm`, which is for dense rows on pointer devices.
 */
export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full font-semibold transition-[background-color,color,box-shadow,transform] disabled:pointer-events-none disabled:opacity-50 active:translate-y-px [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-terracotta-strong",
        cause: "bg-sage text-[#f7f3e8] hover:bg-sage-ink dark:text-paper",
        ink: "bg-ink text-paper hover:bg-ink-soft",
        outline: "border-[1.5px] border-ink bg-transparent text-ink hover:bg-sand",
        soft: "bg-sand text-ink hover:bg-line",
        ghost: "bg-transparent text-ink hover:bg-sand",
        link: "rounded-none text-primary underline-offset-4 hover:underline",
        destructive: "bg-destructive text-destructive-foreground hover:opacity-90",
      },
      size: {
        sm: "h-9 px-3.5 text-sm",
        md: "h-11 px-5 text-[15px]",
        lg: "h-13 px-6 text-base",
        icon: "size-11",
        "icon-sm": "size-9",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  /** Render the child element (e.g. an anchor) with button styling. */
  asChild?: boolean;
  /**
   * Signature hover effect (see motion/ink-button): `wash` soaks the hover pigment in from the
   * pointer, `brush` paints a stroke under the label, `shine` sweeps a paper sheen across,
   * `magnetic` leans toward the pointer. Decoration only; off under reduced motion. Default `none`
   * renders exactly the plain button.
   */
  effect?: ButtonEffect;
}

export function Button({ className, variant, size, asChild = false, type, effect = "none", ...props }: ButtonProps) {
  if (effect !== "none") {
    return (
      <EffectButton
        effect={effect}
        variant={variant ?? "primary"}
        baseClassName={buttonVariants({ variant, size })}
        className={className}
        asChild={asChild}
        type={type}
        {...props}
      />
    );
  }
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      type={asChild ? undefined : (type ?? "button")}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
