"use client";
// Written for Varada on ui/tooltip (21st.dev @originui/tooltip, id 208, with the spring entry from
// @manuarora700/animated-tooltip, id 791). Rows are separated with ui/divider's dashed ledger rule.
import type { ReactNode } from "react";
import { Divider } from "@verada/ui/components/ui/divider";
import { Tooltip, TooltipContent, TooltipTrigger, type TooltipContentProps } from "@verada/ui/components/ui/tooltip";
import { cn } from "@verada/ui/lib/utils";

export interface RichTooltipRow {
  label: ReactNode;
  value: ReactNode;
  /** `cause` paints the swatch sage (money that goes to charity), `platform` ochre, `muted` grey. */
  tone?: "cause" | "platform" | "muted";
}

export interface RichTooltipProps extends Pick<TooltipContentProps, "side" | "align"> {
  /** The trigger, e.g. a fee figure. It must be focusable (a button); use `asChild` semantics. */
  children: ReactNode;
  title: ReactNode;
  rows: RichTooltipRow[];
  /** Bottom line, under a dashed rule: usually the total. */
  total?: { label: ReactNode; value: ReactNode };
  footnote?: ReactNode;
  className?: string;
}

const SWATCH = { cause: "bg-sage", platform: "bg-ochre", muted: "bg-line-strong" } as const;

/**
 * A paper tooltip with a small breakdown table (fees, payouts, vote weight). Read-only: it opens
 * on hover, focus or tap and never holds controls. The trigger gets the table as its description.
 */
export function RichTooltip({ children, title, rows, total, footnote, side = "top", align = "center", className }: RichTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent tone="paper" animation="spring" side={side} align={align} className={cn("w-72 max-w-[calc(100vw-2rem)] p-4", className)}>
        <span className="flex flex-col gap-3 text-left">
          <span className="font-display text-base font-semibold text-ink">{title}</span>
          <table className="w-full text-sm">
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  <th scope="row" className="py-1 pr-3 text-left font-normal text-ink-soft">
                    <span className="inline-flex items-center gap-2">
                      {row.tone ? <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-full", SWATCH[row.tone])} /> : null}
                      {row.label}
                    </span>
                  </th>
                  <td className="num py-1 text-right font-medium text-ink">{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {total ? (
            <>
              <Divider variant="dashed" />
              <span className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-semibold text-ink">{total.label}</span>
                <span className="num font-semibold text-ink">{total.value}</span>
              </span>
            </>
          ) : null}
          {footnote ? <span className="text-xs leading-relaxed text-ink-muted">{footnote}</span> : null}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

export interface FeeTooltipProps extends Omit<RichTooltipProps, "title" | "rows" | "total" | "footnote"> {
  /** Fee rate shown in the title, e.g. "1%". */
  rate: string;
  /** Amounts for this trade, already formatted. */
  fee: ReactNode;
  toCause: ReactNode;
  toPlatform: ReactNode;
  /** The cause's short name, e.g. "Wildlife". */
  cause: ReactNode;
}

/** The trading-fee breakdown: 90% to the cause pool, 10% to the platform. */
export function FeeTooltip({ rate, fee, toCause, toPlatform, cause, ...props }: FeeTooltipProps) {
  return (
    <RichTooltip
      {...props}
      title={`Trading fee · ${rate}`}
      rows={[
        { label: <>{cause} pool · 90%</>, value: toCause, tone: "cause" },
        { label: "Varada · 10%", value: toPlatform, tone: "platform" },
      ]}
      total={{ label: "Fee on this trade", value: fee }}
      footnote="The pool pays whichever cause holders pick at the end of each epoch."
    />
  );
}
