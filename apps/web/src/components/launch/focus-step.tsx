"use client";

import { CATEGORIES, REGIONS } from "@varada/sdk";
import { Button } from "@varada/ui/components/ui/button";
import { CauseChip } from "@varada/ui/components/varada/cause-chip";
import { CAUSE_SHORT_LABELS, CauseIcon, isCauseName, type CauseName } from "@varada/ui/components/varada/cause-icon";
import { cn } from "@varada/ui/lib/utils";
import { formatCount } from "@/lib/launch-format";
import { MIN_FOCUS_POOL } from "@/lib/launch-steps";
import type { CatalogSummary } from "@/lib/indexer";
import type { StepProps } from "./types";

/** The library's icon name for a catalogue category: its agent's ENS label, or "other". */
export function causeNameOf(slug: string): CauseName {
  const label = CATEGORIES.find((c) => c.slug === slug)?.ensLabel ?? "other";
  return isCauseName(label) ? label : "other";
}

function Toggle({ pressed, onClick, children, className }: { pressed: boolean; onClick(): void; children: React.ReactNode; className?: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "flex min-h-11 min-w-0 items-center gap-2.5 rounded-xl border-[1.5px] bg-paper-card px-3 py-2 text-left text-sm transition-colors hover:bg-sand/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30",
        pressed ? "border-sage bg-sage-tint/50 font-semibold text-sage-ink" : "border-line text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function FocusStep({
  state,
  err,
  setInput,
  summary,
}: StepProps & { summary: CatalogSummary | null | undefined }) {
  const { categories, regions } = state.input;
  const toggle = (list: string[], slug: string) => (list.includes(slug) ? list.filter((s) => s !== slug) : [...list, slug]);
  const countOf = (kind: "categories" | "regions", slug: string) => summary?.[kind].find((x) => x.slug === slug)?.orgs;
  const pool = state.pool;
  const error = err("focus");

  return (
    <div className="flex flex-col gap-6">
      <p className="m-0 text-[15px] text-ink-soft">
        Every charity in the catalogue that matches the causes and regions you pick can receive your coin&rsquo;s fees. Pick nothing to allow any. The focus can never change after launch.
      </p>

      <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <legend className="mb-1 flex w-full items-center justify-between gap-3 text-sm font-semibold text-ink">
          <span>Causes {categories.length ? <span className="num font-medium text-ink-muted">({categories.length} picked)</span> : <span className="font-medium text-ink-muted">(any)</span>}</span>
          {categories.length ? (
            <Button size="sm" variant="soft" onClick={() => setInput({ categories: [] })}>
              Clear
            </Button>
          ) : null}
        </legend>
        <div className="grid grid-cols-1 gap-2 @sm:grid-cols-2 @3xl:grid-cols-3">
          {CATEGORIES.map((c) => {
            const name = causeNameOf(c.slug);
            const n = countOf("categories", c.slug);
            return (
              <Toggle key={c.slug} pressed={categories.includes(c.slug)} onClick={() => setInput({ categories: toggle(categories, c.slug) })}>
                <CauseIcon cause={name} size={32} decorative />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{CAUSE_SHORT_LABELS[name]}</span>
                  {n !== undefined ? <span className="num text-xs font-normal text-ink-muted">{formatCount(n)} orgs</span> : null}
                </span>
              </Toggle>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <legend className="mb-1 flex w-full items-center justify-between gap-3 text-sm font-semibold text-ink">
          <span>Regions {regions.length ? <span className="num font-medium text-ink-muted">({regions.length} picked)</span> : <span className="font-medium text-ink-muted">(any)</span>}</span>
          {regions.length ? (
            <Button size="sm" variant="soft" onClick={() => setInput({ regions: [] })}>
              Clear
            </Button>
          ) : null}
        </legend>
        <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
          {REGIONS.map((r) => {
            const n = countOf("regions", r.slug);
            return (
              <Toggle key={r.slug} pressed={regions.includes(r.slug)} onClick={() => setInput({ regions: toggle(regions, r.slug) })}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{r.label}</span>
                  {n !== undefined ? <span className="num text-xs font-normal text-ink-muted">{formatCount(n)} orgs</span> : null}
                </span>
              </Toggle>
            );
          })}
        </div>
      </fieldset>

      <div
        role="status"
        aria-live="polite"
        className={cn("flex flex-col gap-2 rounded-xl border p-4 text-sm", typeof pool === "number" && pool < MIN_FOCUS_POOL ? "border-destructive/50 bg-paper-card" : "border-line bg-paper-card")}
      >
        {pool === undefined ? <span className="text-ink-soft">Counting eligible catalogue entries</span> : null}
        {pool === null ? <span className="text-ink-soft">The cause catalogue is not available from the indexer, so the eligible count is unknown. The factory checks the focus on chain.</span> : null}
        {typeof pool === "number" ? (
          <span className={pool < MIN_FOCUS_POOL ? "font-medium text-destructive" : "text-ink"}>
            <strong className="num">{pool.toLocaleString("en-US")}</strong> eligible catalogue {pool === 1 ? "entry" : "entries"}
            {pool < MIN_FOCUS_POOL ? `: a launch needs at least ${MIN_FOCUS_POOL}` : ""}
          </span>
        ) : null}
        {error ? (
          <span role="alert" className="font-medium text-destructive">
            {error}
          </span>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          {categories.length === 0 ? (
            <CauseChip cause="other" label="Any cause" size="sm" />
          ) : (
            categories.map((slug) => <CauseChip key={slug} cause={causeNameOf(slug)} size="sm" />)
          )}
          {regions.length === 0 ? <span className="text-xs text-ink-muted">Any region</span> : <span className="text-xs text-ink-muted">in {regions.map((s) => REGIONS.find((r) => r.slug === s)?.label ?? s).join(", ")}</span>}
        </div>
      </div>
    </div>
  );
}
