"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TakeoverCard, type TakeoverStatus, type TakeoverVote } from "@varada/ui/components/varada/takeover-card";
import { VoteFlowDialog } from "@varada/ui/components/varada/vote-flow-dialog";
import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { TAKEOVER_AGAINST, TAKEOVER_FOR } from "@varada/sdk";
import { takeoverGovernorAbi } from "@varada/sdk/abis";
import { useSiteRel as useRel } from "@/components/governance/use-rel";
import { useAppConfig, useDeps, usePrivateRpc } from "@/components/providers";
import { useCastBallot } from "@/components/use-cast-ballot";
import { errorText, shortAddress } from "@/components/use-tx";
import { useNowSeconds } from "@/components/governance/hooks";
import { useWalletGate } from "@/components/governance/use-wallet-gate";
import { createAccountClient } from "@/lib/account-reads";
import { loadTakeovers } from "@/lib/data";
import { formatWeight } from "@/lib/governance";
import type { TakeoverItem, TokenSummary } from "@/lib/indexer";

/** How many proposals to show as cards; older ones stay on the token page. */
const SHOWN = 3;

/** The library's three-way status for a governor state. */
export function cardStatus(state: string): TakeoverStatus {
  switch (state) {
    case "Active":
    case "Closing":
      return "active";
    case "Succeeded":
      return "passed";
    case "Executed":
      return "executed";
    default:
      return "failed";
  }
}

/** `part / whole` as a percentage with at most one decimal; null without a usable whole. */
export function percentOf(part: string, whole: string | undefined): number | null {
  if (!whole || !/^\d+$/.test(whole) || !/^\d+$/.test(part) || BigInt(whole) === 0n) return null;
  return Number((BigInt(part) * 1000n) / BigInt(whole)) / 10;
}

/** "Ends in 1d 6h", "Ends in 3h 20m", or "Voting ended". */
export function endsInText(end: number | undefined, nowSeconds: number): string | undefined {
  if (end === undefined) return undefined;
  const left = end - nowSeconds;
  if (left <= 0) return "Voting ended";
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  return `Ends in ${d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${Math.max(m, 1)}m`}`;
}

const FAILED_TEXT: Record<string, string> = {
  Defeated: "Defeated: FOR did not reach quorum or beat AGAINST.",
  Canceled: "Canceled by its proposer.",
  Expired: "Expired: nobody executed it in time.",
  Superseded: "Superseded: a newer takeover of this token was executed.",
  Succeeded: "Succeeded. Anyone can execute it from the token page.",
};

/**
 * Holder polls to replace a token's controller (`TakeoverGovernor`): quorum and For / Against on the
 * library's `TakeoverCard`, voting through the same encrypted ballot flow as the weekly vote.
 * Proposing, closing and executing live on the token page.
 */
export function TakeoverPolls({ token }: { token: TokenSummary }) {
  const config = useAppConfig();
  const deps = useDeps();
  const rel = useRel();
  const governor = config.takeoverGovernorAddress;
  const address = token.address as Address;
  const now = useNowSeconds();

  const list = useQuery({
    queryKey: ["takeovers", address],
    queryFn: () => loadTakeovers(config, deps, address),
    enabled: Boolean(governor),
    retry: false,
  });

  if (!governor) return null;
  const items = (list.data?.data ?? []).slice(0, SHOWN);
  if (!list.isLoading && !list.error && items.length === 0) return null;

  return (
    <section aria-label="Takeover polls" className="grid grid-cols-1 gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 font-display text-xl font-semibold text-ink">Takeover polls</h3>
        <a href={rel(`token/?address=${token.address}`)} className="inline-flex min-h-11 items-center text-sm font-semibold text-primary underline-offset-4 hover:underline">
          Propose or execute on the token page
        </a>
      </div>
      {list.isLoading && <p role="status" className="m-0 text-sm text-ink-soft">Loading proposals</p>}
      {list.error && (
        <p role="alert" className="m-0 rounded-xl bg-terracotta-tint px-3 py-2 text-sm text-terracotta-strong">
          Could not load proposals: {errorText(list.error)}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3">
        {items.map((p) => (
          <Proposal key={p.proposalId} governor={governor} token={token} proposal={p} now={now} />
        ))}
      </div>
    </section>
  );
}

function Proposal({ governor, token, proposal: p, now }: { governor: Address; token: TokenSummary; proposal: TakeoverItem; now: number }) {
  const rpc = usePrivateRpc();
  const queryClient = useQueryClient();
  const gate = useWalletGate();
  const { address: account } = useAccount();
  const id = BigInt(p.proposalId);
  const symbol = token.symbol || "token";
  const ballot = useCastBallot({ description: `Takeover #${p.proposalId} of ${token.symbol ? `$${token.symbol}` : token.name}` });
  const [pick, setPick] = useState<TakeoverVote | null>(null);
  const [open, setOpen] = useState(false);

  const accountClient = useMemo(() => (account ? createAccountClient(rpc, account) : null), [rpc, account]);
  const mine = useQuery({
    queryKey: ["takeover-account", p.proposalId, account?.toLowerCase()],
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

  const confirmed = ballot.tx.receipt?.status === "success";
  useEffect(() => {
    if (confirmed) void queryClient.invalidateQueries({ queryKey: ["takeover-account", p.proposalId] });
  }, [confirmed, queryClient, p.proposalId]);

  const status = cardStatus(p.state);
  const circulating = p.circulatingWeight;
  const quorumPct = percentOf(p.quorumWeight, circulating);
  const decided = p.tallied;
  const cast = decided ? BigInt(p.forWeight) + BigInt(p.againstWeight) : 0n;
  const turnoutPct = decided ? (percentOf(cast.toString(), circulating) ?? 0) : 0;
  const forPct = decided && cast > 0n ? (percentOf(p.forWeight, cast.toString()) ?? undefined) : undefined;
  const againstPct = forPct !== undefined ? Math.round((100 - forPct) * 10) / 10 : undefined;

  const disabledReason =
    p.state === "Closing"
      ? "Voting has ended. The tally is being counted."
      : !gate.connected
        ? "Connect a wallet to vote."
        : gate.wrongChain
          ? "Switch your wallet to Ethereum mainnet to vote."
          : mine.isLoading
            ? "Reading your voting weight privately…"
            : mine.error
              ? `Could not read your weight: ${errorText(mine.error)}`
              : mine.data?.voted
                ? "You have voted on this proposal."
                : mine.data && mine.data.weight === 0n
                  ? `Hold $${symbol} at the snapshot (and for the holding period) to vote.`
                  : undefined;

  function confirm() {
    if (!pick) return;
    void ballot.cast({ governor, token: token.address as Address, scope: id, choice: pick === "for" ? TAKEOVER_FOR : TAKEOVER_AGAINST });
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next && ballot.phase !== "encrypting" && ballot.phase !== "signing") ballot.reset();
  }

  const phase = ballot.phase;
  const dialogState = phase === "encrypting" ? "encrypting" : phase === "signing" ? "wallet" : phase === "sent" ? "sent" : phase === "error" ? "error" : "confirm";

  return (
    <div className="grid grid-cols-1 gap-2">
      <TakeoverCard
        status={status}
        proposal={
          <>
            Replace the controller of {token.name || shortAddress(token.address)} with <code className="break-all font-mono text-[13px]">{p.newController}</code>, proposed by{" "}
            <code className="font-mono text-[13px]">{shortAddress(p.proposer)}</code>.
            {!decided && p.state !== "Executed" ? ` ${p.ballotCount} ${p.ballotCount === 1 ? "ballot" : "ballots"} cast; turnout stays encrypted until the tally.` : ""}
            {FAILED_TEXT[p.state] && status !== "active" ? ` ${FAILED_TEXT[p.state]}` : ""}
          </>
        }
        turnout={turnoutPct}
        quorum={quorumPct ?? 0}
        forPct={forPct}
        againstPct={againstPct}
        endsIn={status === "active" ? endsInText(p.end, now) : undefined}
        disabledReason={status === "active" ? disabledReason : undefined}
        onVote={(v) => {
          setPick(v);
          ballot.reset();
          setOpen(true);
        }}
      />
      {circulating !== undefined && quorumPct === null && (
        <p className="m-0 text-xs text-ink-muted">Quorum is {formatWeight(Number(p.quorumWeight))} tokens.</p>
      )}
      <VoteFlowDialog
        open={open && pick !== null}
        onOpenChange={onOpenChange}
        state={dialogState}
        choice={{ org: pick === "for" ? "Vote FOR the takeover" : "Vote AGAINST the takeover", category: "other" }}
        weight={mine.data ? `${formatWeight(mine.data.weight)} $${symbol}` : `0 $${symbol}`}
        onConfirm={confirm}
        onRetry={confirm}
        error={ballot.error}
        failedStep={ballot.failedStep}
      />
    </div>
  );
}
