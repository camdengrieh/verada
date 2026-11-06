// Written for Varada
import type { ComponentProps } from "react";
import { cn } from "@verada/ui/lib/utils";
import { CAUSE_SHORT_LABELS, CauseIcon, type CauseName } from "./cause-icon";

export interface CauseChipProps extends ComponentProps<"span"> {
  cause: CauseName;
  /** Overrides the short catalogue label. */
  label?: string;
  /** Focus regions, shown after the label ("Wildlife · Africa, Asia"). */
  regions?: readonly string[];
  size?: "sm" | "md";
  /** `ink` is for chips that sit on the dark cause-pool card. */
  tone?: "tint" | "ink";
}

/** Sage pill naming a coin's cause focus, with its painted icon. */
export function CauseChip({ cause, label, regions, size = "md", tone = "tint", className, ...props }: CauseChipProps) {
  const text = label ?? CAUSE_SHORT_LABELS[cause];
  return (
    <span
      data-slot="cause-chip"
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full font-semibold",
        size === "md" ? "py-[3px] pl-[3px] pr-2.5 text-[13px]" : "py-0.5 pl-0.5 pr-2 text-xs",
        tone === "tint" ? "bg-sage-tint text-sage-ink" : "bg-sage text-paper",
        className,
      )}
      {...props}
    >
      <CauseIcon cause={cause} size={size === "md" ? 22 : 18} decorative />
      <span className="truncate">
        {text}
        {regions?.length ? <span className="font-medium"> · {regions.join(", ")}</span> : null}
      </span>
    </span>
  );
}
