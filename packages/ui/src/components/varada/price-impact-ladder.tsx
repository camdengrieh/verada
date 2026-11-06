// Adapted from 21st.dev @eugeneshilow/leaderboard-bars (id 29466): horizontal bars on a shared scale
// with a reference rule. Reworked as a table of trade sizes, with the warning threshold drawn as a
// rule and every row over it flagged in words.
import { TriangleAlert } from "lucide-react";
import { useId, type ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";
import { formatUsdCompact } from "./liquidity-meter";

/**
 * Estimated price impact for a few trade sizes on one route, so thin Ondo routes are obvious before
 * anyone trades. The app quotes the sizes; this only draws them.
 */

export interface ImpactStep {
  /** Trade size in USD. */
  size: number;
  /** Estimated impact in percent; null when the route can't fill this size. */
  impact: number | null;
  /** Overrides the size label ("$10K"). */
  label?: string;
}

export type LadderSeverity = "low" | "caution" | "warn" | "unfillable";

export function ladderSeverity(impact: number | null, cautionAt = 1, warnAt = 3): LadderSeverity {
  if (impact === null || !Number.isFinite(impact)) return "unfillable";
  if (impact >= warnAt) return "warn";
  if (impact >= cautionAt) return "caution";
  return "low";
}

export const DEFAULT_IMPACT_SIZES = [100, 1_000, 10_000, 50_000] as const;

export interface PriceImpactLadderProps extends Omit<ComponentProps<"div">, "children"> {
  steps: readonly ImpactStep[];
  /** Impact in percent at which a row is flagged (default 3). */
  warnAt?: number;
  /** Impact at which a row turns amber (default 1). */
  cautionAt?: number;
  /** Percent that fills a bar; defaults to the larger of 1.5 x warnAt and the biggest impact. */
  max?: number;
  /** Table caption (visible). */
  title?: string;
  /** Route the quotes are for, shown under the title ("$HARAMBE → NVDAon → USDC"). */
  route?: string;
  /** Hide the visible caption (it stays for screen readers). */
  hideTitle?: boolean;
}

const BAR: Record<LadderSeverity, string> = {
  low: "bg-sage",
  caution: "bg-ochre",
  warn: "bg-terracotta",
  unfillable: "bg-terracotta",
};

const fmtPct = (n: number) => `${n < 10 ? n.toFixed(2) : n.toFixed(1)}%`;

/** Trade size against estimated price impact, as bars with a warning rule. */
export function PriceImpactLadder({
  steps,
  warnAt = 3,
  cautionAt = 1,
  max,
  title = "Estimated price impact",
  route,
  hideTitle,
  className,
  ...props
}: PriceImpactLadderProps) {
  const noteId = useId();
  const biggest = Math.max(0, ...steps.map((s) => s.impact ?? 0));
  const scale = max ?? Math.max(warnAt * 1.5, biggest);
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / scale) * 100))}%`;
  const flagged = steps.filter((s) => {
    const sev = ladderSeverity(s.impact, cautionAt, warnAt);
    return sev === "warn" || sev === "unfillable";
  }).length;

  return (
    <div data-slot="price-impact-ladder" className={cn("flex flex-col gap-2", className)} {...props}>
      <table className="w-full border-collapse text-sm" aria-describedby={noteId}>
        <caption className={cn("text-left", hideTitle && "sr-only")}>
          <span className="block text-[13px] font-semibold text-ink">{title}</span>
          {route ? <span className="block text-xs text-ink-muted">{route}</span> : null}
        </caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Trade size</th>
            <th scope="col">Price impact</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => {
            const sev = ladderSeverity(s.impact, cautionAt, warnAt);
            const hot = sev === "warn" || sev === "unfillable";
            return (
              <tr key={s.size} data-severity={sev} className={cn(hot && "bg-terracotta-tint")}>
                <th scope="row" className={cn("num w-16 py-1.5 pl-2 pr-3 text-left font-semibold", hot ? "text-terracotta-strong" : "text-ink")}>
                  {s.label ?? formatUsdCompact(s.size)}
                </th>
                <td className="py-1.5 pr-2">
                  <div className="flex items-center gap-3">
                    <div aria-hidden="true" className="relative h-2.5 min-w-0 flex-1 rounded-full bg-sand">
                      <span
                        className={cn("absolute inset-y-0 left-0 rounded-full", BAR[sev])}
                        style={{ width: s.impact === null ? "100%" : pct(s.impact), opacity: s.impact === null ? 0.35 : undefined }}
                      />
                      <span className="absolute -inset-y-1 w-0.5 rounded-full bg-ink" style={{ left: pct(warnAt) }} />
                    </div>
                    <span className={cn("inline-flex w-28 shrink-0 items-center justify-end gap-1 text-right", hot ? "font-semibold text-terracotta-strong" : sev === "caution" ? "text-ochre-ink" : "text-ink")}>
                      {hot ? <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" /> : null}
                      {s.impact === null ? (
                        "Can't fill"
                      ) : (
                        <>
                          <span className="num">{fmtPct(s.impact)}</span>
                          {hot ? <span>High</span> : null}
                        </>
                      )}
                    </span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p id={noteId} className="m-0 text-xs text-ink-muted">
        <span aria-hidden="true" className="mr-1 inline-block h-2.5 w-0.5 translate-y-px rounded-full bg-ink" />
        Warning at {fmtPct(warnAt)}.{" "}
        {flagged ? `${flagged} of ${steps.length} sizes are over it.` : "Every size is under it."}
      </p>
    </div>
  );
}
