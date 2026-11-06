"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";
import { CATEGORIES, REGIONS } from "@varada/sdk";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@varada/ui/components/ui/accordion";
import { Button } from "@varada/ui/components/ui/button";
import { CircleAlert, Search } from "@varada/ui/components/ui/icons";
import { Checkbox } from "@varada/ui/components/ui/checkbox";
import { Input, InputAddon, InputGroup } from "@varada/ui/components/ui/input";
import { Label } from "@varada/ui/components/ui/label";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { OrgCard } from "@/components/causes/org-card";
import { useDeps } from "@/components/providers";
import { errorText } from "@/components/use-tx";
import type { CatalogOrg } from "@/lib/indexer";

const PAGE = 24;

export const categoryLabel = (slug: string) => CATEGORIES.find((c) => c.slug === slug)?.label ?? slug;
export const regionLabel = (slug: string) => REGIONS.find((r) => r.slug === slug)?.label ?? slug;

/** Names of catalogue orgs by cause id (lowercase), for ballots whose options are not in the registry yet. */
export function useCatalogNames(causeIds: readonly string[]) {
  const deps = useDeps();
  const ids = [...new Set(causeIds.map((c) => c.toLowerCase()))].sort();
  return useQuery({
    queryKey: ["catalog-names", ids.join(",")],
    queryFn: () => deps.indexer.catalogCauses(ids),
    enabled: ids.length > 0,
    retry: false,
    staleTime: 600_000,
  });
}

function Checklist({
  legend,
  options,
  selected,
  onChange,
}: {
  legend: string;
  options: readonly { slug: string; label: string }[];
  selected: string[];
  onChange(next: string[]): void;
}) {
  const id = useId();
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="sr-only">{legend}</legend>
      <div className="grid grid-cols-1 gap-x-4 gap-y-1 @sm:grid-cols-2 @3xl:grid-cols-3">
        {options.map((o) => {
          const cid = `${id}-${o.slug}`;
          return (
            <div key={o.slug} className="flex min-h-11 items-center gap-3">
              <Checkbox
                id={cid}
                tone="cause"
                checked={selected.includes(o.slug)}
                onCheckedChange={(v) => onChange(v === true ? [...selected, o.slug] : selected.filter((s) => s !== o.slug))}
              />
              <Label htmlFor={cid} className="cursor-pointer text-[15px] font-medium">
                {o.label}
              </Label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

const countText = (n: number, one: string, many: string) => (n === 0 ? "any" : `${n} ${n === 1 ? one : many}`);

/** Category and region pickers. An empty list means "any". */
export function FocusPicker({
  categories,
  regions,
  onChange,
  only,
}: {
  categories: string[];
  regions: string[];
  onChange(next: { categories: string[]; regions: string[] }): void;
  /** Restrict the choices (for example to a token's focus). */
  only?: { categories: string[]; regions: string[] };
}) {
  const cats = only?.categories.length ? CATEGORIES.filter((c) => only.categories.includes(c.slug)) : CATEGORIES;
  const regs = only?.regions.length ? REGIONS.filter((r) => only.regions.includes(r.slug)) : REGIONS;
  return (
    <Accordion type="multiple" className="@container w-full">
      <AccordionItem value="causes">
        <AccordionTrigger>
          Causes <span className="ml-2 text-sm font-normal text-ink-muted">{countText(categories.length, "selected", "selected")}</span>
        </AccordionTrigger>
        <AccordionContent>
          <Checklist legend="Causes (none ticked: any)" options={cats} selected={categories} onChange={(c) => onChange({ categories: c, regions })} />
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="regions">
        <AccordionTrigger>
          Regions <span className="ml-2 text-sm font-normal text-ink-muted">{countText(regions.length, "selected", "selected")}</span>
        </AccordionTrigger>
        <AccordionContent>
          <Checklist legend="Regions (none ticked: any)" options={regs} selected={regions} onChange={(r) => onChange({ categories, regions: r })} />
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

export interface CatalogFilters {
  q: string;
  categories: string[];
  regions: string[];
}

/**
 * The organizations matching a name and focus, in a card grid with offset paging ("Load more").
 * `within` limits the search to a token's focus; `onSelect` adds a button to each card.
 */
export function CatalogResults({
  q,
  categories,
  regions,
  within,
  onSelect,
  selectLabel = "Add",
  onTotal,
}: CatalogFilters & {
  within?: { categories: string[]; regions: string[] };
  onSelect?(org: CatalogOrg): void;
  selectLabel?: string;
  /** Reports the number of matches (for a headline outside the grid). */
  onTotal?(total: number | null): void;
}) {
  const deps = useDeps();
  const scope = useMemo(
    () => ({
      categories: categories.length ? categories : (within?.categories ?? []),
      regions: regions.length ? regions : (within?.regions ?? []),
    }),
    [categories, regions, within],
  );
  const results = useInfiniteQuery({
    queryKey: ["catalog-search", q, scope.categories.join(","), scope.regions.join(",")],
    queryFn: ({ pageParam }) => deps.indexer.catalogSearch({ q, ...scope, offset: pageParam, limit: PAGE }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      if (!last) return undefined;
      const loaded = all.reduce((n, p) => n + (p?.items.length ?? 0), 0);
      return loaded < last.total && last.items.length > 0 ? loaded : undefined;
    },
    retry: false,
  });
  const first = results.data?.pages[0];
  const total = first?.total ?? null;
  useEffect(() => onTotal?.(total), [onTotal, total]);

  if (results.isLoading) {
    return (
      <div role="status" aria-label="Searching the catalogue" className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-36 rounded-[20px]" />
        ))}
      </div>
    );
  }
  if (results.error) {
    return (
      <EmptyState
        size="compact"
        icon={<CircleAlert />}
        role="alert"
        title="The catalogue search failed"
        body={errorText(results.error)}
        action={
          <Button variant="outline" size="sm" onClick={() => void results.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  if (first === null) {
    return (
      <EmptyState
        size="compact"
        icon={<CircleAlert />}
        role="alert"
        title="The cause catalogue is not available"
        body="This indexer has not loaded the catalogue yet. It can take a minute after a restart; try again shortly."
        action={
          <Button variant="outline" size="sm" onClick={() => void results.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  const items = (results.data?.pages ?? []).flatMap((p) => p?.items ?? []);
  if (items.length === 0) {
    return <EmptyState size="compact" icon={<Search />} title="No organizations match" body="Try another name, or clear a cause or region." />;
  }
  return (
    <div className="@container flex flex-col gap-4">
      <p className="m-0 text-sm text-ink-soft" role="status">
        {total} organization{total === 1 ? "" : "s"}
        {items.length < (total ?? 0) ? `, showing ${items.length}` : ""}
      </p>
      <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 @2xl:grid-cols-2 @5xl:grid-cols-3">
        {items.map((o) => (
          <li key={o.causeId} className="min-w-0">
            <OrgCard org={o} selectLabel={selectLabel} onSelect={onSelect ? () => onSelect(o) : undefined} />
          </li>
        ))}
      </ul>
      {results.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void results.fetchNextPage()} disabled={results.isFetchingNextPage}>
            {results.isFetchingNextPage ? "Loading" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Debounced copy of a value, so typing does not search on every key. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Browses the cause catalogue by name, category and region. With `onSelect` each result gets a
 * button; `within` limits the browse to a token's focus.
 */
export function CatalogBrowser({
  onSelect,
  selectLabel = "Add",
  within,
}: {
  onSelect?(org: CatalogOrg): void;
  selectLabel?: string;
  within?: { categories: string[]; regions: string[] };
}) {
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<{ categories: string[]; regions: string[] }>({ categories: [], regions: [] });
  const q = useDebounced(query.trim());
  const inputId = useId();
  return (
    <div className="@container flex flex-col gap-4">
      <form role="search" aria-label="Browse the cause catalogue" className="flex flex-col gap-3" onSubmit={(e) => e.preventDefault()}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={inputId}>Name</Label>
          <InputGroup>
            <InputAddon>
              <Search aria-hidden="true" />
            </InputAddon>
            <Input id={inputId} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search organizations" autoComplete="off" />
          </InputGroup>
        </div>
        <FocusPicker categories={focus.categories} regions={focus.regions} onChange={setFocus} only={within} />
      </form>
      <CatalogResults q={q} categories={focus.categories} regions={focus.regions} within={within} onSelect={onSelect} selectLabel={selectLabel} />
    </div>
  );
}
