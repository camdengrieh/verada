// shadcn/ui new-york, Direction A styling
import type { ComponentProps } from "react";
import { cn } from "@verada/ui/lib/utils";

/**
 * Loading placeholder in sand. Decorative: mark the loading region with `aria-busy` and give it a
 * text alternative (e.g. an sr-only "Loading tokens…"). The pulse stops under reduced motion.
 */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("rounded-lg bg-sand motion-safe:animate-pulse", className)}
      {...props}
    />
  );
}
