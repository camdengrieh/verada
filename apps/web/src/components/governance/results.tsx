"use client";

import { Badge } from "@varada/ui/components/ui/badge";
import { Progress } from "@varada/ui/components/ui/progress";
import type { ResultRow } from "@/lib/governance";
import { formatWeight } from "@/lib/governance";

/**
 * The decrypted tally of a finished poll (`TallySubmitted` counts): one bar per option, leader
 * first. Counts are whole tokens of voting weight, not ballots.
 */
export function TallyResults({ rows, nameOf, symbol }: { rows: ResultRow[]; nameOf: (index: number) => string; symbol?: string }) {
  const ranked = [...rows].sort((a, b) => (a.votes === b.votes ? a.index - b.index : a.votes > b.votes ? -1 : 1));
  const total = rows.reduce((n, r) => n + r.votes, 0n);
  return (
    <section aria-label="Results" className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 font-display text-xl font-semibold text-ink">Results</h3>
        <span className="num text-sm text-ink-muted">
          {formatWeight(total)} {symbol ? `$${symbol}` : "votes"} counted
        </span>
      </div>
      {total === 0n && <p className="m-0 text-sm text-ink-soft">Nobody voted, so this epoch pays the platform&apos;s fallback cause.</p>}
      <ol className="m-0 grid list-none gap-3 p-0">
        {ranked.map((r) => (
          <li key={r.index} className="grid gap-1">
            <Progress
              label={
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{nameOf(r.index)}</span>
                  {r.leader && (
                    <Badge tone="cause" shape="pill">
                      Winner
                    </Badge>
                  )}
                </span>
              }
              value={r.share}
              valueText={`${formatWeight(r.votes)} · ${r.share}%`}
              tone={r.leader ? "cause" : "ink"}
              size="sm"
            />
          </li>
        ))}
      </ol>
    </section>
  );
}
