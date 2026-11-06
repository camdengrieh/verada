import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";

/** Small labels: asset kinds (stock, ETF, RWA), giving modes, fees and statuses. */
export const badgeVariants = cva(
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold [&_svg]:size-3.5",
  {
    variants: {
      tone: {
        neutral: "bg-sand text-ink",
        ink: "bg-ink text-paper",
        cause: "bg-sage-tint text-sage-ink",
        live: "bg-terracotta-tint text-terracotta-strong",
        rwa: "bg-ochre-tint text-ochre-ink",
        stock: "bg-stock-tint text-stock-ink",
        etf: "bg-etf-tint text-etf-ink",
        outline: "border border-line bg-transparent text-ink-soft",
      },
      shape: { tag: "", pill: "rounded-full" },
    },
    defaultVariants: { tone: "neutral", shape: "tag" },
  },
);

export interface BadgeProps extends ComponentProps<"span">, VariantProps<typeof badgeVariants> {
  /** Shows a small status dot before the label (e.g. live). */
  dot?: boolean;
}

export function Badge({ className, tone, shape, dot, children, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ tone, shape }), className)} {...props}>
      {dot ? <span aria-hidden="true" className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
