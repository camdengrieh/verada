"use client";

import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { StatCard } from "@varada/ui/components/data/stat-card";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { Vote } from "@varada/ui/components/ui/icons";
import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { isAddress, type Address } from "viem";
import { MAX_BALLOT_OPTIONS } from "@varada/sdk";
import { useRel } from "@/components/nav";
import { useAppConfig, useDeps, usePrivateRpc } from "@/components/providers";
import { errorText } from "@/components/use-tx";
import { EpochClock } from "@/components/governance/epoch-clock";
import { GovernanceHistory } from "@/components/governance/history";
import { standingKey, useNowSeconds } from "@/components/governance/hooks";
import { HowVotingWorks } from "@/components/governance/how-it-works";
import { TakeoverPolls } from "@/components/governance/takeover-polls";
import { TokenBallot } from "@/components/governance/token-ballot";
import { TokenBoard, canVoteHere, type BoardEntry } from "@/components/governance/token-board";
import { createAccountClient } from "@/lib/account-reads";
import { loadBallotSizeCap, loadToken, loadTokens } from "@/lib/data";
import { epochStatus, loadEpochClock, loadTokenEpochs, readStanding, type TokenEpochRow } from "@/lib/governance";
import type { TokenSummary } from "@/lib/indexer";

/** Tokens whose ballots the board follows (the indexer's newest). */
const BOARD_SIZE = 30;

/** `?token=0x...` of the current URL, so a token's ballot can be linked. */
function tokenFromUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const v = new URLSearchParams(window.location.search).get("token")?.trim();
  return v && isAddress(v) ? v : undefined;
}

/**
 * The platform's vote: this epoch's clock, every token's ballot and where it stands, the tokens the
 * connected wallet can vote in, the selected token's ballot (encrypted vote flow, curator picks,
 * results), takeover polls, and the history of past winners and payouts.
 */
export function GovernancePanel() {
  const config = useAppConfig();
  const deps = useDeps();
  const rpc = usePrivateRpc();
  const rel = useRel();
  const queryClient = useQueryClient();
  const { address: account } = useAccount();
  const now = useNowSeconds();
  const governor = config.governorAddress;

  const clock = useQuery({ queryKey: ["epoch-clock", governor], queryFn: () => loadEpochClock(config, deps), enabled: Boolean(governor), retry: false });
  const cap = useQuery({ queryKey: ["ballot-size-cap"], queryFn: () => loadBallotSizeCap(config, deps), enabled: Boolean(governor), retry: false });
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => loadTokens(config, deps), enabled: Boolean(governor), retry: false });

  const [lookedUp, setLookedUp] = useState<string | undefined>(() => tokenFromUrl());
  const [chosen, setChosen] = useState<string | undefined>(() => tokenFromUrl());

  const list = useMemo<TokenSummary[]>(() => (tokens.data?.data ?? []).filter((t) => !t.suppressed).slice(0, BOARD_SIZE), [tokens.data]);
  const extraWanted = lookedUp && !list.some((t) => t.address.toLowerCase() === lookedUp.toLowerCase()) ? lookedUp : undefined;
  const extra = useQuery({
    queryKey: ["token", extraWanted],
    queryFn: () => loadToken(config, deps, extraWanted!),
    enabled: Boolean(governor && extraWanted),
    retry: false,
  });
  const board = useMemo<TokenSummary[]>(() => (extra.data?.data ? [extra.data.data, ...list] : list), [extra.data, list]);

  const epoch = clock.data?.epoch;
  const epochs = useQuery({
    queryKey: ["token-epochs", epoch?.toString(), board.map((t) => t.address.toLowerCase()).join(",")],
    queryFn: () => loadTokenEpochs(deps, board, epoch!),
    enabled: Boolean(governor && epoch !== undefined && board.length > 0),
    retry: false,
    refetchInterval: 60_000,
  });

  // The viewer's weight on each token whose ballot is open, through the account's own private client.
  const accountClient = useMemo(() => (account ? createAccountClient(rpc, account) : null), [rpc, account]);
  const openRows: TokenEpochRow<TokenSummary>[] = (epochs.data ?? []).filter((r) => epochStatus(r.detail, now).phase === "open");
  const standings = useQueries({
    queries: openRows.map((r) => ({
      queryKey: standingKey(governor, r.token.address, epoch, account),
      queryFn: () => readStanding(accountClient!, governor as Address, r.token.address as Address, epoch!, account!),
      enabled: Boolean(accountClient && account && epoch !== undefined && governor),
      retry: false,
    })),
  });
  const standingByToken = new Map(openRows.map((r, i) => [r.token.address.toLowerCase(), standings[i]?.data] as const));

  const entries: BoardEntry[] = (epochs.data ?? board.map((token) => ({ token, detail: null, failed: false }))).map((row) => ({
    row,
    standing: standingByToken.get(row.token.address.toLowerCase()),
  }));

  // Default selection: a token the wallet can still vote in, else one with an open ballot, else the first.
  const fallback = useMemo(() => {
    const votable = entries.find((e) => canVoteHere(e, now));
    const open = entries.find((e) => epochStatus(e.row.detail, now).phase === "open");
    return (votable ?? open ?? entries[0])?.row.token.address;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epochs.data, standings.map((s) => s.dataUpdatedAt).join(","), now]);
  const selectedAddress = chosen ?? fallback;
  const selected = board.find((t) => t.address.toLowerCase() === selectedAddress?.toLowerCase());

  function select(address: string) {
    setChosen(address);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("token", address);
      window.history.replaceState(null, "", url);
    } catch {
      // A blocked history API only loses the shareable URL.
    }
  }

  const counts = useMemo(() => {
    const rows = epochs.data ?? [];
    return {
      open: rows.filter((r) => epochStatus(r.detail, now).phase === "open").length,
      ballots: rows.reduce((n, r) => n + (r.detail?.poll?.ballotCount ?? 0), 0),
    };
  }, [epochs.data, now]);

  // Ballot-size sentence kept short: the cap is the platform's, a token may choose fewer.
  const capText =
    cap.data !== undefined
      ? `up to ${cap.data} charities (the platform's current ballot size; at most ${MAX_BALLOT_OPTIONS})`
      : `up to the platform's ballot size (at most ${MAX_BALLOT_OPTIONS} charities)`;

  // A token the board does not follow, or the board refreshed after a vote: keep the cache honest.
  useEffect(() => {
    if (extra.data?.data) void queryClient.invalidateQueries({ queryKey: ["token-epochs"] });
  }, [extra.data?.data, queryClient]);

  if (!governor) {
    return (
      <section aria-label="Governance" className="@container grid grid-cols-1 gap-6">
        <PageHeading capText={capText} />
        <EmptyState
          icon={<Vote />}
          title="Governance is not set up on this site"
          body="The site's config.json has no governorAddress, so there is no epoch to read or vote in."
        />
      </section>
    );
  }

  return (
    <section aria-label="Governance" className="@container grid grid-cols-1 gap-8">
      <div className="grid grid-cols-1 gap-5 @3xl:grid-cols-[minmax(0,1fr)_auto] @3xl:items-start">
        <PageHeading capText={capText} />
        <EpochClock clock={clock.data} loading={clock.isLoading} error={clock.error} onDone={() => void clock.refetch()} />
      </div>

      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <StatCard label="Epoch" value={epoch !== undefined ? String(epoch) : "—"} animate={false} hint="One week, Thursday to Thursday UTC" />
        <StatCard label="Open ballots" value={epochs.data ? counts.open : "—"} animate={false} hint={`of ${board.length} tokens followed`} />
        <StatCard label="Ballots cast" value={epochs.data ? counts.ballots : "—"} animate={false} hint="This epoch, all tokens" />
        <StatCard label="Ballot size" value={cap.data !== undefined ? cap.data : "—"} animate={false} hint={`At most ${MAX_BALLOT_OPTIONS} options`} />
      </div>

      {tokens.isLoading && (
        <div className="grid grid-cols-1 gap-3" role="status" aria-label="Loading tokens">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}
      {tokens.error && (
        <p role="alert" className="m-0 rounded-xl bg-terracotta-tint px-3 py-2 text-sm text-terracotta-strong">
          Could not load tokens: {errorText(tokens.error)}
        </p>
      )}
      {tokens.data?.source === "chain" && (
        <p role="note" className="m-0 rounded-xl bg-sand px-3 py-2 text-sm text-ink-soft">
          The indexer is unreachable, so tokens were read directly from the chain. Past winners and curator picks need the indexer.
        </p>
      )}
      {tokens.data && board.length === 0 && (
        <EmptyState
          icon={<Vote />}
          title="No tokens have launched yet"
          body="Ballots appear here as soon as a token exists. Launch one and its holders vote on where its fees go."
          action={
            <a href={rel("launch/")} className="inline-flex h-11 items-center rounded-full bg-primary px-5 text-[15px] font-semibold text-primary-foreground hover:bg-terracotta-strong">
              Launch a token
            </a>
          }
        />
      )}

      {board.length > 0 && (
        <div className="grid grid-cols-1 gap-6 @4xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] @4xl:items-start">
          <TokenBoard
            entries={entries}
            selected={selectedAddress}
            onSelect={select}
            nowSeconds={now}
            connected={Boolean(account)}
            onLookup={(a) => {
              setLookedUp(a);
              select(a);
            }}
          />
          <div className="grid grid-cols-1 min-w-0 gap-6">
            {selected ? (
              <>
                <TokenBallot token={selected} clock={clock.data} />
                <TakeoverPolls token={selected} />
              </>
            ) : (
              <EmptyState size="compact" title="Choose a token" body="Pick a token on the left to see its ballot." />
            )}
          </div>
        </div>
      )}

      <GovernanceHistory tokens={board} selected={selected} nowMs={now * 1000} />
      <HowVotingWorks ballotSize={cap.data} />
    </section>
  );
}

function PageHeading({ capText }: { capText: string }) {
  return (
    <div className="grid grid-cols-1 gap-2">
      <p className="kicker m-0">Governance</p>
      <h1 className="m-0 font-display text-4xl font-semibold tracking-tight text-ink @3xl:text-5xl">This week&apos;s vote</h1>
      <p className="m-0 max-w-2xl text-[15px] text-ink-soft">
        Each week, holders of a token vote with an encrypted ballot on which charity receives that token&apos;s cause pool. Every ballot holds {capText} from the
        token&apos;s cause focus, or fewer if its controller chose a smaller ballot. Only totals are decrypted after the epoch ends.
      </p>
    </div>
  );
}
