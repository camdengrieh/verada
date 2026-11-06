// Adapted from 21st.dev @ddoemonn/filter-grid (id 23525): segmented chips with live per-option counts,
// radio semantics with roving arrow keys and a polite result count, here grouped into a bottom sheet
// (ui/drawer.tsx, from 21st.dev @wensity/drawer id 31360, which names filters as a use) with a draft
// that only applies on Apply, a Reset, and multi-select groups as toggle chips.
"use client";

import { Check, SlidersHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@verada/ui/components/ui/button";
import { Divider } from "@verada/ui/components/ui/divider";
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from "@verada/ui/components/ui/drawer";
import { cn } from "@verada/ui/lib/utils";
import { CONTAINED_SHEET, type MobileSheetBaseProps } from "./sheet-shared";

export interface FilterOption {
  value: string;
  label: string;
  /** How many results this option would leave, shown on the chip. */
  count?: number;
}

export interface FilterGroup {
  id: string;
  label: string;
  /** `single`: one choice (radio chips; pick an "All" option to clear). `multi`: any number (toggle chips). */
  type: "single" | "multi";
  options: readonly FilterOption[];
}

/** Chosen values per group id. Single groups hold at most one value. */
export type FilterValue = Record<string, readonly string[]>;

export interface FilterSheetProps extends MobileSheetBaseProps {
  groups: readonly FilterGroup[];
  /** The applied filters. The sheet edits a draft copy and hands it back on Apply. */
  value: FilterValue;
  onApply: (value: FilterValue) => void;
  /** What Reset sets the draft to (default: nothing chosen). Reset does not close the sheet. */
  resetValue?: FilterValue;
  onReset?: () => void;
  title?: string;
  description?: string;
  /** The Apply button's label for a draft, e.g. `(d) => \`Show ${count(d)} coins\``. */
  applyLabel?: (draft: FilterValue) => string;
}

/** Number of chosen values across groups (for a "Filters · 3" button). */
export function countFilters(value: FilterValue, resetValue: FilterValue = {}): number {
  return Object.entries(value).reduce((n, [k, vs]) => n + vs.filter((v) => !(resetValue[k] ?? []).includes(v)).length, 0);
}

const same = (a: FilterValue, b: FilterValue) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = [...(a[k] ?? [])].sort().join("\u0000");
    const y = [...(b[k] ?? [])].sort().join("\u0000");
    if (x !== y) return false;
  }
  return true;
};

/**
 * Filters for a phone list as a bottom sheet. Choices go into a draft; Apply hands it back and
 * closes, Reset clears the draft, and closing without Apply drops it. Single-choice groups are radio
 * chips (arrow keys move and choose), multi-choice groups toggle chips (aria-pressed). Chips are 48px
 * tall; the footer stays pinned.
 */
export function FilterSheet({
  open,
  onOpenChange,
  container,
  modal = true,
  groups,
  value,
  onApply,
  resetValue = {},
  onReset,
  title = "Filters",
  description = "Narrow the list. Nothing changes until you apply.",
  applyLabel = () => "Apply filters",
}: FilterSheetProps) {
  const id = useId();
  const [draft, setDraft] = useState<FilterValue>(value);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) setDraft(value);
    wasOpen.current = open;
  }, [open, value]);

  const pick = (g: FilterGroup, v: string) => {
    setDraft((d) => {
      const cur = d[g.id] ?? [];
      if (g.type === "single") return { ...d, [g.id]: [v] };
      return { ...d, [g.id]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] };
    });
  };
  const dirty = !same(draft, value);
  const atReset = same(draft, resetValue);

  return (
    <Drawer open={open} onOpenChange={onOpenChange} container={container} modal={modal}>
      <DrawerContent data-slot="filter-sheet" className={cn(container && CONTAINED_SHEET)}>
        <DrawerHeader>
          <DrawerTitle>{title}</DrawerTitle>
          <DrawerDescription>{description}</DrawerDescription>
        </DrawerHeader>
        <DrawerBody className="flex flex-col gap-4">
          {groups.map((g, gi) => (
            <div key={g.id} className="flex flex-col gap-4">
              {gi > 0 ? <Divider variant="dashed" /> : null}
              <FilterChips group={g} chosen={draft[g.id] ?? []} onPick={(v) => pick(g, v)} idPrefix={`${id}-${g.id}`} />
            </div>
          ))}
        </DrawerBody>
        <DrawerFooter className="flex-row gap-2.5 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <Button
            variant="outline"
            size="lg"
            className="h-13 px-5"
            disabled={atReset}
            onClick={() => {
              setDraft(resetValue);
              onReset?.();
            }}
          >
            Reset
          </Button>
          <Button
            size="lg"
            className="h-13 min-w-0 flex-1"
            onClick={() => {
              onApply(draft);
              onOpenChange(false);
            }}
          >
            <span className="truncate">{applyLabel(draft)}</span>
          </Button>
        </DrawerFooter>
        <span role="status" className="sr-only">
          {dirty ? `${countFilters(draft, resetValue)} filters chosen, not applied yet` : ""}
        </span>
      </DrawerContent>
    </Drawer>
  );
}

const NAV = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];

function FilterChips({ group, chosen, onPick, idPrefix }: { group: FilterGroup; chosen: readonly string[]; onPick: (v: string) => void; idPrefix: string }) {
  const single = group.type === "single";
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIndex = Math.max(
    0,
    group.options.findIndex((o) => chosen.includes(o.value)),
  );
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (!NAV.includes(e.key)) return;
    e.preventDefault();
    const n = group.options.length;
    const next = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1) + n) % n;
    refs.current[next]?.focus();
    // Radio chips choose as focus moves; toggle chips only move.
    if (single) onPick(group.options[next]!.value);
  };
  const labelId = `${idPrefix}-label`;
  return (
    <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
      <legend id={labelId} className="kicker mb-2.5 p-0 font-sans">
        {group.label}
      </legend>
      <div role={single ? "radiogroup" : "group"} aria-labelledby={labelId} className="flex flex-wrap gap-2">
        {group.options.map((o, i) => {
          const on = chosen.includes(o.value);
          return (
            <button
              key={o.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role={single ? "radio" : undefined}
              aria-checked={single ? on : undefined}
              aria-pressed={single ? undefined : on}
              tabIndex={single ? (i === activeIndex ? 0 : -1) : 0}
              onClick={() => onPick(o.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                "inline-flex min-h-12 items-center gap-1.5 rounded-full border-[1.5px] px-4 text-[15px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                on ? "border-ink bg-ink text-paper" : "border-line-strong bg-paper-card text-ink hover:bg-sand",
              )}
            >
              {on && !single ? <Check aria-hidden="true" className="size-4" strokeWidth={3} /> : null}
              {o.label}
              {o.count !== undefined ? (
                <span className={cn("num text-[13px] font-normal", on ? "text-paper/85" : "text-ink-muted")}>
                  {o.count}
                  <span className="sr-only"> results</span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export interface FilterButtonProps extends Omit<ComponentProps<"button">, "children"> {
  /** Applied filter count; shown after the label when above zero. */
  count?: number;
  label?: ReactNode;
}

/** The "Filters" pill that opens the sheet, with the applied count. */
export function FilterButton({ count = 0, label = "Filters", className, ...props }: FilterButtonProps) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      className={cn(
        "inline-flex min-h-12 shrink-0 items-center gap-2 rounded-full border-[1.5px] border-ink bg-paper-card px-4 text-[15px] font-semibold text-ink hover:bg-sand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    >
      <SlidersHorizontal aria-hidden="true" className="size-4" />
      {label}
      {count > 0 ? (
        <span className="num grid min-w-6 place-items-center rounded-full bg-ink px-1.5 text-[13px] leading-6 text-paper">
          {count}
          <span className="sr-only"> applied</span>
        </span>
      ) : null}
    </button>
  );
}
