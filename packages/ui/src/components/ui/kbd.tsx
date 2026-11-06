// shadcn/ui new-york, Direction A styling
import type { ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";

/** A keyboard key, e.g. <Kbd>⌘</Kbd><Kbd>K</Kbd>. */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-6 min-w-6 select-none items-center justify-center gap-1 rounded-md border border-line-strong bg-paper-card px-1.5 font-mono text-xs font-medium text-ink-soft shadow-[0_1px_0_var(--line-strong)] [&_svg]:size-3",
        className,
      )}
      {...props}
    />
  );
}

/** Groups keys of one shortcut with a small gap. */
export function KbdGroup({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="kbd-group" className={cn("inline-flex items-center gap-1", className)} {...props} />;
}
