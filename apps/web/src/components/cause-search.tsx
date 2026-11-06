"use client";

import { useId, useState, type FormEvent } from "react";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { Badge } from "@varada/ui/components/ui/badge";
import { Button } from "@varada/ui/components/ui/button";
import { Card } from "@varada/ui/components/ui/card";
import { CircleAlert, Search } from "@varada/ui/components/ui/icons";
import { Input, InputAddon, InputGroup } from "@varada/ui/components/ui/input";
import { Label } from "@varada/ui/components/ui/label";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { useDeps } from "@/components/providers";
import { shortAddress } from "@/components/use-tx";
import type { CauseSummary } from "@/lib/indexer";

/**
 * Nonprofit search over Endaoment's registry (through the indexer's proxy). With `onSelect`, each
 * result gets a button that hands it to the caller.
 */
export function CauseSearch({ onSelect, selectLabel = "Add" }: { onSelect?(cause: CauseSummary): void; selectLabel?: string } = {}) {
  const deps = useDeps();
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState<string | null>(null);
  const [causes, setCauses] = useState<CauseSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function run(cursorArg?: string) {
    setError(undefined);
    setBusy(true);
    const q = cursorArg ? (searched ?? query.trim()) : query.trim();
    try {
      const page = await deps.indexer.searchCauses(q, cursorArg);
      setSearched(q);
      setCauses((prev) => (cursorArg && prev ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (err) {
      if (!cursorArg) setCauses(null);
      setCursor(null);
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void run();
  }

  return (
    <div className="@container flex flex-col gap-4">
      <form onSubmit={onSubmit} role="search" className="flex flex-col gap-2 @md:flex-row @md:items-end">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor={inputId}>Search nonprofits</Label>
          <InputGroup>
            <InputAddon>
              <Search aria-hidden="true" />
            </InputAddon>
            <Input id={inputId} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name of a registered Endaoment organization" autoComplete="off" />
          </InputGroup>
        </div>
        <Button type="submit" disabled={busy && causes === null}>
          Search
        </Button>
      </form>
      {busy && causes === null && (
        <div role="status" aria-label="Searching Endaoment" className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
          <Skeleton className="h-24 rounded-[20px]" />
          <Skeleton className="h-24 rounded-[20px]" />
        </div>
      )}
      {error && (
        <EmptyState size="compact" icon={<CircleAlert />} role="alert" title="The search did not go through" body={error} />
      )}
      {causes && causes.length === 0 && <EmptyState size="compact" icon={<Search />} title="No results" body="Endaoment has no registered organization with that name." />}
      {causes && causes.length > 0 && (
        <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 @2xl:grid-cols-2 @5xl:grid-cols-3">
          {causes.map((c) => (
            <li key={c.causeId} className="min-w-0">
              <Card data-slot="cause-result" className="flex h-full flex-col gap-3 p-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="m-0 font-display text-lg font-semibold leading-snug [overflow-wrap:anywhere]">{c.name}</h3>
                  {c.address && (
                    <code className="truncate text-[13px] text-ink-muted" title={c.address}>
                      {shortAddress(c.address)}
                    </code>
                  )}
                </div>
                <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
                  <Badge tone={c.isDeployed ? "cause" : "outline"} dot={c.isDeployed} title={c.isDeployed ? "The organization's Endaoment contract is deployed" : "Deployed on its first gift"}>
                    {c.isDeployed ? "Deployed" : "Not yet deployed"}
                  </Badge>
                  {onSelect && (
                    <Button variant="outline" size="sm" onClick={() => onSelect(c)} aria-label={`${selectLabel} ${c.name}`}>
                      {selectLabel}
                    </Button>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void run(cursor)} disabled={busy}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
