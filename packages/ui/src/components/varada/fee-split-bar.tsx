// Written for Varada
import type { ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";

export interface FeeSplitBarProps extends Omit<ComponentProps<"div">, "children"> {
  /** Share of each trading fee that goes to charity, in percent. The rest is the platform's. */
  causeShare?: number;
  /** Optional money amounts, already formatted ("$28.11"). */
  causeAmount?: string;
  platformAmount?: string;
  causeLabel?: string;
  platformLabel?: string;
  /** Drop the legend (just the bar, with its accessible label). */
  compact?: boolean;
}

/** The 90/10 split of every trading fee: sage to the cause, ochre to the platform. */
export function FeeSplitBar({
  causeShare = 90,
  causeAmount,
  platformAmount,
  causeLabel = "to the cause",
  platformLabel = "platform",
  compact,
  className,
  ...props
}: FeeSplitBarProps) {
  const cause = Math.min(100, Math.max(0, causeShare));
  const platform = 100 - cause;
  const spoken =
    `${cause}% ${causeLabel}${causeAmount ? ` (${causeAmount})` : ""}, ` +
    `${platform}% ${platformLabel}${platformAmount ? ` (${platformAmount})` : ""}`;
  return (
    <div data-slot="fee-split-bar" className={cn("flex flex-col gap-2", className)} {...props}>
      <div role="img" aria-label={`Fee split: ${spoken}`} className="flex h-3.5 gap-0.5 overflow-hidden rounded-full">
        <span className="h-full rounded-l-full bg-sage" style={{ flexGrow: cause }} />
        <span className="h-full rounded-r-full bg-ochre" style={{ flexGrow: platform }} />
      </div>
      {compact ? null : (
        <div aria-hidden="true" className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm text-ink-soft">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-sage" />
            <strong className="num text-ink">{cause}%</strong> {causeLabel}
            {causeAmount ? <span className="num font-semibold text-sage-ink">{causeAmount}</span> : null}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-ochre" />
            <strong className="num text-ink">{platform}%</strong> {platformLabel}
            {platformAmount ? <span className="num font-semibold text-ochre-ink">{platformAmount}</span> : null}
          </span>
        </div>
      )}
    </div>
  );
}
