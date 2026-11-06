"use client";

import { CATEGORIES } from "@varada/sdk";
import { CauseIcon } from "@varada/ui/components/varada/cause-icon";
import { formatUsd } from "@varada/ui/components/varada/impact-shared";
import { cn } from "@varada/ui/lib/utils";
import { agentLabelOfSlug, causeNameOfSlug, usdcToNumber, type CategoryTotal } from "@/lib/causes-client";

export interface CategoryCount {
  slug: string;
  orgs: number;
}

/**
 * The 21 cause categories as selectable tiles: painted icon, how many catalogue charities each
 * holds, how much has been given, and a link to the category's curator agent. Selecting a tile
 * filters the catalogue below; counts and totals are shown only once the indexer has reported them.
 */
export function CategoryGrid({
  selected,
  onToggle,
  counts,
  totals,
  agentHref,
}: {
  selected: readonly string[];
  onToggle(slug: string): void;
  counts?: readonly CategoryCount[];
  totals?: readonly CategoryTotal[];
  /** Page link for an agent label; omit to hide the curator links. */
  agentHref?(label: string): string;
}) {
  return (
    <ul className="@container m-0 grid list-none grid-cols-2 gap-3 p-0 @xl:grid-cols-3 @3xl:grid-cols-4 @6xl:grid-cols-6" aria-label="Cause categories">
      {CATEGORIES.map((c) => {
        const on = selected.includes(c.slug);
        const orgs = counts?.find((x) => x.slug === c.slug)?.orgs;
        const given = totals?.find((x) => x.slug === c.slug)?.donated;
        const agent = agentLabelOfSlug(c.slug);
        return (
          <li key={c.slug} className="min-w-0">
            <div
              className={cn(
                "flex h-full flex-col rounded-[20px] border bg-card transition-[border-color,box-shadow] focus-within:border-line-strong hover:shadow-paper",
                on ? "border-sage bg-sage-tint/50 shadow-paper" : "border-line",
              )}
            >
              <button
                type="button"
                aria-pressed={on}
                onClick={() => onToggle(c.slug)}
                className="flex min-h-11 flex-1 flex-col items-start gap-2 rounded-[20px] p-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
              >
                <CauseIcon cause={causeNameOfSlug(c.slug)} size={44} decorative />
                <span className="text-[15px] font-semibold leading-tight text-ink">{c.label}</span>
                <span className="text-xs text-ink-muted">
                  {orgs !== undefined ? <span className="num">{orgs.toLocaleString("en-US")} charities</span> : "Charities in the catalogue"}
                  {given !== undefined && given > 0n ? (
                    <>
                      <br />
                      <span className="num font-semibold text-sage-ink">{formatUsd(usdcToNumber(given), { compact: true })} given</span>
                    </>
                  ) : null}
                </span>
              </button>
              {agent && agentHref ? (
                <a href={agentHref(agent)} className="mx-3 mb-1 inline-flex min-h-11 items-center self-start text-[13px] font-semibold text-ink-soft underline-offset-4 hover:underline">
                  Curator agent
                  <span className="sr-only"> for {c.label}</span>
                </a>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
