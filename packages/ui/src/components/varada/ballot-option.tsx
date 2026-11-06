// Adapted from 21st.dev @sean0205/c-radio-group-8 (id 28339): radix RadioGroup items as full cards
"use client";

import { Check } from "lucide-react";
import { RadioGroup } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";
import { CAUSE_SHORT_LABELS, CauseIcon, type CauseName } from "./cause-icon";

/** Where an option on a weekly ballot came from. */
export type BallotSource = "pinned" | "curated" | "rotation";

export interface BallotOptionData {
  /** Stable id (the option's catalogue index or org id). */
  id: string;
  /** Charity name. */
  org: string;
  category: CauseName;
  region: string;
  source: BallotSource;
  /** Optional curator score ("94/100"). */
  score?: string;
}

export const SOURCE_LABELS: Record<BallotSource, string> = { pinned: "Pinned", curated: "Curated", rotation: "Rotation" };

const SOURCE_TAG: Record<BallotSource, string> = {
  pinned: "bg-ink text-paper",
  curated: "bg-sage-tint text-sage-ink",
  rotation: "bg-sand text-ink-soft",
};

const SOURCE_HINT: Record<BallotSource, string> = {
  pinned: "pinned by the coin's controller",
  curated: "picked by the curator agent",
  rotation: "drawn from the coin's cause focus",
};

export interface BallotOptionProps extends Omit<ComponentProps<typeof RadioGroup.Item>, "value" | "children"> {
  option: BallotOptionData;
}

/**
 * One charity on the ballot, as a radio card. Must sit inside a radix `RadioGroup.Root` (BallotList
 * provides one), which gives roving focus: Tab enters the group, arrow keys move and select. The card
 * is a size container: under 288px the source tag drops under the name and the icon shrinks.
 */
export function BallotOption({ option: o, className, ...props }: BallotOptionProps) {
  return (
    <RadioGroup.Item
      value={o.id}
      data-slot="ballot-option"
      aria-label={`${o.org}, ${CAUSE_SHORT_LABELS[o.category]}, ${o.region}, ${SOURCE_LABELS[o.source]}: ${SOURCE_HINT[o.source]}`}
      className={cn(
        "group @container flex min-h-16 w-full items-center gap-3 rounded-2xl border-2 border-line bg-paper-card px-3 py-2.5 text-left text-ink transition-colors",
        "hover:border-line-strong data-[state=checked]:border-sage data-[state=checked]:bg-sage-tint/60",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CauseIcon cause={o.category} size={42} decorative className="@max-3xs:size-8" />
      <span className="flex min-w-0 flex-1 flex-col">
        <strong className="truncate text-[15px] @max-2xs:text-sm">{o.org}</strong>
        <span className="truncate text-xs text-ink-muted">
          {CAUSE_SHORT_LABELS[o.category]} · {o.region}
          {o.score ? <span className="num"> · {o.score}</span> : null}
        </span>
        {/* Below 288px the source tag moves under the name instead of taking width beside it. */}
        <span aria-hidden="true" className="hidden text-[11px] font-bold text-ink-soft @max-2xs:block">
          {SOURCE_LABELS[o.source]}
        </span>
      </span>
      <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold @max-2xs:hidden", SOURCE_TAG[o.source])}>{SOURCE_LABELS[o.source]}</span>
      <span
        aria-hidden="true"
        className="grid size-6 shrink-0 place-items-center rounded-full border-2 border-line-strong group-data-[state=checked]:border-sage group-data-[state=checked]:bg-sage"
      >
        <RadioGroup.Indicator>
          <Check className="size-3.5 text-primary-foreground" strokeWidth={3} />
        </RadioGroup.Indicator>
      </span>
    </RadioGroup.Item>
  );
}

export type BallotOptionGroupProps = ComponentProps<typeof RadioGroup.Root>;

/** The radio group BallotOptions sit in, for layouts other than BallotList. */
export function BallotOptionGroup({ className, ...props }: BallotOptionGroupProps) {
  return <RadioGroup.Root className={cn("grid gap-2", className)} {...props} />;
}
