"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { CATEGORIES } from "@varada/sdk";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@varada/ui/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@varada/ui/components/ui/dialog";
import { Compass, Coins, HandHeart, Heart, Search, User, Vote } from "@varada/ui/components/ui/icons";
import { Kbd } from "@varada/ui/components/ui/kbd";
import { CauseIcon } from "@varada/ui/components/varada/cause-icon";
import { useAppConfig, useDeps } from "@/components/providers";
import { NAV_ITEMS } from "@/components/nav";
import { causeNameOf, shortAddr, tokenPath } from "@/lib/discover";
import { fetchDiscover } from "@/lib/discover-client";
import { useRel } from "./hooks";

const PAGE_ICONS = { "": Compass, "donate/": Heart, "launch/": Coins, "causes/": HandHeart, "governance/": Vote, "agent/": User } as const;

/** Debounced copy of a value. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Called with the query when the person presses Enter on "Search all coins". */
  onSearch(query: string): void;
}

/**
 * Jump to a coin, a cause or a page. Coins come from the same bulk discover route as the home list
 * and causes from the catalogue; nothing here is keyed by a wallet address.
 */
export function CommandPalette({ open, onOpenChange, onSearch }: CommandPaletteProps) {
  const config = useAppConfig();
  const deps = useDeps();
  const rel = useRel();
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 250);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const coins = useQuery({
    queryKey: ["palette-coins", q],
    queryFn: () => fetchDiscover(deps.indexer, { q, sort: "trending", limit: 6 }),
    enabled: open && q.length >= 2,
    retry: false,
    staleTime: 30_000,
  });
  const causes = useQuery({
    queryKey: ["palette-causes", q],
    queryFn: () => deps.indexer.catalogSearch({ q, limit: 5 }),
    enabled: open && q.length >= 2,
    retry: false,
    staleTime: 60_000,
  });

  const needle = query.trim().toLowerCase();
  const pages = NAV_ITEMS.filter((n) => !needle || n.label.toLowerCase().includes(needle));
  const categories = useMemo(() => (needle.length >= 2 ? CATEGORIES.filter((c) => c.label.toLowerCase().includes(needle)).slice(0, 4) : []), [needle]);

  const go = (path: string) => {
    onOpenChange(false);
    window.location.href = rel(path);
  };
  const searching = q.length >= 2 && (coins.isFetching || causes.isFetching);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="top-[12dvh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Search Varada</DialogTitle>
        <DialogDescription className="sr-only">Jump to a coin, a cause or a page</DialogDescription>
        <Command shouldFilter={false} loop className="rounded-none">
          <CommandInput value={query} onValueChange={setQuery} placeholder="Search coins, causes and pages" />
          <CommandList>
            {!searching && pages.length === 0 && categories.length === 0 && (coins.data?.items.length ?? 0) === 0 && (causes.data?.items.length ?? 0) === 0 ? (
              <CommandEmpty>{q.length < 2 ? "Type two letters to search coins and causes." : "Nothing matches."}</CommandEmpty>
            ) : null}
            {q.length >= 2 ? (
              <CommandGroup heading="Coins">
                {searching && !coins.data ? <p className="px-3 py-2 text-sm text-ink-muted">Searching</p> : null}
                {coins.error ? <p className="px-3 py-2 text-sm text-ink-muted">Coin search is unavailable right now.</p> : null}
                {(coins.data?.items ?? []).map((t) => (
                  <CommandItem key={t.address} value={`coin-${t.address}`} icon={<Coins />} hint={`${t.label ? `${t.label}.${config.ensParentName}` : shortAddr(t.address)}`} onSelect={() => go(tokenPath(t.address))}>
                    {t.name || t.symbol} <span className="num text-ink-muted">${t.symbol}</span>
                  </CommandItem>
                ))}
                {coins.data && coins.data.items.length === 0 ? <p className="px-3 py-2 text-sm text-ink-muted">No coin matches.</p> : null}
                <CommandItem
                  value="search-all"
                  icon={<Search />}
                  onSelect={() => {
                    onOpenChange(false);
                    onSearch(query.trim());
                  }}
                >
                  Search all coins for “{query.trim()}”
                </CommandItem>
              </CommandGroup>
            ) : null}
            {categories.length > 0 || (causes.data?.items.length ?? 0) > 0 ? (
              <CommandGroup heading="Causes">
                {categories.map((c) => (
                  <CommandItem key={c.slug} value={`category-${c.slug}`} icon={<CauseIcon cause={causeNameOf(c.slug)} size={20} decorative />} hint="Cause category" onSelect={() => go(`causes/?category=${c.slug}`)}>
                    {c.label}
                  </CommandItem>
                ))}
                {(causes.data?.items ?? []).map((o) => (
                  <CommandItem key={o.causeId} value={`org-${o.causeId}`} icon={<HandHeart />} hint={[o.country, o.categories[0]].filter(Boolean).join(" · ")} onSelect={() => go(`causes/?q=${encodeURIComponent(o.name)}`)}>
                    {o.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {pages.length > 0 ? (
              <CommandGroup heading="Pages">
                {pages.map((n) => {
                  const Icon = PAGE_ICONS[n.to];
                  return (
                    <CommandItem key={n.to} value={`page-${n.to}`} icon={<Icon />} onSelect={() => go(n.to)}>
                      {n.label}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}
          </CommandList>
          <div className="flex items-center gap-4 border-t border-line px-4 py-2.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> to move
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>↵</Kbd> to open
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>esc</Kbd> to close
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
