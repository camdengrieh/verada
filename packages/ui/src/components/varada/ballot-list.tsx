// Adapted from 21st.dev @sean0205/c-radio-group-8 (id 28339), with the search and source tabs of the A-Vote board
"use client";

import { Search } from "lucide-react";
import { RadioGroup, Tabs } from "radix-ui";
import { useId, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { Divider } from "@varada/ui/components/ui/divider";
import { cn } from "@varada/ui/lib/utils";
import { BallotOption, SOURCE_LABELS, type BallotOptionData, type BallotSource } from "./ballot-option";
import { CAUSE_LABELS, CAUSE_SHORT_LABELS } from "./cause-icon";

export type BallotGroup = "all" | BallotSource;

export interface BallotListProps extends Omit<ComponentProps<"div">, "children" | "defaultValue" | "onChange"> {
  options: readonly BallotOptionData[];
  /** Selected option id (controlled) … */
  value?: string;
  /** … or the initial selection (uncontrolled). */
  defaultValue?: string;
  onValueChange?: (id: string) => void;
  /** Initial source filter. */
  defaultGroup?: BallotGroup;
  /** Name of the radio group for assistive tech. */
  label?: string;
  disabled?: boolean;
  /** Under the list, e.g. the privacy note and vote button. */
  footer?: ReactNode;
}

const GROUPS: BallotGroup[] = ["all", "pinned", "curated", "rotation"];

function matches(o: BallotOptionData, q: string): boolean {
  if (!q) return true;
  const hay = `${o.org} ${CAUSE_LABELS[o.category]} ${CAUSE_SHORT_LABELS[o.category]} ${o.region} ${SOURCE_LABELS[o.source]}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

/**
 * The weekly ballot: search, All / Pinned / Curated / Rotation tabs, and a radio group of options
 * with roving focus (arrow keys move and select, Tab leaves the group).
 *
 * A size container: one column of options with the tabs two by two under 320px, the tabs in one
 * row from 320px, search and tabs side by side with two columns of options from 672px, and
 * three columns from 1024px. The footer stacks (full-width button) until 672px.
 */
export function BallotList({
  options,
  value,
  defaultValue,
  onValueChange,
  defaultGroup = "all",
  label = "Choose a charity",
  disabled,
  footer,
  className,
  ...props
}: BallotListProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<BallotGroup>(defaultGroup);
  const [inner, setInner] = useState(defaultValue ?? "");
  const selected = value ?? inner;

  const counts = useMemo(() => {
    const c: Record<BallotGroup, number> = { all: options.length, pinned: 0, curated: 0, rotation: 0 };
    for (const o of options) c[o.source] += 1;
    return c;
  }, [options]);

  const visible = useMemo(
    () => options.filter((o) => (group === "all" || o.source === group) && matches(o, query.trim())),
    [options, group, query],
  );

  const choose = (next: string) => {
    if (value === undefined) setInner(next);
    onValueChange?.(next);
  };

  const tabLabel = (g: BallotGroup) => `${g === "all" ? "All" : SOURCE_LABELS[g]} ${counts[g]}`;

  return (
    <div data-slot="ballot-list" className={cn("@container flex flex-col gap-3 rounded-[26px] border border-line bg-card p-[18px]", className)} {...props}>
      <Tabs.Root value={group} onValueChange={(g) => setGroup(g as BallotGroup)} className="flex flex-col gap-3">
        <div className="flex flex-col gap-2.5 @2xl:flex-row @2xl:items-center">
          <div className="flex min-h-11 min-w-0 items-center gap-2 rounded-xl border-[1.5px] border-line-strong bg-paper-card px-3 focus-within:border-ink focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring @2xl:flex-1">
            <Search aria-hidden="true" className="size-4 text-ink-muted" />
            <label htmlFor={`${id}-q`} className="sr-only">
              Search the ballot
            </label>
            <input
              id={`${id}-q`}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${options.length} charities on this ballot`}
              className="min-h-10 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink-muted focus-visible:outline-none"
            />
          </div>
          <Tabs.List aria-label="Ballot source" className="grid grid-cols-2 gap-1 rounded-[24px] bg-sand p-1 @xs:flex @xs:rounded-full">
            {GROUPS.map((g) => (
              <Tabs.Trigger
                key={g}
                value={g}
                className="min-h-11 rounded-full px-2.5 text-[13px] font-semibold whitespace-nowrap text-ink transition-colors hover:bg-line data-[state=active]:bg-ink data-[state=active]:text-paper @xs:flex-auto @md:px-3.5 @2xl:flex-none"
              >
                {tabLabel(g)}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </div>
        {GROUPS.map((g) => (
          <Tabs.Content key={g} value={g} className="focus-visible:outline-none">
            {g === group ? (
              visible.length ? (
                <RadioGroup.Root
                  value={selected}
                  onValueChange={choose}
                  aria-label={label}
                  disabled={disabled}
                  className="grid grid-cols-1 gap-2 @2xl:grid-cols-2 @5xl:grid-cols-3"
                >
                  {visible.map((o) => (
                    <BallotOption key={o.id} option={o} />
                  ))}
                </RadioGroup.Root>
              ) : (
                <p role="status" className="m-0 rounded-2xl bg-paper px-4 py-6 text-center text-sm text-ink-soft">
                  {query ? <>No charities match &ldquo;{query}&rdquo;{g === "all" ? null : ` in ${SOURCE_LABELS[g]}`}.</> : "No options in this group."}
                </p>
              )
            ) : null}
          </Tabs.Content>
        ))}
      </Tabs.Root>
      <span className="sr-only" role="status">
        {query ? `${visible.length} of ${options.length} charities shown` : ""}
      </span>
      {footer ? (
        <>
          <Divider variant="dashed" />
          <div data-slot="ballot-footer" className="flex flex-col items-stretch gap-3 @2xl:flex-row @2xl:flex-wrap @2xl:items-center">
            {footer}
          </div>
        </>
      ) : null}
    </div>
  );
}
