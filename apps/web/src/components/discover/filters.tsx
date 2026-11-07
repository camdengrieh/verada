"use client";

import { useEffect, useMemo, useState } from "react";
import { CATEGORIES, REGIONS, rankByDepth } from "@varada/sdk";
import { Button } from "@varada/ui/components/ui/button";
import { Input, InputAddon, InputGroup } from "@varada/ui/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@varada/ui/components/ui/select";
import { SlidersHorizontal, Search, X } from "@varada/ui/components/ui/icons";
import { FilterSheet, countFilters, type FilterGroup, type FilterValue } from "@varada/ui/components/mobile/filter-sheet";
import type { DiscoverState } from "@/lib/discover";
import { isCryptoKind } from "@/lib/discover";
import type { AppQuoteAsset } from "@/lib/quote-assets";

const ALL = "all";

export interface FiltersProps {
  state: DiscoverState;
  assets: readonly AppQuoteAsset[];
  onChange(patch: Partial<DiscoverState>, opts?: { replace?: boolean }): void;
}

/** The state as the sheet's chosen values. */
export function toFilterValue(s: DiscoverState): FilterValue {
  return { pair: [s.pair ?? ALL], cause: [s.category ?? ALL], region: [s.region ?? ALL], mode: [s.mode ?? ALL] };
}

/** The sheet's chosen values back as a state patch. */
export function fromFilterValue(v: FilterValue): Partial<DiscoverState> {
  const one = (k: string) => {
    const x = v[k]?.[0];
    return x && x !== ALL ? x : null;
  };
  const mode = one("mode");
  return { pair: one("pair"), category: one("cause"), region: one("region"), mode: mode === "weekly" || mode === "live" ? mode : null };
}

export const RESET: FilterValue = { pair: [ALL], cause: [ALL], region: [ALL], mode: [ALL] };

/** Filters set on top of the tab (the tab itself is not counted). */
export function activeFilterCount(s: DiscoverState): number {
  return countFilters(toFilterValue(s), RESET);
}

function FilterSelect({ label, value, onValueChange, children }: { label: string; value: string; onValueChange(v: string): void; children: React.ReactNode }) {
  return (
    <div className="w-44 shrink-0">
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
    </div>
  );
}

/** Search box with its own draft, applied after a short pause or on Enter, so typing does not refetch per key. */
export function SearchBox({ value, onApply }: { value: string; onApply(v: string): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft.trim() === value.trim()) return;
    const t = setTimeout(() => onApply(draft), 350);
    return () => clearTimeout(t);
  }, [draft, value, onApply]);
  return (
    <form
      role="search"
      aria-label="Search coins"
      className="min-w-0 flex-1 md:max-w-sm"
      onSubmit={(e) => {
        e.preventDefault();
        onApply(draft);
      }}
    >
      <InputGroup>
        <InputAddon>
          <Search aria-hidden="true" className="size-4" />
        </InputAddon>
        <Input type="search" aria-label="Search coins by name, symbol or ENS name" placeholder="Search name, $symbol or ENS" value={draft} onChange={(e) => setDraft(e.target.value)} />
      </InputGroup>
    </form>
  );
}

/** Crypto pairs first, then the tokenized assets deepest pool first (liquidity from the on-chain route to USDC). */
export function pairOrder<T extends Pick<AppQuoteAsset, "kind" | "symbol" | "routeDepthUsd">>(assets: readonly T[]): T[] {
  const crypto = rankByDepth(assets.filter((a) => isCryptoKind(a.kind)), (a) => a.routeDepthUsd, (a) => a.symbol);
  const other = rankByDepth(assets.filter((a) => !isCryptoKind(a.kind)), (a) => a.routeDepthUsd, (a) => a.symbol);
  return [...crypto, ...other];
}

/** Pair, cause, region and mode filters: selects from 768px, a bottom sheet on phones. */
export function Filters({ state, assets, onChange }: FiltersProps) {
  const [open, setOpen] = useState(false);
  const crypto = assets.filter((a) => isCryptoKind(a.kind));
  const other = assets.filter((a) => !isCryptoKind(a.kind));
  const count = activeFilterCount(state);

  const groups: FilterGroup[] = useMemo(
    () => [
      { id: "pair", label: "Pair", type: "single", options: [{ value: ALL, label: "Any pair" }, ...pairOrder(assets).map((a) => ({ value: a.symbol, label: a.symbol }))] },
      { id: "cause", label: "Cause", type: "single", options: [{ value: ALL, label: "Any cause" }, ...CATEGORIES.map((c) => ({ value: c.slug, label: c.label }))] },
      { id: "region", label: "Region", type: "single", options: [{ value: ALL, label: "Anywhere" }, ...REGIONS.map((r) => ({ value: r.slug, label: r.label }))] },
      {
        id: "mode",
        label: "Giving",
        type: "single",
        options: [
          { value: ALL, label: "Any" },
          { value: "weekly", label: "Epoch pool" },
          { value: "live", label: "Live donation" },
        ],
      },
    ],
    [assets],
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SearchBox value={state.q} onApply={(q) => onChange({ q }, { replace: true })} />
      <div className="hidden flex-wrap items-center gap-2 md:flex">
        <FilterSelect label="Pair" value={state.pair ?? ALL} onValueChange={(v) => onChange({ pair: v === ALL ? null : v })}>
          <SelectItem value={ALL}>Any pair</SelectItem>
          {crypto.length > 0 && (
            <SelectGroup>
              <SelectLabel>Crypto</SelectLabel>
              {crypto.map((a) => (
                <SelectItem key={a.address} value={a.symbol}>
                  {a.symbol}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {other.length > 0 && (
            <SelectGroup>
              <SelectLabel>Stocks &amp; RWA</SelectLabel>
              {other.map((a) => (
                <SelectItem key={a.address} value={a.symbol}>
                  {a.symbol} · {a.name}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </FilterSelect>
        <FilterSelect label="Cause" value={state.category ?? ALL} onValueChange={(v) => onChange({ category: v === ALL ? null : v })}>
          <SelectItem value={ALL}>Any cause</SelectItem>
          {CATEGORIES.map((c) => (
            <SelectItem key={c.slug} value={c.slug}>
              {c.label}
            </SelectItem>
          ))}
        </FilterSelect>
        <FilterSelect label="Region" value={state.region ?? ALL} onValueChange={(v) => onChange({ region: v === ALL ? null : v })}>
          <SelectItem value={ALL}>Anywhere</SelectItem>
          {REGIONS.map((r) => (
            <SelectItem key={r.slug} value={r.slug}>
              {r.label}
            </SelectItem>
          ))}
        </FilterSelect>
        <FilterSelect label="Giving mode" value={state.mode ?? ALL} onValueChange={(v) => onChange({ mode: v === "weekly" || v === "live" ? v : null })}>
          <SelectItem value={ALL}>Any giving mode</SelectItem>
          <SelectItem value="weekly">Epoch pool</SelectItem>
          <SelectItem value="live">Live donation</SelectItem>
        </FilterSelect>
        {count > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => onChange({ pair: null, category: null, region: null, mode: null })}>
            <X aria-hidden="true" /> Clear
          </Button>
        ) : null}
      </div>
      <Button variant="outline" className="md:hidden" onClick={() => setOpen(true)} aria-label={count ? `Filters, ${count} on` : "Filters"}>
        <SlidersHorizontal aria-hidden="true" /> Filters{count ? ` · ${count}` : ""}
      </Button>
      <FilterSheet
        open={open}
        onOpenChange={setOpen}
        groups={groups}
        value={toFilterValue(state)}
        resetValue={RESET}
        onReset={() => undefined}
        onApply={(v) => {
          onChange(fromFilterValue(v));
          setOpen(false);
        }}
        title="Filter coins"
        description="Narrow the list by pair, cause, region or how a coin gives. Nothing changes until you apply."
      />
    </div>
  );
}
