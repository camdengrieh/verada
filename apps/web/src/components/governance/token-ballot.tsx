"use client";

import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@varada/ui/components/ui/badge";
import { Button } from "@varada/ui/components/ui/button";
import { ArrowUpRight, ExternalLink, Info, Vote } from "@varada/ui/components/ui/icons";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { MobileVoteSheet } from "@varada/ui/components/mobile/mobile-vote-sheet";
import { BallotList } from "@varada/ui/components/varada/ballot-list";
import { PrivacyPill } from "@varada/ui/components/varada/privacy-pill";
import { VoteFlowDialog, type VoteFlowState } from "@varada/ui/components/varada/vote-flow-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { MAX_BALLOT_OPTIONS } from "@varada/sdk";
import { ConnectButton } from "@/components/connect-button";
import { agentsForFocus, getAgentReport } from "@/lib/agents";
import { useRel } from "@/components/nav";
import { OpenBallot } from "@/components/open-ballot";
import { usePrivacyState, openPrivacyDetails } from "@/components/privacy-status";
import { useAppConfig, useDeps } from "@/components/providers";
import { useCastBallot } from "@/components/use-cast-ballot";
import { errorText, formatTime } from "@/components/use-tx";
import { CuratorPicks, type AgentPicks } from "@/components/governance/curator-picks";
import { useAgentList, useCatalogOrgs, useCauseRegistry, useNowSeconds, useStanding } from "@/components/governance/hooks";
import { TallyResults } from "@/components/governance/results";
import { useIsPhone } from "@/components/governance/use-media";
import { useWalletGate } from "@/components/governance/use-wallet-gate";
import { loadEpochView, loadTokenDetail } from "@/lib/data";
import { txUrl } from "@/lib/explorer";
import {
  ballotMakeup,
  epochStatus,
  formatWeight,
  optionName,
  optionSources,
  pickIndex,
  tallyResults,
  toBallotOptions,
  tokenLogoUrl,
  usdcToUsd,
  type EpochClock,
} from "@/lib/governance";
import type { TokenSummary } from "@/lib/indexer";
import { label as tokenLabel } from "@/lib/indexer";
import { ballotOptions } from "@/lib/profile";

const NOTE = "m-0 rounded-xl px-3 py-2 text-sm";

/** Maps the cast hook's phase onto the library dialog's steps. */
function flowState(phase: ReturnType<typeof useCastBallot>["phase"]): VoteFlowState {
  switch (phase) {
    case "encrypting":
      return "encrypting";
    case "signing":
      return "wallet";
    case "sent":
      return "sent";
    case "error":
      return "error";
    default:
      return "confirm";
  }
}

/**
 * One token's ballot for the current epoch: where it stands, the options (search and Pinned /
 * Curated / Rotation tabs), the curator agents behind the picks, the encrypted vote flow and, once
 * the tally is decrypted, the results. Address-keyed reads (weight, have-I-voted) use the account's
 * own private client; nothing about the viewer goes to the indexer.
 */
export function TokenBallot({ token, clock }: { token: TokenSummary; clock: EpochClock | undefined }) {
  const config = useAppConfig();
  const deps = useDeps();
  const rel = useRel();
  const queryClient = useQueryClient();
  const gate = useWalletGate();
  const privacy = usePrivacyState();
  const isPhone = useIsPhone();
  const now = useNowSeconds();
  const address = token.address as Address;

  const detail = useQuery({
    queryKey: ["token-detail", address],
    queryFn: () => loadTokenDetail(config, deps, address),
    enabled: Boolean(config.governorAddress),
    retry: false,
  });
  const td = detail.data?.data ?? null;

  // Set once this page opened the ballot (or found it opened on chain): read the chain first, and
  // poll until it reports the ballot prepared, rather than wait for the indexer to see the block.
  const [openedHere, setOpenedHere] = useState(false);
  const markOpened = useCallback(() => setOpenedHere(true), []);
  const view = useQuery({
    queryKey: ["epoch-view", address, openedHere],
    queryFn: () => loadEpochView(config, deps, address, { chainFirst: openedHere }),
    enabled: Boolean(config.governorAddress),
    retry: false,
    refetchInterval: (q) => (openedHere && !q.state.data?.detail?.prepared ? 3_000 : false),
  });
  const epoch = view.data?.epoch;
  const ed = view.data?.detail ?? null;
  const { options, frozen } = ballotOptions({
    prepared: Boolean(ed?.prepared || ed?.poll?.opened),
    epochOptions: ed?.options ?? [],
    pinned: td?.shortlist ?? null,
  });
  const sources = optionSources(frozen, options, ed);
  const makeup = frozen ? ballotMakeup(sources) : null;
  const status = epochStatus(ed, now);

  const orgs = useCatalogOrgs(options);
  const causes = useCauseRegistry();
  const names = { orgs: orgs.data ?? undefined, causes: causes.data };
  const nameOf = (id: string) => optionName(id, names);

  // Curator agents of the token's causes, and the picks they published for this ballot.
  const agents = useAgentList();
  const tokenAgents = useMemo(() => agentsForFocus(agents.data ?? [], td?.focus).filter((a) => a.latest), [agents.data, td?.focus]);
  const reports = useQueries({
    queries: tokenAgents.map((a) => ({
      queryKey: ["agent-report", a.label, a.latest!.epoch],
      queryFn: () => getAgentReport(deps.indexer, a.label, a.latest!.epoch),
      retry: false,
      staleTime: 300_000,
    })),
  });
  const agentPicks: AgentPicks[] = tokenAgents.map((agent, i) => ({ agent, report: reports[i]?.data ?? null }));
  const scores = useMemo(() => {
    const idx = pickIndex(agentPicks.map((a) => ({ agent: a.agent.label, report: a.report })));
    return new Map([...idx].map(([k, v]) => [k, v.score]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reports.map((r) => r.dataUpdatedAt).join(","), tokenAgents.length]);

  const optionData = useMemo(
    () => toBallotOptions({ options, sources, orgs: orgs.data ?? undefined, causes: causes.data, scores, focus: td?.focus }),
    [options, sources, orgs.data, causes.data, scores, td?.focus],
  );
  const sourcesUnknown = frozen && sources.some((s) => s === null);

  // The viewer's weight and whether they voted.
  const standing = useStanding(address, epoch, status.phase === "open");
  const symbol = token.symbol || "token";
  const weightText = standing.data ? `${formatWeight(standing.data.weight)} $${symbol}` : "";

  const ballot = useCastBallot({ description: `${tokenLabel(token)}${epoch !== undefined ? `, epoch ${epoch}` : ""}` });
  const [choiceId, setChoiceId] = useState("");
  const selected = optionData.find((o) => o.id === choiceId);
  const [flowOpen, setFlowOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  // A confirmed ballot changes the weight reading's `voted` and the poll's ballot count.
  const voteConfirmed = ballot.tx.receipt?.status === "success";
  useEffect(() => {
    if (!voteConfirmed) return;
    void queryClient.invalidateQueries({ queryKey: ["standing"] });
    void queryClient.invalidateQueries({ queryKey: ["epoch-view", address] });
  }, [voteConfirmed, queryClient, address]);

  // Switching tokens starts a fresh choice.
  useEffect(() => {
    setChoiceId("");
    setFlowOpen(false);
    setSheetOpen(false);
    ballot.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  if (!config.governorAddress) return null;

  const logo = tokenLogoUrl(config.swarmGatewayUrl, td?.profile?.logoRef ?? td?.logoRef ?? token.logoRef);
  const name = tokenLabel(token);

  // Why the vote button is off, most basic reason first.
  const voteBlocker: string | null =
    status.phase === "counting"
      ? "Voting has closed. The tally is being counted."
      : status.phase === "tallied" || status.phase === "finalized"
        ? "Voting has ended for this epoch."
        : status.phase === "unopened"
          ? "The ballot has not been opened yet."
          : options.length < 2
            ? "This ballot has fewer than two options."
            : !gate.connected
              ? "Connect a wallet to vote."
              : gate.wrongChain
                ? "Your wallet is on a different network than Varada."
                : standing.isLoading
                  ? "Reading your voting weight privately…"
                  : standing.error
                    ? `Could not read your weight: ${errorText(standing.error)}`
                    : standing.data?.voted
                      ? "You have voted in this epoch. Each wallet votes once."
                      : standing.data && standing.data.weight === 0n
                        ? `You held no $${symbol} at the snapshot, so you have no weight in this vote.`
                        : null;

  const results = tallyResults(options, ed?.poll?.isFinal ? ed.poll.counts : null);
  const winnerId = ed?.winningCause ?? null;
  const paid = typeof ed?.donatedAmount === "string" && /^\d+$/.test(ed.donatedAmount) && BigInt(ed.donatedAmount) > 0n ? usdcToUsd(ed.donatedAmount) : null;

  function startVote(optionId: string) {
    setChoiceId(optionId);
    setSheetOpen(false);
    ballot.reset();
    setFlowOpen(true);
  }

  function confirmVote() {
    if (!selected || epoch === undefined) return;
    void ballot.cast({
      governor: config.governorAddress as Address,
      token: address,
      scope: epoch,
      choice: Number(selected.id),
      scheme: ed?.poll?.scheme as Address | undefined,
    });
  }

  function onFlowOpenChange(open: boolean) {
    setFlowOpen(open);
    if (!open && ballot.phase !== "encrypting" && ballot.phase !== "signing") ballot.reset();
  }

  const privacyNote = ballot.adapter.placeholder ? (
    <span>DEVELOPMENT BUILD: this ballot is not private.</span>
  ) : (
    <span>
      Your choice is encrypted on this device. Zama&apos;s relayer sees your IP and address, never the choice.{" "}
      <button type="button" onClick={openPrivacyDetails} className="font-semibold text-primary underline underline-offset-4">
        What goes where
      </button>
    </span>
  );

  const voteAction = !gate.connected ? (
    <ConnectButton />
  ) : gate.wrongChain ? (
    <Button variant="primary" size="lg" onClick={gate.switchToApp} disabled={gate.switching}>
      Switch to Ethereum
    </Button>
  ) : (
    <Button variant="cause" size="lg" disabled={!selected || Boolean(voteBlocker)} onClick={() => selected && startVote(selected.id)}>
      <Vote aria-hidden="true" />
      <span className="min-w-0 truncate">{selected ? `Vote for ${selected.org}` : "Choose a charity to vote"}</span>
    </Button>
  );

  const loading = view.isLoading || detail.isLoading;
  const canShowList = frozen && optionData.length > 0;
  const voteOpen = status.phase === "open" && canShowList;

  return (
    <section aria-label={`${name} ballot`} className="@container grid grid-cols-1 gap-4 rounded-[26px] border border-line bg-card p-4 @lg:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {logo ? (
            <img src={logo} alt="" width={56} height={56} referrerPolicy="no-referrer" className="size-14 shrink-0 rounded-2xl bg-sand object-cover" />
          ) : (
            <span aria-hidden="true" className="grid size-14 shrink-0 place-items-center rounded-2xl bg-sage-tint font-display text-xl font-semibold text-sage-ink">
              {(token.symbol || token.name || "?").slice(0, 2).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <h2 className="m-0 truncate font-display text-2xl font-semibold text-ink">{name}</h2>
            <p className="m-0 text-sm text-ink-muted">
              {epoch !== undefined ? `Epoch ${epoch}` : "Current epoch"}
              {td?.profile?.label ? ` · ${td.profile.label}.${config.ensParentName}` : ""}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={status.tone} shape="pill">
            {loading ? "Loading" : status.label}
          </Badge>
          <a
            href={rel(`token/?address=${token.address}`)}
            className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary underline-offset-4 hover:underline"
          >
            Token page
            <ArrowUpRight aria-hidden="true" className="size-4" />
          </a>
        </div>
      </header>

      {loading && (
        <div className="grid grid-cols-1 gap-2" role="status" aria-label="Loading the ballot">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
      {view.error && (
        <p role="alert" className={`${NOTE} bg-terracotta-tint text-terracotta-strong`}>
          Could not load the epoch: {errorText(view.error)}
        </p>
      )}
      {view.data?.source === "chain" && (
        <p role="note" className={`${NOTE} bg-sand text-ink-soft`}>
          The indexer is unreachable, so this epoch was read directly from the chain.
        </p>
      )}

      {view.data && (
        <dl className="m-0 grid grid-cols-2 gap-3 text-sm @lg:grid-cols-4">
          <Fact term="Voting window" value={ed?.start !== undefined && ed?.end !== undefined ? `${formatTime(ed.start)} to ${formatTime(ed.end)}` : clock ? `${formatTime(clock.start)} to ${formatTime(clock.end)}` : "unknown"} />
          <Fact term="Weight snapshot" value={formatTime(ed?.snapshot)} />
          <Fact term="Ballots cast" value={ed?.poll ? String(ed.poll.ballotCount) : "0"} />
          <Fact
            term="Your weight"
            value={!gate.connected ? "Connect a wallet" : standing.data ? `${weightText}${standing.data.voted ? " (voted)" : ""}` : standing.isLoading ? "Reading privately…" : "unknown"}
          />
        </dl>
      )}

      {frozen && (
        <p className="m-0 text-sm text-ink-soft">
          {makeup ? `Options: ${makeup}. ` : ""}
          Pinned causes come first, then the curator agents&apos; picks, then rotation draws
          {ed?.poolSize !== undefined ? ` from a focus pool of ${ed.poolSize} organizations` : ""}.
        </p>
      )}
      {sourcesUnknown && (
        <p role="note" className={`${NOTE} bg-sand text-ink-soft`}>
          The indexer did not report where each option came from, so they are listed together under Rotation.
        </p>
      )}

      {/* The ballot is not prepared: show the pins that lead it and let any holder open it. */}
      {view.data && !frozen && (
        <div className="grid grid-cols-1 gap-3">
          <p role="note" className={`${NOTE} bg-ochre-tint text-ochre-ink`}>
            This epoch&apos;s ballot is not prepared yet. {options.length > 0 ? "The pinned causes below lead it; " : ""}up to{" "}
            {td?.ballotSize?.size ?? MAX_BALLOT_OPTIONS} options are filled from the curator agents&apos; picks and then in rotation from the token&apos;s focus
            pool when it is prepared, and voting opens then.
          </p>
          {options.length > 0 && (
            <ol aria-label="Pinned causes" className="m-0 grid grid-cols-1 list-none gap-1.5 p-0 text-sm text-ink">
              {options.map((id) => (
                <li key={id} className="flex items-center gap-2 rounded-xl bg-paper px-3 py-2">
                  <Badge tone="ink" shape="pill">
                    Pinned
                  </Badge>
                  {nameOf(id)}
                </li>
              ))}
            </ol>
          )}
          {epoch !== undefined && (gate.connected ? <OpenBallot token={address} epoch={epoch} onOpened={markOpened} /> : <p className="m-0 text-sm text-ink-soft">Connect a wallet to open this week&apos;s ballot.</p>)}
        </div>
      )}

      {view.data && frozen && options.length === 0 && ed?.ballotUnavailable && (
        <p role="note" className={`${NOTE} bg-sand text-ink-soft`}>
          This epoch&apos;s ballot is prepared, but its options could not be read from the chain right now. Try again later.
        </p>
      )}
      {view.data && frozen && options.length === 0 && !ed?.ballotUnavailable && (
        <p className="m-0 text-sm text-ink-soft">This epoch&apos;s ballot has no options; it pays the platform&apos;s fallback cause.</p>
      )}

      {/* Results once the tally is decrypted. */}
      {results && (
        <>
          <TallyResults rows={results} nameOf={(i) => nameOf(options[i] ?? "")} symbol={token.symbol} />
          {winnerId && (
            <p className="m-0 text-sm text-ink-soft">
              {ed?.finalized ? "Paid to" : "Winning cause"}: <strong className="text-ink">{nameOf(winnerId)}</strong>
              {paid !== null ? ` · ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(paid)} USDC` : ""}
            </p>
          )}
        </>
      )}

      {/* The ballot itself: inline from tablet up, a bottom sheet on phones. */}
      {canShowList && !results && (
        <>
          {isPhone ? (
            <div className="grid grid-cols-1 gap-2">
              <p className="m-0 text-sm text-ink-soft">
                {optionData.length} charities on this ballot.
                {voteBlocker ? ` ${voteBlocker}` : ""}
              </p>
              {!gate.connected ? <ConnectButton /> : gate.wrongChain ? voteAction : (
                <Button variant="cause" size="lg" disabled={status.phase !== "open"} onClick={() => setSheetOpen(true)}>
                  <Vote aria-hidden="true" />
                  {status.phase === "open" ? "Open the ballot" : "Voting closed"}
                </Button>
              )}
            </div>
          ) : (
            <BallotList
              options={optionData}
              value={choiceId}
              onValueChange={setChoiceId}
              label={`Choose a charity for ${name}`}
              disabled={!voteOpen}
              footer={
                <>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <p className="m-0 flex items-start gap-1.5 text-[13px] text-ink-soft">
                      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                      {privacyNote}
                    </p>
                    {voteBlocker && (
                      <p role="status" className="m-0 text-[13px] text-terracotta-strong">
                        {voteBlocker}
                      </p>
                    )}
                  </div>
                  <PrivacyPill state={privacy.state} network={privacy.network} onClick={openPrivacyDetails} />
                  {voteAction}
                </>
              }
            />
          )}
          <MobileVoteSheet
            open={sheetOpen && isPhone}
            onOpenChange={setSheetOpen}
            options={optionData}
            value={choiceId}
            onValueChange={setChoiceId}
            kicker={`${tokenLabel(token)} · Epoch ${epoch ?? ""}`}
            title="Where should this week's pool go?"
            meta={clock ? `Closes ${formatTime(clock.end)}${weightText ? ` · your weight ${weightText}` : ""}` : weightText ? `Your weight ${weightText}` : undefined}
            onVote={(o) => startVote(o.id)}
            privacyNote="Your choice is encrypted on this device. Zama's relayer sees your IP and address, never the choice."
            disabledReason={voteBlocker ?? undefined}
            pending={ballot.phase === "encrypting" || ballot.phase === "signing"}
          />
        </>
      )}

      {selected && (
        <VoteFlowDialog
          open={flowOpen}
          onOpenChange={onFlowOpenChange}
          state={flowState(ballot.phase)}
          choice={{ org: selected.org, category: selected.category }}
          weight={weightText || `0 $${symbol}`}
          onConfirm={confirmVote}
          onRetry={confirmVote}
          error={ballot.error}
          failedStep={ballot.failedStep}
          sentFooter={<VoteReceipt ballot={ballot} chainId={config.chainId} />}
        />
      )}

      <CuratorPicks items={agentPicks} focus={td?.focus} optionIds={options} showPicks={frozen} />
    </section>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 rounded-xl bg-paper px-3 py-2">
      <dt className="kicker text-[11px]">{term}</dt>
      <dd className="num m-0 min-w-0 [overflow-wrap:anywhere] text-ink">{value}</dd>
    </div>
  );
}

/** Under the "Vote sent" screen: waiting for the chain, confirmed, or reverted. */
function VoteReceipt({ ballot, chainId }: { ballot: ReturnType<typeof useCastBallot>; chainId: number }) {
  const { hash, receipt, receiptError } = ballot.tx;
  const href = txUrl(chainId, hash);
  return (
    <div className="grid grid-cols-1 gap-1.5 text-sm" aria-live="polite">
      {!receipt && !receiptError && <p className="m-0 text-ink-soft">Waiting for the chain to confirm…</p>}
      {receiptError && <p role="alert" className="m-0 text-terracotta-strong">Could not read the receipt: {errorText(receiptError)}</p>}
      {receipt?.status === "success" && <p className="m-0 text-gain">Confirmed in block {String(receipt.blockNumber)}.</p>}
      {receipt?.status === "reverted" && (
        <p role="alert" className="m-0 text-terracotta-strong">
          The transaction reverted, so your vote was not counted.
        </p>
      )}
      {href && (
        <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center justify-center gap-1 font-semibold text-primary underline-offset-4 hover:underline">
          View on Etherscan
          <ExternalLink aria-hidden="true" className="size-3.5" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      )}
    </div>
  );
}
