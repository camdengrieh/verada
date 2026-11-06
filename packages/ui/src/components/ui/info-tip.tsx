"use client";
// Written for Varada on ui/tooltip (itself from 21st.dev @originui/tooltip, id 208). The glossary
// copy is Varada's own.
import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger, type TooltipContentProps } from "@verada/ui/components/ui/tooltip";
import { cn } from "@verada/ui/lib/utils";

/** Plain-language definitions for the terms traders trip over. */
export const GLOSSARY = {
  "price-impact": {
    term: "Price impact",
    definition: "How much your own trade moves the price. Bigger trades in thinner pools move it more.",
  },
  slippage: {
    term: "Slippage",
    definition: "The most the price may move between signing and the trade landing. Past it, the trade cancels and you keep your funds.",
  },
  epoch: {
    term: "Epoch",
    definition: "One voting round. Holders vote privately during the epoch; when it ends the tally is opened and the pool pays out to the winning cause.",
  },
  fhe: {
    term: "FHE",
    definition: "Fully homomorphic encryption. Your ballot is counted while still encrypted, so nobody, including Varada, sees how you voted.",
  },
  "cause-pool": {
    term: "Cause pool",
    definition: "Where 90% of a coin's trading fees collect until the epoch's winning cause is paid.",
  },
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;

export interface InfoTipProps extends Pick<TooltipContentProps, "side" | "align"> {
  /** A glossary entry, or pass `term` and `children` for your own. */
  entry?: GlossaryKey;
  term?: string;
  /** The definition. */
  children?: ReactNode;
  className?: string;
}

function resolve({ entry, term, children }: InfoTipProps): { term: string; body: ReactNode } {
  const g = entry ? GLOSSARY[entry] : undefined;
  return { term: term ?? g?.term ?? "", body: children ?? g?.definition };
}

function Definition({ term, body }: { term: string; body: ReactNode }) {
  return (
    <span className="flex flex-col gap-1 text-left">
      <span className="font-display text-[15px] font-semibold text-ink">{term}</span>
      <span className="text-ink-soft">{body}</span>
    </span>
  );
}

/**
 * A small "?" after a label that explains a term on hover, focus or tap. The visible mark is 20px;
 * its hit area is 44px. The trigger's accessible name is "What is <term>?" and the definition is
 * its description while open.
 */
export function InfoTip({ side = "top", align, className, ...rest }: InfoTipProps) {
  const { term, body } = resolve(rest);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`What is ${term.toLowerCase()}?`}
          className={cn(
            "relative inline-grid size-5 shrink-0 place-items-center rounded-full align-middle text-ink-muted transition-colors outline-none",
            "after:absolute after:-inset-3 after:content-[''] hover:text-ink focus-visible:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/35 data-[state=delayed-open]:text-primary data-[state=instant-open]:text-primary",
            className,
          )}
        >
          <CircleHelp aria-hidden="true" className="size-[18px]" strokeWidth={2.2} />
        </button>
      </TooltipTrigger>
      <TooltipContent tone="paper" animation="spring" side={side} align={align} className="max-w-64">
        <Definition term={term} body={body} />
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The term itself as the trigger: dotted ochre underline, inline in a sentence. Use it where the
 * word appears in running copy; use InfoTip beside form labels.
 */
export function InfoTerm({ side = "top", align, className, label, ...rest }: InfoTipProps & { label?: ReactNode }) {
  const { term, body } = resolve(rest);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline cursor-help rounded-sm font-[inherit] text-[inherit] underline decoration-ochre decoration-dotted decoration-2 underline-offset-4 outline-none",
            "hover:decoration-solid focus-visible:ring-[3px] focus-visible:ring-ring/35",
            className,
          )}
        >
          {label ?? term}
        </button>
      </TooltipTrigger>
      <TooltipContent tone="paper" animation="spring" side={side} align={align} className="max-w-64">
        <Definition term={term} body={body} />
      </TooltipContent>
    </Tooltip>
  );
}
