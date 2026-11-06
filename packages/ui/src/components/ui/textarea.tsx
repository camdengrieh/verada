// shadcn/ui new-york, Direction A styling
import type { ComponentProps } from "react";
import { controlClasses } from "@verada/ui/components/ui/input";
import { cn } from "@verada/ui/lib/utils";

/** Multi-line text. Grows with its content (field-sizing) from a 96px minimum. */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(controlClasses, "field-sizing-content min-h-24 px-3.5 py-3 leading-relaxed", className)}
      {...props}
    />
  );
}
