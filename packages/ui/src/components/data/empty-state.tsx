// Adapted from 21st.dev @cnippet-dev/cnippet-empty (id 19745): media, title, description and actions, stacked-tile icon.
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@verada/ui/lib/utils";

export interface EmptyStateProps extends Omit<ComponentProps<"div">, "title"> {
  /** A lucide icon; shown on the stacked paper tiles. */
  icon?: ReactNode;
  /** Painted art or any larger illustration; replaces the icon tiles. */
  art?: ReactNode;
  title: ReactNode;
  /** One or two plain sentences on what is missing and what to do. */
  body?: ReactNode;
  /** Buttons or links. */
  action?: ReactNode;
  headingLevel?: 2 | 3 | 4;
  /** `compact` for table bodies and side panels. */
  size?: "default" | "compact";
}

/** Nothing-here-yet block: no coins match, no votes cast, empty wallet history. */
export function EmptyState({
  icon,
  art,
  title,
  body,
  action,
  headingLevel = 3,
  size = "default",
  className,
  ...props
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  const tile = "flex size-12 items-center justify-center rounded-xl border border-line bg-paper-card text-ink-soft [&_svg:not([class*='size-'])]:size-5";
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex min-w-0 flex-col items-center justify-center text-center text-balance",
        size === "compact" ? "gap-3 px-4 py-6" : "gap-5 px-6 py-12 md:py-16",
        className,
      )}
      {...props}
    >
      {art ? (
        <div className="max-w-56">{art}</div>
      ) : icon ? (
        <div aria-hidden="true" className="relative mb-1">
          <div className={cn(tile, "absolute bottom-0 origin-bottom-left -translate-x-1 -rotate-10 scale-85 bg-sand")} />
          <div className={cn(tile, "absolute bottom-0 origin-bottom-right translate-x-1 rotate-10 scale-85 bg-sand")} />
          <div className={cn(tile, "relative shadow-paper")}>{icon}</div>
        </div>
      ) : null}
      <div className="flex max-w-sm flex-col items-center gap-1.5">
        <Heading className={cn("font-display font-semibold text-ink", size === "compact" ? "text-lg" : "text-xl")}>{title}</Heading>
        {body ? <div className="text-sm text-muted-foreground [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4">{body}</div> : null}
      </div>
      {action ? <div className="flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}
