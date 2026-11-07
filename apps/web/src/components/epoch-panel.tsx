"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { argmax, MAX_BALLOT_OPTIONS, REGIONS } from "@varada/sdk";
import { epochGovernorAbi } from "@varada/sdk/abis";
import { Badge } from "@varada/ui/components/ui/badge";
import { Button } from "@varada/ui/components/ui/button";
import { Card } from "@varada/ui/components/ui/card";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { BallotList } from "@varada/ui/components/varada/ballot-list";
import type { BallotOptionData, BallotSource } from "@varada/ui/components/varada/ballot-option";
import { CauseIcon, CAUSE_SHORT_LABELS } from "@varada/ui/components/varada/cause-icon";
import { VoteFlowDialog, type VoteFlowState } from "@varada/ui/components/varada/vote-flow-dialog";
import { useCatalogNames } from "@/components/catalog-browser";
import { EpochPhaseStrip } from "@/components/epoch-phase";
import { useNowSeconds } from "@/components/governance/hooks";
import { OpenBallot } from "@/components/open-ballot";
import { useAppConfig, useDeps, usePrivateRpc } from "@/components/providers";
import { useCastBallot } from "@/components/use-cast-ballot";
import { errorText, formatTime, TxStatus } from "@/components/use-tx";
import { createAccountClient } from "@/lib/account-reads";
import { loadCauses, loadEpochView } from "@/lib/data";
import type { CatalogOrg, CauseSummary, EpochDetail, OptionSource, TokenDetail } from "@/lib/indexer";
import { timingOf, timingPhase } from "@/lib/epoch-timing";
import { ballotOptions } from "@/lib/profile";
import { causeNameOfOrg } from "@/lib/token-data";

export function useCauses() {
  const deps = useDeps();
  return useQuery({ queryKey: ["causes"], queryFn: () => loadCauses(deps), retry: false, staleTime: 300_000 });
}

/** Registry name first, then the catalogue name (catalogue orgs reach the registry only when they win). */
export function causeName(causes: Map<string, CauseSummary> | undefined, id: string, catalog?: Map<string, { name: string }>): string {
  return causes?.get(id.toLowerCase())?.name ?? catalog?.get(id.toLowerCase())?.name ?? id;
}

export const OPTION_SOURCE_LABELS: Record<OptionSource, string> = { pinned: "Pinned", curated: "Curated", rotation: "Rotation" };

const OPTION_SOURCE_TITLES: Record<OptionSource, string> = {
  pinned: "Pinned by the token's controller",
  curated: "Picked by the curator agent for one of the token's causes",
  rotation: "Drawn in rotation from the token's focus pool",
};

/**
 * Source of each option shown: before the ballot is prepared the options are the token's pins;
 * after, the indexer's per-option sources (null entries when it does not report them, e.g. an
 * older indexer or the chain fallback).
 */
export function shownOptionSources(frozen: boolean, options: readonly string[], ed: Pick<EpochDetail, "options" | "optionSources"> | null): (OptionSource | null)[] {
  if (!frozen) return options.map(() => "pinned");
  const given = ed?.optionSources;
  if (!given || given.length !== options.length) return options.map(() => null);
  return given.map((s) => s ?? null);
}

/** "2 pinned, 3 curated, 27 rotation", counting only known sources; null when none is known. */
export function ballotMakeup(sources: readonly (OptionSource | null)[]): string | null {
  const parts = (["pinned", "curated", "rotation"] as const)
    .map((k) => [k, sources.filter((s) => s === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return parts.length > 0 && sources.every((s) => s !== null) ? parts.join(", ") : null;
}

/** The pin / curated / rotation split of a ballot, for the pool card; null unless every source is known. */
export function ballotMix(sources: readonly (OptionSource | null)[]): { pinned: number; curated: number; rotation: number } | null {
  if (sources.length === 0 || sources.some((s) => s === null)) return null;
  const n = (k: OptionSource) => sources.filter((s) => s === k).length;
  return { pinned: n("pinned"), curated: n("curated"), rotation: n("rotation") };
}

export function pollState(detail: { poll: { opened: boolean; closed: boolean; isFinal: boolean } | null; finalized?: boolean } | null): string {
  const poll = detail?.poll;
  if (detail?.finalized) return "Finalized";
  if (!poll || !poll.opened) return "Not opened yet (opens when the ballot is prepared)";
  if (poll.isFinal) return "Tally decrypted";
  if (poll.closed) return "Closed, waiting for the tally to be decrypted";
  return "Open for ballots";
}

function stateTone(detail: Parameters<typeof pollState>[0]): "cause" | "neutral" | "rwa" {
  if (detail?.finalized || detail?.poll?.isFinal) return "neutral";
  if (detail?.poll?.opened && !detail.poll.closed) return "cause";
  return "rwa";
}

const regionsText = (org: CatalogOrg | undefined): string => {
  if (!org) return "Region not listed";
  const names = org.regions.map((s) => REGIONS.find((r) => r.slug === s)?.label ?? s);
  return names.length > 0 ? names.join(", ") : "Global";
};

/** The current epoch's view (shared by the panel and the pool card through the query cache). */
export function useEpochView(token: Address, openedHere = false) {
  const config = useAppConfig();
  const deps = useDeps();
  return useQuery({
    queryKey: ["epoch-view", token, openedHere],
    queryFn: () => loadEpochView(config, deps, token, { chainFirst: openedHere }),
    enabled: Boolean(config.governorAddress),
    retry: false,
    refetchInterval: (q) => (openedHere && !q.state.data?.detail?.prepared ? 3_000 : false),
  });
}

/** Read-only option rows: pins before the ballot is prepared, and the results once it is closed. */
function OptionRows({ rows }: { rows: { id: string; name: string; org: CatalogOrg | undefined; source: OptionSource | null; votes?: string; leading?: boolean }[] }) {
  return (
    <ol start={0} className="m-0 grid list-none gap-2 p-0">
      {rows.map((r) => (
        <li key={r.id} className="flex min-w-0 items-center gap-3 rounded-2xl border border-line bg-paper-card px-3 py-2.5">
          <CauseIcon cause={causeNameOfOrg(r.org)} size={36} decorative />
          <span className="flex min-w-0 flex-1 flex-col">
            <strong className="truncate text-[15px]">{r.name}</strong>
            <span className="truncate text-xs text-ink-muted">
              {CAUSE_SHORT_LABELS[causeNameOfOrg(r.org)]} · {regionsText(r.org)}
            </span>
          </span>
          {r.votes !== undefined ? (
            <span className="num shrink-0 text-sm text-ink">
              {r.votes} votes{r.leading ? ", leading" : ""}
            </span>
          ) : null}
          {r.source ? (
            <small data-source={r.source} title={OPTION_SOURCE_TITLES[r.source]} className="shrink-0 rounded-full bg-sand px-2.5 py-0.5 text-[11px] font-bold text-ink-soft">
              {OPTION_SOURCE_LABELS[r.source]}
            </small>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** The token's current epoch: options, poll state, the connected account's weight, and the vote flow. */
export function EpochPanel({ token, detail }: { token: Address; detail: TokenDetail }) {
  const config = useAppConfig();
  const rpc = usePrivateRpc();
  const { address: account } = useAccount();
  const causes = useCauses();

  // Set once this page opened the ballot (or found it opened on chain): read the chain first, and
  // poll until it reports the ballot prepared, rather than wait for the indexer to see the block.
  const [openedHere, setOpenedHere] = useState(false);
  const markOpened = useCallback(() => setOpenedHere(true), []);
  const view = useEpochView(token, openedHere);
  const epoch = view.data?.epoch;
  const ed = view.data?.detail ?? null;
  // Trading until `votingOpensAt` (the governor refuses ballots with VotingNotOpen), then voting until the end.
  const now = useNowSeconds(1_000);
  const timing = timingOf(ed);
  const phase = timing ? timingPhase(timing, now) : null;
  const { options, frozen } = ballotOptions({
    prepared: Boolean(ed?.prepared || ed?.poll?.opened),
    epochOptions: ed?.options ?? [],
    pinned: detail.shortlist,
  });
  const sources = shownOptionSources(frozen, options, ed);
  const makeup = frozen ? ballotMakeup(sources) : null;
  const names = useCatalogNames([...options, ...(ed?.winningCause ? [ed.winningCause] : [])]);
  const nameOf = (id: string) => causeName(causes.data, id, names.data);

  // Address-keyed reads go through the account's own isolated client, never the indexer.
  const accountClient = useMemo(() => (account ? createAccountClient(rpc, account) : null), [rpc, account]);
  const mine = useQuery({
    queryKey: ["epoch-account", token, epoch?.toString(), account],
    queryFn: async () => {
      const g = { address: config.governorAddress as Address, abi: epochGovernorAbi } as const;
      const [weight, voted] = await Promise.all([
        accountClient!.readContract({ ...g, functionName: "weightOf", args: [token, epoch!, account!] }),
        accountClient!.readContract({ ...g, functionName: "hasVoted", args: [token, epoch!, account!] }),
      ]);
      return { weight, voted };
    },
    enabled: Boolean(accountClient && epoch !== undefined && config.governorAddress),
    retry: false,
  });

  const ballot = useCastBallot();
  const [choice, setChoice] = useState<string>("");
  const [formError, setFormError] = useState<string>();
  const [dialog, setDialog] = useState(false);
  const failedStep = useRef<0 | 1 | 2>(1);
  const lastPhase = useRef(ballot.phase);
  useEffect(() => {
    if (ballot.phase === "error") failedStep.current = lastPhase.current === "encrypting" || lastPhase.current === "scanning" ? 0 : lastPhase.current === "sent" ? 2 : 1;
    lastPhase.current = ballot.phase;
  }, [ballot.phase]);

  if (!config.governorAddress) {
    return (
      <section aria-label="Current epoch">
        <h2>Current epoch</h2>
        <p>governorAddress is not configured (config.json)</p>
      </section>
    );
  }

  const index = choice === "" ? null : Number(choice);
  const ballotData: BallotOptionData[] = options.map((id, i) => {
    const org = names.data?.get(id.toLowerCase());
    return { id: String(i), org: nameOf(id), category: causeNameOfOrg(org), region: regionsText(org), source: (sources[i] ?? undefined) as BallotSource | undefined };
  });

  function onVote(e: FormEvent) {
    e.preventDefault();
    setFormError(undefined);
    if (epoch === undefined) return setFormError("Current epoch unknown");
    if (!frozen) return setFormError("The ballot is not prepared yet");
    if (index === null || index >= options.length) return setFormError("Choose a cause");
    ballot.tx.reset();
    setDialog(true);
  }

  function confirm() {
    if (epoch === undefined || index === null) return;
    const scheme = ed?.poll?.scheme as Address | undefined;
    void ballot.cast({ governor: config.governorAddress!, token, scope: epoch, choice: index, scheme, holdScan: { kind: "epoch", token, epoch } });
  }

  const counts = ed?.poll?.isFinal ? ed.poll.counts : null;
  const leader = counts ? argmax(counts.map((c) => BigInt(c))) : -1;
  const voteOpen = frozen && options.length > 1 && !ed?.poll?.closed && !mine.data?.voted && phase !== "trading" && phase !== "ended";
  // The hold scan runs ahead of encryption, in the same "prepare" step.
  const flow: VoteFlowState = ballot.phase === "encrypting" || ballot.phase === "scanning" ? "encrypting" : ballot.phase === "signing" ? "wallet" : ballot.phase === "sent" ? "sent" : ballot.phase === "error" ? "error" : "confirm";
  const chosen = index !== null ? ballotData[index] : undefined;

  return (
    <section aria-label="Current epoch" className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 font-display text-2xl font-semibold">Current epoch{epoch !== undefined ? ` ${epoch}` : ""}</h2>
          {view.data ? <Badge tone={stateTone(ed)}>{pollState(ed)}</Badge> : null}
        </div>
        {view.isLoading ? (
          <div role="status" aria-label="Loading epoch" className="flex flex-col gap-2">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-24 w-full rounded-2xl" />
          </div>
        ) : null}
        {view.error ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
            <span>Could not load the epoch: {errorText(view.error)}</span>
            <Button variant="outline" size="sm" onClick={() => void view.refetch()}>
              Try again
            </Button>
          </div>
        ) : null}
        {view.data ? (
          <>
            {view.data.source === "chain" ? <p role="note" className="m-0 text-sm text-ink-muted">Epoch read directly from the chain.</p> : null}
            {timing ? <EpochPhaseStrip timing={timing} epoch={epoch} onChange={() => void view.refetch()} /> : null}
            <dl className="m-0 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-ink-muted">Voting window</dt>
                <dd className="num m-0">
                  {formatTime(timing?.votingOpensAt)} to {formatTime(timing?.end)}
                </dd>
              </div>
              <div>
                <dt className="text-ink-muted">Weight snapshot</dt>
                <dd className="num m-0">{formatTime(ed?.snapshot)}</dd>
              </div>
              {ed?.poll ? (
                <div>
                  <dt className="text-ink-muted">Ballots</dt>
                  <dd className="num m-0">{ed.poll.ballotCount}</dd>
                </div>
              ) : null}
              {ed?.winningCause ? (
                <div>
                  <dt className="text-ink-muted">Winning cause</dt>
                  <dd className="m-0">{nameOf(ed.winningCause)}</dd>
                </div>
              ) : null}
            </dl>
            {ed?.poolSize !== undefined && frozen ? <p className="m-0 text-sm text-ink-soft">Drawn from a focus pool of {ed.poolSize} organizations.</p> : null}
            {makeup ? (
              <p className="m-0 text-sm text-ink-soft">
                Options: {makeup}. Pinned causes come first, then the curator agents&apos; picks, then rotation draws.
              </p>
            ) : null}
            {!frozen ? (
              <p role="note" className="m-0 text-sm text-ink-soft">
                This epoch&apos;s ballot is not prepared yet. {options.length > 0 ? "The pinned causes below lead it; " : ""}up to{" "}
                {detail.ballotSize?.size ?? MAX_BALLOT_OPTIONS} options are filled from the curator agents&apos; picks and then in rotation from the token&apos;s focus pool
                when it is prepared{timing ? `. Ballots are accepted from ${formatTime(timing.votingOpensAt)}` : ", and voting opens then"}.
              </p>
            ) : null}
            {frozen && options.length === 0 && ed?.ballotUnavailable ? (
              <p role="note" className="m-0 text-sm text-ink-soft">This epoch&apos;s ballot is prepared, but its options could not be read from the chain right now. Try again later.</p>
            ) : null}
            {frozen && options.length === 0 && !ed?.ballotUnavailable ? <p className="m-0 text-sm text-ink-soft">This epoch&apos;s ballot has no options; it pays the platform&apos;s fallback cause.</p> : null}
          </>
        ) : null}
      </Card>

      {view.data && options.length > 0 && !(account && voteOpen) ? (
        <OptionRows
          rows={options.map((id, i) => ({
            id,
            name: nameOf(id),
            org: names.data?.get(id.toLowerCase()),
            source: sources[i] ?? null,
            votes: counts ? (counts[i] ?? "0") : undefined,
            leading: counts ? i === leader : undefined,
          }))}
        />
      ) : null}

      {!account ? (
        <p className="m-0 text-sm text-ink-soft">Connect a wallet to see your voting weight and vote.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {mine.isLoading ? <p role="status" className="m-0 text-sm text-ink-soft">Reading your weight privately</p> : null}
          {mine.error ? <p role="alert" className="m-0 text-sm text-destructive">Could not read your weight: {errorText(mine.error)}</p> : null}
          {mine.data ? (
            <p className="m-0 text-sm text-ink">
              Your weight: <span className="num font-semibold">{String(mine.data.weight)}</span> (whole tokens held at the snapshot){mine.data.voted ? ". You have voted in this epoch." : ""}
            </p>
          ) : null}
          {!frozen && view.data && epoch !== undefined ? <OpenBallot token={token} epoch={epoch} onOpened={markOpened} /> : null}
          {frozen && phase === "trading" && timing ? (
            <p role="status" className="m-0 text-sm text-ink-soft">
              Voting is not open yet, so ballots are refused for now. It opens at {formatTime(timing.votingOpensAt)}; until then holders trade.
            </p>
          ) : null}
          {frozen && phase === "ended" ? <p role="status" className="m-0 text-sm text-ink-soft">Voting has closed for this epoch.</p> : null}
          {voteOpen ? (
            <form onSubmit={onVote} aria-label="Vote" className="flex flex-col gap-3">
              <BallotList
                options={ballotData}
                value={choice}
                onValueChange={setChoice}
                label="Vote for a cause"
                footer={
                  <div className="flex flex-col gap-3 @2xl:flex-row @2xl:items-center @2xl:justify-between">
                    <p className="m-0 text-sm text-ink-soft">
                      Ballot: {ballot.adapter.label}. Your choice is encrypted in this browser; nobody sees it before the tally.
                    </p>
                    <Button type="submit" variant="cause" disabled={ballot.phase === "scanning" || ballot.phase === "encrypting" || ballot.tx.isPending}>
                      {ballot.phase === "scanning" ? `Reading hold history${ballot.scan ? ` ${ballot.scan.done + 1}/${ballot.scan.total}` : ""}` : ballot.phase === "encrypting" ? "Encrypting" : ballot.tx.isPending ? "Confirm in wallet" : "Vote privately"}
                    </Button>
                  </div>
                }
              />
              {ballot.adapter.placeholder ? <p role="note" className="m-0 text-sm text-destructive">DEVELOPMENT BUILD: this ballot is not private.</p> : null}
              {formError ? <p role="alert" className="m-0 text-sm text-destructive">{formError}</p> : null}
              {ballot.error && !dialog ? <p role="alert" className="m-0 text-sm text-destructive">{ballot.error}</p> : null}
            </form>
          ) : null}
        </div>
      )}

      {chosen ? (
        <VoteFlowDialog
          open={dialog}
          onOpenChange={(o) => {
            setDialog(o);
            if (!o && ballot.phase === "error") ballot.tx.reset();
          }}
          state={flow}
          choice={{ org: chosen.org, category: chosen.category }}
          weight={`${mine.data ? String(mine.data.weight) : "0"} $${detail.symbol || "TOKEN"}`}
          onConfirm={confirm}
          onRetry={confirm}
          error={ballot.error}
          failedStep={failedStep.current}
          sentFooter={<TxStatus tx={ballot.tx} label="Ballot" />}
        />
      ) : null}
    </section>
  );
}
