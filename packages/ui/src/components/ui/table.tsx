// shadcn/ui new-york, Direction A styling
import type { ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";

/**
 * Plain table parts. The wrapper scrolls sideways on narrow screens. Use `className="num text-right"` on numeric cells.
 */
export function Table({ className, ...props }: ComponentProps<"table">) {
  const label = props["aria-label"];
  return (
    // The wrapper scrolls, so a keyboard user must be able to focus it to scroll it. A named table is also a region.
    <div
      data-slot="table-container"
      tabIndex={0}
      role={label ? "region" : undefined}
      aria-label={label}
      className="relative w-full overflow-x-auto rounded-xl outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <table data-slot="table" className={cn("w-full caption-bottom border-collapse text-[15px]", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b [&_tr]:border-line-strong", className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

export function TableFooter({ className, ...props }: ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t border-line-strong bg-sand/60 font-semibold [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn("border-b border-line transition-colors hover:bg-sand/50 data-[state=selected]:bg-sage-tint", className)}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-11 whitespace-nowrap px-3 text-left align-middle text-xs font-semibold uppercase tracking-[0.1em] text-ink-muted [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("whitespace-nowrap px-3 py-3 align-middle text-ink [&:has([role=checkbox])]:pr-0", className)}
      {...props}
    />
  );
}

export function TableCaption({ className, ...props }: ComponentProps<"caption">) {
  return <caption data-slot="table-caption" className={cn("mt-3 text-sm text-muted-foreground", className)} {...props} />;
}
