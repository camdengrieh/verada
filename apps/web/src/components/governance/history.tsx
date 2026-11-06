"use client";

import { useQuery } from "@tanstack/react-query";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@varada/ui/components/ui/table";
import { Switch } from "@varada/ui/components/ui/switch";
import { CauseLeaderboard } from "@varada/ui/components/varada/cause-leaderboard";
import { DonationTimeline } from "@varada/ui/components/varada/donation-timeline";
import { useId, useMemo, useState } from "react";
import { useAppConfig, useDeps } from "@/components/providers";
import { errorText, formatTime } from "@/components/use-tx";
import { useCatalogOrgs, useCauseRegistry } from "@/components/governance/hooks";
import {
  causeLeaderboard,
  donationTimeline,
  loadHistory,
  orgCause,
  usdcToUsd,
  type HistoryLabels,
} from "@/lib/governance";
import { label as tokenLabel, type TokenSummary } from "@/lib/indexer";

const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: n < 1000 ? 2 : 0, maximumFractionDigits: n < 1000 ? 2 : 0 }).format(n);

/**
 * Finished epochs and what they paid: the newest finalized epochs and pool payouts across every
 * token (two public indexer feeds, no wallet involved), with the winners' names from the registry
 * and catalogue. "Only this token" narrows both to the one open on the page.
 */
export function GovernanceHistory({ tokens, selected, nowMs }: { tokens: readonly TokenSummary[]; selected: TokenSummary | undefined; nowMs: number }) {
  const config = useAppConfig();
  const deps = useDeps();
  const switchId = useId();
  const [onlySelected, setOnlySelected] = useState(false);

  const history = useQuery({ queryKey: ["governance-history"], queryFn: () => loadHistory(deps), retry: false, staleTime: 60_000 });
  const causes = useCauseRegistry();

  const scoped = useMemo(() => {
    const target = selected?.address.toLowerCase();
    const filter = <T extends { token: string }>(xs: readonly T[]) => (onlySelected && target ? xs.filter((x) => x.token.toLowerCase() === target) : [...xs]);
    return { epochs: filter(history.data?.epochs ?? []), donations: filter(history.data?.donations ?? []) };
  }, [history.data, onlySelected, selected]);

  const causeIds = useMemo(
    () => [...scoped.epochs.map((e) => e.winningCauseId), ...scoped.donations.map((d) => d.causeId)].filter((x): x is string => Boolean(x)),
    [scoped],
  );
  const orgs = useCatalogOrgs(causeIds);

  const tokenName = useMemo(() => new Map(tokens.map((t) => [t.address.toLowerCase(), t])), [tokens]);
  const labels: HistoryLabels = {
    cause: (id) => {
      const org = orgs.data?.get(id);
      return { name: org?.name ?? causes.data?.get(id)?.name ?? `${id.slice(0, 8)}…${id.slice(-4)}`, category: orgCause(org) };
    },
    token: (address) => {
      const t = tokenName.get(address);
      return t?.symbol ? `$${t.symbol}` : (t?.name ?? "");
    },
  };

  const timeline = donationTimeline(scoped.donations, labels, config.chainId);
  const board = causeLeaderboard(scoped.donations, labels);
  const total = scoped.donations.reduce((n, d) => n + usdcToUsd(d.amount), 0);
  const nameOfToken = (address: string) => {
    const t = tokenName.get(address.toLowerCase());
    return t ? tokenLabel(t) : `${address.slice(0, 6)}…${address.slice(-4)}`;
  };

  return (
    <section aria-label="Past epochs" className="grid grid-cols-1 gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid grid-cols-1 gap-1">
          <p className="kicker m-0">History</p>
          <h2 className="m-0 font-display text-2xl font-semibold text-ink">Past winners and what they received</h2>
        </div>
        {selected && (
          <div className="flex items-center gap-2.5">
            <Switch id={switchId} checked={onlySelected} onCheckedChange={setOnlySelected} />
            <label htmlFor={switchId} className="text-sm text-ink-soft">
              Only {selected.symbol ? `$${selected.symbol}` : selected.name}
            </label>
          </div>
        )}
      </div>

      {history.isLoading && (
        <div className="grid grid-cols-1 gap-2" role="status" aria-label="Loading history">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}
      {history.error && (
        <p role="alert" className="m-0 rounded-xl bg-terracotta-tint px-3 py-2 text-sm text-terracotta-strong">
          Could not load the history: {errorText(history.error)}
        </p>
      )}

      {history.data && scoped.epochs.length === 0 && scoped.donations.length === 0 && (
        <EmptyState
          size="compact"
          title={onlySelected && selected ? `No finished epochs for ${selected.symbol ? `$${selected.symbol}` : selected.name} yet` : "No epoch has finished yet"}
          body="When an epoch's tally is decrypted its winner and payout appear here."
        />
      )}

      {scoped.epochs.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-line bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Token</TableHead>
                <TableHead>Epoch</TableHead>
                <TableHead>Winner</TableHead>
                <TableHead className="text-right">Votes</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead>Finalized</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scoped.epochs.slice(0, 12).map((e) => (
                <TableRow key={`${e.token}-${e.epoch}`}>
                  <TableCell className="font-semibold">{nameOfToken(e.token)}</TableCell>
                  <TableCell className="num">{e.epoch}</TableCell>
                  <TableCell>{e.winningCauseId ? labels.cause(e.winningCauseId.toLowerCase()).name : "Fallback cause"}</TableCell>
                  <TableCell className="num text-right">{e.voteCount}</TableCell>
                  <TableCell className="num text-right">{BigInt(e.donatedAmount) > 0n ? usd(usdcToUsd(e.donatedAmount)) : "Not paid yet"}</TableCell>
                  <TableCell className="num text-ink-muted">{e.finalizedAt !== undefined ? formatTime(e.finalizedAt) : "unknown"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {(board.length > 0 || timeline.length > 0) && (
        <div className="grid grid-cols-1 gap-6 @3xl:grid-cols-2">
          {board.length > 0 && <CauseLeaderboard entries={board} title="Causes by USDC received" period={`${usd(total)} in the latest payouts`} headingLevel={3} />}
          {timeline.length > 0 && <DonationTimeline donations={timeline.slice(0, 8)} now={nowMs} title="Donations to winners" headingLevel={3} />}
        </div>
      )}
    </section>
  );
}
