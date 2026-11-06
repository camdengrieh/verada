import type { ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";

/** Paper card: warm surface, hairline border, 22px corners. `tone="ink"` is the dark callout card. */
export function Card({ className, tone = "paper", ...props }: ComponentProps<"div"> & { tone?: "paper" | "ink" | "sand" }) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-4 rounded-2xl border p-5",
        tone === "paper" && "border-line bg-card text-card-foreground",
        tone === "ink" && "border-transparent bg-ink text-paper",
        tone === "sand" && "border-transparent bg-sand text-ink",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("flex flex-wrap items-start justify-between gap-2", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 data-slot="card-title" className={cn("font-display text-xl font-semibold leading-tight", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="card-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("flex flex-col gap-3", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-footer" className={cn("flex flex-wrap items-center gap-2", className)} {...props} />;
}
