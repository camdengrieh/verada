// shadcn/ui new-york, Direction A styling
import type { ComponentProps } from "react";
import { cn } from "@verada/ui/lib/utils";

/**
 * Shared control chrome for inputs, textareas and select triggers: card surface, strong hairline,
 * 14px corners, a terracotta focus border with a soft ring, and a destructive state driven by
 * `aria-invalid` (set by `FieldControl`).
 */
export const controlClasses =
  "w-full min-w-0 rounded-lg border border-input bg-paper-card text-[15px] text-ink transition-[border-color,box-shadow] outline-none placeholder:text-ink-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/25";

/** Text input. 44px tall by default; `inputMode="decimal"` + `className="num"` for amounts. */
export function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      type={type}
      className={cn(
        controlClasses,
        "h-11 px-3.5 file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-semibold file:text-ink",
        className,
      )}
      {...props}
    />
  );
}

/**
 * An input with leading or trailing addons (a token ticker, a unit, an icon). The group draws the
 * border and focus ring; the `Input` inside drops its own chrome.
 */
export function InputGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      className={cn(
        "flex h-11 w-full items-center gap-2 rounded-lg border border-input bg-paper-card px-3.5 transition-[border-color,box-shadow]",
        "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25",
        "has-[[aria-invalid=true]]:border-destructive has-[[aria-invalid=true]]:focus-within:ring-destructive/25",
        "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
        "[&>input]:h-full [&>input]:rounded-none [&>input]:border-0 [&>input]:bg-transparent [&>input]:px-0 [&>input]:ring-0 [&>input]:focus-visible:ring-0",
        className,
      )}
      {...props}
    />
  );
}

/** Static text or an icon at either end of an `InputGroup`. */
export function InputAddon({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="input-addon"
      className={cn("flex shrink-0 items-center gap-1 text-sm font-semibold text-ink-muted [&_svg]:size-4", className)}
      {...props}
    />
  );
}
