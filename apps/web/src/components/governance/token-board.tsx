"use client";

import { Badge } from "@varada/ui/components/ui/badge";
import { Button } from "@varada/ui/components/ui/button";
import { Input, InputAddon, InputGroup } from "@varada/ui/components/ui/input";
import { Search } from "@varada/ui/components/ui/icons";
import { Tabs, TabsList, TabsTrigger } from "@varada/ui/components/ui/tabs";
import { useMemo, useState } from "react";
import { isAddress } from "viem";
import { useAppConfig } from "@/components/providers";
import { epochStatus, formatWeight, tokenLogoUrl, type Standing, type TokenEpochRow } from "@/lib/governance";
import { label as tokenLabel, type TokenSummary } from "@/lib/indexer";
import { cn } from "@varada/ui/lib/utils";

export type BoardFilter = "all" | "open" | "mine";

export interface BoardEntry {
  row: TokenEpochRow<TokenSummary>;
  /** The viewer's weight and vote, once read; undefined while unknown or when not connected. */
  standing?: Standing;
}

/** Whether the viewer can still vote here: the ballot is open, they held tokens, and they have not voted. */
export function canVoteHere(e: BoardEntry, nowSeconds: number): boolean {
  return epochStatus(e.row.detail, nowSeconds).phase === "open" && Boolean(e.standing && e.standing.weight > 0n && !e.standing.voted);
}

/** Filter and search the board: the viewer's votable tokens first when anything is known about them. */
export function filterBoard(entries: readonly BoardEntry[], filter: BoardFilter, query: string, nowSeconds: number): BoardEntry[] {
  const q = query.trim().toLowerCase();
  const out = entries.filter((e) => {
    const t = e.row.token;
    if (q && !`${t.name} ${t.symbol} ${t.address} ${t.label ?? ""}`.toLowerCase().includes(q)) return false;
    if (filter === "open") return epochStatus(e.row.detail, nowSeconds).phase === "open";
    if (filter === "mine") return Boolean(e.standing && e.standing.weight > 0n);
    return true;
  });
  return out.sort((a, b) => Number(canVoteHere(b, nowSeconds)) - Number(canVoteHere(a, nowSeconds)));
}

const INITIAL = 8;

/** Every token with a ballot this epoch: status, ballots cast and, for a connected wallet, its weight. */
export function TokenBoard({
  entries,
  selected,
  onSelect,
  nowSeconds,
  connected,
  onLookup,
}: {
  entries: BoardEntry[];
  selected: string | undefined;
  onSelect: (address: string) => void;
  nowSeconds: number;
  connected: boolean;
  /** A token address that is not on the board: open it anyway. */
  onLookup?: (address: string) => void;
}) {
  const config = useAppConfig();
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const shown = useMemo(() => filterBoard(entries, filter, query, nowSeconds), [entries, filter, query, nowSeconds]);
  const visible = all || query ? shown : shown.slice(0, INITIAL);
  const votable = entries.filter((e) => canVoteHere(e, nowSeconds)).length;

  return (
    <section aria-label="Tokens voting this week" className="grid content-start gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 font-display text-xl font-semibold text-ink">Tokens voting this week</h2>
        {connected && votable > 0 && (
          <Badge tone="cause" shape="pill">
            {votable} to vote in
          </Badge>
        )}
      </div>
      <InputGroup>
        <InputAddon>
          <Search aria-hidden="true" />
        </InputAddon>
        <label htmlFor="board-search" className="sr-only">
          Search tokens by name, symbol or address
        </label>
        <Input id="board-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tokens" />
      </InputGroup>
      <Tabs value={filter} onValueChange={(v) => setFilter(v as BoardFilter)} variant="pill">
        <TabsList aria-label="Filter tokens">
          <TabsTrigger value="all">All {entries.length}</TabsTrigger>
          <TabsTrigger value="open">Open</TabsTrigger>
          <TabsTrigger value="mine" disabled={!connected}>
            I hold
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {shown.length === 0 ? (
        <div className="grid gap-2 rounded-2xl bg-paper px-4 py-6 text-center text-sm text-ink-soft">
          <p role="status" className="m-0">
            {query ? `No tokens match “${query}”.` : filter === "mine" ? "You held none of these tokens at the snapshot." : "No tokens have an open ballot right now."}
          </p>
          {onLookup && isAddress(query.trim()) && (
            <Button variant="outline" onClick={() => onLookup(query.trim())}>
              Open the token at this address
            </Button>
          )}
        </div>
      ) : (
        <ul aria-label="Tokens" className="m-0 grid list-none gap-2 p-0">
          {visible.map((e) => {
            const t = e.row.token;
            const status = epochStatus(e.row.detail, nowSeconds);
            const logo = tokenLogoUrl(config.swarmGatewayUrl, t.logoRef);
            const isSelected = selected?.toLowerCase() === t.address.toLowerCase();
            const mine = e.standing;
            return (
              <li key={t.address}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => onSelect(t.address)}
                  className={cn(
                    "flex min-h-16 w-full items-center gap-3 rounded-2xl border-2 bg-paper-card px-3 py-2.5 text-left transition-colors hover:border-line-strong",
                    isSelected ? "border-sage bg-sage-tint/60" : "border-line",
                  )}
                >
                  {logo ? (
                    <img src={logo} alt="" width={44} height={44} loading="lazy" referrerPolicy="no-referrer" className="size-11 shrink-0 rounded-xl bg-sand object-cover" />
                  ) : (
                    <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-xl bg-sage-tint font-display font-semibold text-sage-ink">
                      {(t.symbol || t.name || "?").slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <strong className="truncate text-[15px] text-ink">{tokenLabel(t)}</strong>
                    <span className="truncate text-xs text-ink-muted">
                      {e.row.failed
                        ? "Could not load this token's epoch"
                        : e.row.detail?.poll
                          ? `${e.row.detail.poll.ballotCount} ${e.row.detail.poll.ballotCount === 1 ? "ballot" : "ballots"} cast`
                          : status.phase === "unopened"
                            ? "Nobody has opened the ballot"
                            : "No ballots yet"}
                      {mine && mine.weight > 0n ? ` · your weight ${formatWeight(mine.weight)}${mine.voted ? ", voted" : ""}` : ""}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <Badge tone={status.tone} shape="pill">
                      {status.phase === "open" ? "Open" : status.phase === "unopened" ? "Not opened" : status.phase === "counting" ? "Counting" : status.phase === "tallied" ? "Tallied" : "Final"}
                    </Badge>
                    {canVoteHere(e, nowSeconds) && <span className="text-[11px] font-bold text-sage-ink">You can vote</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {!all && !query && shown.length > INITIAL && (
        <Button variant="soft" onClick={() => setAll(true)}>
          Show all {shown.length} tokens
        </Button>
      )}
    </section>
  );
}
