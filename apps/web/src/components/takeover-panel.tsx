"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { useAccount } from "wagmi";
import { isAddress, type Address } from "viem";
import { TAKEOVER_AGAINST, TAKEOVER_FOR } from "@varada/sdk";
import { takeoverGovernorAbi } from "@varada/sdk/abis";
import { Button } from "@varada/ui/components/ui/button";
import { Card } from "@varada/ui/components/ui/card";
import { Field, FieldControl, FieldHint, FieldLabel } from "@varada/ui/components/ui/field";
import { Input } from "@varada/ui/components/ui/input";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { TakeoverCard, type TakeoverStatus } from "@varada/ui/components/varada/takeover-card";
import { useAppConfig, useDeps, usePrivateRpc } from "@/components/providers";
import { useCastBallot } from "@/components/use-cast-ballot";
import { errorText, formatTime, sameAddress, shortAddress, TxStatus, useTx } from "@/components/use-tx";
import { createAccountClient } from "@/lib/account-reads";
import { loadTakeovers } from "@/lib/data";
import type { TakeoverItem } from "@/lib/indexer";
import { untilText } from "@/lib/token-view";

const PENDING = new Set(["Active", "Closing", "Succeeded"]);

const STATE_LABELS: Record<string, string> = {
  None: "Unknown proposal",
  Active: "Voting open",
  Closing: "Voting ended, waiting for the tally",
  Defeated: "Defeated",
  Succeeded: "Succeeded, ready to execute",
  Executed: "Executed",
  Canceled: "Canceled",
  Expired: "Expired (not executed in time)",
  Superseded: "Superseded (a newer proposal for this token was executed)",
};

export function takeoverStateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

function formatDuration(seconds: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (seconds > 0 && seconds % 86400 === 0) return unit(seconds / 86400, "day");
  if (seconds > 0 && seconds % 3600 === 0) return unit(seconds / 3600, "hour");
  return `${seconds} s`;
}

/** `part / whole` as a percentage with two decimals, or null when `whole` is missing or zero. */
export function shareOf(part: string, whole: string | undefined): string | null {
  if (!whole || !/^\d+$/.test(whole) || !/^\d+$/.test(part) || BigInt(whole) === 0n) return null;
  const bp = (BigInt(part) * 10_000n) / BigInt(whole);
  return `${bp / 100n}.${(bp % 100n).toString().padStart(2, "0")}%`;
}

/** Community takeover: replace the profile controller by a FOR/AGAINST vote of holders. */
export function TakeoverPanel({ token, controller }: { token: Address; controller: string | null }) {
  const config = useAppConfig();
  const deps = useDeps();
  const governor = config.takeoverGovernorAddress;

  const list = useQuery({
    queryKey: ["takeovers", token],
    queryFn: () => loadTakeovers(config, deps, token),
    enabled: Boolean(governor),
    retry: false,
  });
  const params = useQuery({
    queryKey: ["takeover-params", governor],
    queryFn: () => deps.chain().readContract({ address: governor!, abi: takeoverGovernorAbi, functionName: "params" }),
    enabled: Boolean(governor),
    retry: false,
    staleTime: 600_000,
  });

  if (!governor) return null;
  const items = list.data?.data ?? [];
  const active = items.find((p) => PENDING.has(p.state)) ?? null;

  return (
    <section aria-label="Takeover" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 font-display text-2xl font-semibold">Community takeover</h2>
        <p className="m-0 text-sm text-ink-soft">Holders can vote to replace the profile controller (currently {controller ?? "none"}).</p>
      </div>
      {params.data && (
        <p className="m-0 text-sm text-ink-soft">
          Voting lasts {formatDuration(params.data.votingPeriod)}; quorum {params.data.quorumBps / 100}% of the circulating supply; proposing
          needs {params.data.proposalThresholdBps / 100}% of it; tokens must be {formatDuration(params.data.minTokenAge)} old. Holding
          period {formatDuration(params.data.lookback)}: your weight is the smaller of your votes at the snapshot and{" "}
          {formatDuration(params.data.lookback)} earlier.
        </p>
      )}
      {list.isLoading && (
        <div role="status" aria-label="Loading proposals">
          <Skeleton className="h-28 w-full rounded-2xl" />
        </div>
      )}
      {list.error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
          <span>Could not load proposals: {errorText(list.error)}</span>
          <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {active ? <ActiveProposal governor={governor} token={token} proposal={active} quorumBps={params.data?.quorumBps} /> : list.data && <ProposeForm governor={governor} token={token} />}
      {items.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="m-0 font-sans text-base font-semibold">History</h3>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm text-ink-soft">
            {items.map((p) => (
              <li key={p.proposalId} className="rounded-xl bg-sand/60 px-3 py-2">
                #{p.proposalId} {takeoverStateLabel(p.state)}: new controller {shortAddress(p.newController)}, proposed by {shortAddress(p.proposer)}, ends {formatTime(p.end)}
                {p.tallied && `, FOR ${p.forWeight} / AGAINST ${p.againstWeight} (quorum ${p.quorumWeight})`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const CARD_STATUS: Record<string, TakeoverStatus> = { Active: "active", Closing: "active", Succeeded: "passed", Executed: "executed" };

function ActiveProposal({ governor, token, proposal: p, quorumBps }: { governor: Address; token: Address; proposal: TakeoverItem; quorumBps?: number }) {
  const config = useAppConfig();
  const rpc = usePrivateRpc();
  const { address: account } = useAccount();
  const ballot = useCastBallot();
  const tx = useTx();
  const id = BigInt(p.proposalId);

  const accountClient = useMemo(() => (account ? createAccountClient(rpc, account) : null), [rpc, account]);
  const mine = useQuery({
    queryKey: ["takeover-account", p.proposalId, account],
    queryFn: async () => {
      const g = { address: governor, abi: takeoverGovernorAbi } as const;
      const [weight, voted] = await Promise.all([
        accountClient!.readContract({ ...g, functionName: "weightOf", args: [id, account!] }),
        accountClient!.readContract({ ...g, functionName: "hasVoted", args: [id, account!] }),
      ]);
      return { weight, voted };
    },
    enabled: Boolean(accountClient) && p.state === "Active",
    retry: false,
  });

  function action(functionName: "closeProposal" | "recordTally" | "execute" | "cancel") {
    tx.reset();
    void tx.send({ address: governor, abi: takeoverGovernorAbi, functionName, args: [id], chainId: config.chainId }).catch(() => {});
  }

  const voted = Boolean(mine.data?.voted);
  const circulating = p.circulatingWeight;
  const quorumPct = circulating && /^\d+$/.test(circulating) && BigInt(circulating) > 0n ? Number(shareOf(p.quorumWeight, circulating)?.replace("%", "")) : quorumBps !== undefined ? quorumBps / 100 : 0;
  const total = BigInt(p.forWeight) + BigInt(p.againstWeight);
  const pct = (w: string) => (total > 0n ? Number(((BigInt(w) * 10_000n) / total)) / 100 : undefined);
  const tallyKnown = p.tallied && circulating !== undefined && /^\d+$/.test(circulating) && BigInt(circulating) > 0n;
  const busy = ballot.phase === "encrypting" || ballot.tx.isPending;

  return (
    <div className="flex flex-col gap-3">
      <h3 className="m-0 font-sans text-base font-semibold">Proposal #{p.proposalId}: {takeoverStateLabel(p.state)}</h3>
      <TakeoverCard
        status={CARD_STATUS[p.state] ?? "failed"}
        proposal={
          <>
            Make <code className="num break-all">{p.newController}</code> the profile controller. Proposed by <code className="num break-all">{p.proposer}</code>.
          </>
        }
        turnout={tallyKnown ? Number(shareOf((total).toString(), circulating)!.replace("%", "")) : undefined}
        quorum={quorumPct}
        forPct={p.tallied ? pct(p.forWeight) : undefined}
        againstPct={p.tallied ? pct(p.againstWeight) : undefined}
        endsIn={p.end !== undefined && p.state === "Active" ? `ends in ${untilText(p.end, Date.now()) || "moments"}` : undefined}
        onVote={account ? (v) => void ballot.cast({ governor, token, scope: id, choice: v === "for" ? TAKEOVER_FOR : TAKEOVER_AGAINST }) : undefined}
        disabledReason={!account ? "Connect a wallet to vote." : voted ? "You have voted on this proposal." : busy ? "Your ballot is being sent." : undefined}
      />
      <dl className="m-0 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-ink-muted">Voting</dt>
          <dd className="num m-0">
            {formatTime(p.start)} to {formatTime(p.end)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">Execute before</dt>
          <dd className="num m-0">{formatTime(p.executionDeadline)}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">Weight snapshots</dt>
          <dd className="num m-0">
            {formatTime(p.snapshot)}
            {p.lookbackSnapshot !== undefined && ` and ${formatTime(p.lookbackSnapshot)} (the smaller counts)`}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">Quorum (whole tokens)</dt>
          <dd className="num m-0">
            {p.quorumWeight}
            {p.circulatingWeight !== undefined && ` of ${p.circulatingWeight} circulating`}
            {shareOf(p.quorumWeight, p.circulatingWeight) && ` (${shareOf(p.quorumWeight, p.circulatingWeight)})`}
          </dd>
        </div>
        {p.ballotCount > 0 && (
          <div>
            <dt className="text-ink-muted">Ballots</dt>
            <dd className="num m-0">{p.ballotCount}</dd>
          </div>
        )}
        {p.tallied && (
          <div>
            <dt className="text-ink-muted">Result</dt>
            <dd className="num m-0">
              FOR {p.forWeight}, AGAINST {p.againstWeight}
            </dd>
          </div>
        )}
      </dl>

      {p.state === "Active" && account && mine.data && (
        <p className="m-0 text-sm">
          Your weight: <span className="num font-semibold">{String(mine.data.weight)}</span>
          {mine.data.voted ? ". You have voted on this proposal." : ""}
        </p>
      )}
      {mine.error && <p role="alert" className="m-0 text-sm text-destructive">Could not read your weight: {errorText(mine.error)}</p>}
      {ballot.phase === "encrypting" && <p role="status" className="m-0 text-sm">Encrypting your ballot</p>}
      {ballot.error && <p role="alert" className="m-0 text-sm text-destructive">{ballot.error}</p>}
      <TxStatus tx={ballot.tx} label="Ballot" />

      <div className="flex flex-wrap gap-2">
        {p.state === "Closing" && !p.closed && (
          <Button type="button" variant="outline" onClick={() => action("closeProposal")} disabled={tx.isPending}>
            Close voting and request the tally
          </Button>
        )}
        {p.closed && !p.tallied && (
          <Button type="button" variant="outline" onClick={() => action("recordTally")} disabled={tx.isPending}>
            Record the decrypted tally
          </Button>
        )}
        {p.state === "Succeeded" && (
          <Button type="button" variant="cause" onClick={() => action("execute")} disabled={tx.isPending}>
            Execute: set the new controller
          </Button>
        )}
        {p.state === "Active" && sameAddress(account, p.proposer) && (
          <Button type="button" variant="ghost" onClick={() => action("cancel")} disabled={tx.isPending}>
            Cancel proposal
          </Button>
        )}
      </div>
      <TxStatus tx={tx} label="Takeover transaction" />
    </div>
  );
}

function ProposeForm({ governor, token }: { governor: Address; token: Address }) {
  const config = useAppConfig();
  const { address: account } = useAccount();
  const tx = useTx();
  const [newController, setNewController] = useState("");
  const [error, setError] = useState<string>();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    const v = newController.trim();
    if (!isAddress(v)) return setError("New controller must be an address");
    tx.reset();
    void tx.send({ address: governor, abi: takeoverGovernorAbi, functionName: "propose", args: [token, v], chainId: config.chainId }).catch(() => {});
  }

  return (
    <Card tone="sand" className="p-4">
      <form onSubmit={onSubmit} aria-label="Propose takeover" className="flex flex-col gap-3">
        <p className="m-0 text-sm">No takeover is pending.</p>
        <Field invalid={Boolean(error)}>
          <FieldLabel>Propose a new controller</FieldLabel>
          <FieldControl>
            <Input value={newController} onChange={(e) => setNewController(e.target.value)} placeholder="0x..." className="num" />
          </FieldControl>
          <FieldHint>The address that would control the token&apos;s profile if holders pass the vote.</FieldHint>
        </Field>
        {error && <p role="alert" className="m-0 text-sm font-medium text-destructive">{error}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="outline" disabled={!account || tx.isPending}>
            Propose takeover
          </Button>
          {!account && <span className="text-sm text-ink-soft">Connect a wallet to propose.</span>}
        </div>
        <TxStatus tx={tx} label="Proposal" />
      </form>
    </Card>
  );
}
