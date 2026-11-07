"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { remainingStages, type DonationStage, type DonationStep } from "@varada/sdk";
import { Button } from "@varada/ui/components/ui/button";
import { usdcText } from "@/components/agent-common";
import { useCatalogNames } from "@/components/catalog-browser";
import { causeName, useCauses } from "@/components/epoch-panel";
import { useAppConfig, useDeps } from "@/components/providers";
import { errorText, formatTime, TxStatus, useTx } from "@/components/use-tx";
import {
  blockedText,
  donationAddresses,
  donationRequest,
  fallbackText,
  nextWaitingWeek,
  planWeek,
  stageLabel,
  stepLabel,
  waitText,
} from "@/lib/donation-push";

const CARD = "grid grid-cols-1 gap-3 rounded-2xl border border-line bg-paper-card p-4";
const HEADING = "m-0 text-lg font-semibold";
const TEXT = "m-0 text-sm text-ink-soft";
const NOTE = "m-0 rounded-xl px-3 py-2 text-sm";

const isZero = (h: Hex) => /^0x0*$/.test(h);

/** The step last sent from the card: its label is fixed when sent, whichever epoch is shown after. */
interface Sent {
  stage: DonationStage;
  epoch: bigint;
  weekStart: bigint;
  label: string;
}

/** Same step: a plan read again just before sending must still be the one the button named. */
const sameStep = (a: DonationStep, b: DonationStep) =>
  a.type === "send" && b.type === "send" && a.stage === b.stage && a.functionName === b.functionName && a.fallback === b.fallback;

/**
 * Offered while an ended epoch's fees have not reached its winning charity. Every step left (close
 * the vote, finalize the winner, move the fees to the donation contract, send the donation) is
 * permissionless, so anyone can push the epoch through when the platform keeper has not. The plan
 * is read from the chain before every step, with the same SDK code the keeper runs, and the
 * caller's wallet sends it. Hidden when no ended epoch is waiting or the app lacks the addresses.
 */
export function SendDonation({ token }: { token: Address }) {
  const config = useAppConfig();
  const deps = useDeps();
  const [sent, setSent] = useState<Sent>();
  const tx = useTx({
    kind: sent?.stage === "distribute" ? "donation" : "transaction",
    description: sent?.label,
    titles: sent?.stage === "distribute" ? { pending: "Sending the donation…", success: "Donation sent", error: "Donation not sent" } : undefined,
    confetti: sent?.stage === "distribute" ? "donation" : false,
  });
  const addrs = donationAddresses(config);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string>();
  const [donated, setDonated] = useState(false);

  const week = useQuery({
    queryKey: ["donation-push", token],
    queryFn: () => nextWaitingWeek(deps, addrs!, token),
    enabled: Boolean(addrs),
    retry: false,
    staleTime: 30_000,
  });
  const w = week.data ?? null;
  const winner = w && !isZero(w.state.winningCause) ? w.state.winningCause : null;
  const fallback = w?.step.type === "send" && w.step.fallback === "tally-timeout";
  const defaultCause = w && !isZero(w.state.defaultCause) ? w.state.defaultCause : null;
  const causes = useCauses();
  const names = useCatalogNames([winner, defaultCause].filter((x): x is Hex => x !== null));
  const defaultCharity = defaultCause ? causeName(causes.data, defaultCause, names.data) : "the default charity";
  const charity = winner ? causeName(causes.data, winner, names.data) : fallback ? defaultCharity : "the winning charity";

  // Each confirmed step re-plans from the chain, which shows the next step (or hides the card).
  const handled = useRef<string | undefined>(undefined);
  const { refetch } = week;
  useEffect(() => {
    const r = tx.receipt;
    if (!r || r.status !== "success" || handled.current === r.transactionHash) return;
    handled.current = r.transactionHash;
    if (sent?.stage === "distribute") setDonated(true);
    void refetch();
  }, [tx.receipt, sent, refetch]);

  if (!addrs) return null;
  if (!w) {
    if (!donated) return null;
    return (
      <section aria-label="Send this epoch's donation" className={CARD}>
        <h2 className={HEADING}>Send this epoch&apos;s donation</h2>
        <p role="status" className={`${NOTE} bg-sage-tint text-sage-ink`}>
          The donation was sent. Thank you for paying the gas.
        </p>
        <TxStatus tx={tx} label={sent?.label ?? stageLabel("distribute", "the charity")} />
      </section>
    );
  }

  const { step, state } = w;
  const stages = remainingStages(step, w.hasBallots);
  const current = step.type === "done" ? undefined : step.stage;
  const amount = state.settled ? state.pending : state.epochPool;
  // Disabled until the last transaction has a receipt, even when reading it failed: it may still be
  // pending, and a re-plan would see the chain without it and send the same step again. "Check
  // again" re-reads the receipt. Also while the plan is re-read, so the label is never stale.
  const unconfirmed = Boolean(tx.hash && !tx.receipt);
  const busy = planning || tx.isPending || unconfirmed || week.isFetching;
  const waiting = waitText(step, formatTime);
  const blocked = blockedText(step, charity);

  async function sendNext() {
    setError(undefined);
    setPlanning(true);
    let request: ReturnType<typeof donationRequest>;
    let fresh: Awaited<ReturnType<typeof planWeek>>;
    try {
      // Fresh from the chain: someone else may have sent this step since the card loaded.
      fresh = await planWeek(deps, addrs!, token, w!.epoch);
      request = donationRequest(fresh.step, addrs!, config.chainId);
    } catch (e) {
      setPlanning(false);
      return setError(errorText(e));
    }
    setPlanning(false);
    if (!request || fresh.step.type !== "send") return void refetch();
    if (!sameStep(fresh.step, step)) {
      // Never send a call the button did not name: show the new step and let the visitor press again.
      setError("The next step changed since this page loaded. Check it below and press again.");
      return void refetch();
    }
    tx.reset();
    setSent({ stage: fresh.step.stage, epoch: w!.epoch, weekStart: fresh.state.epochStart, label: stepLabel(fresh.step, charity, defaultCharity) });
    try {
      await tx.send(request as never);
    } catch {
      // Shown by TxStatus (wallet rejection, revert on estimate).
    }
  }

  return (
    <section aria-label="Send this epoch's donation" className={CARD}>
      <h2 className={HEADING}>Send this epoch&apos;s donation</h2>
      <p className={TEXT}>
        The epoch from {formatTime(Number(state.epochStart))} to {formatTime(Number(state.epochEnd))} has ended, but its donation has not gone out yet
        {amount > 0n ? ` (${usdcText(amount)} for the cause so far)` : ""}.
      </p>
      {stages.length > 0 && (
        <>
          <p className={TEXT}>What is left:</p>
          <ol aria-label="Steps left" className="m-0 grid list-decimal gap-1 pl-5 text-sm text-ink-soft">
            {stages.map((s) => (
              <li key={s} aria-current={s === current ? "step" : undefined} className={s === current ? "font-semibold text-ink" : undefined}>
                {s === current && step.type === "send" ? stepLabel(step, charity, defaultCharity) : stageLabel(s, charity)}
              </li>
            ))}
          </ol>
        </>
      )}
      <p className={TEXT}>
        Anyone can do these steps, not only the platform. Each one is checked on chain: the money can only go to{" "}
        {fallback ? "the default charity" : "the epoch's winning charity"}, never to you or anyone else, and you pay the gas.
      </p>
      {fallback && <p role="note" className={`${NOTE} bg-ochre-tint text-ochre-ink`}>{fallbackText(defaultCharity, Number(state.tallyGrace))}</p>}
      {step.type === "send" && (
        <div>
          <Button type="button" variant="cause" onClick={() => void sendNext()} disabled={busy}>
            {planning || week.isFetching ? "Checking the chain" : stepLabel(step, charity, defaultCharity)}
          </Button>
        </div>
      )}
      {unconfirmed && tx.receiptError && (
        <Button
          type="button"
          variant="outline"
          className="justify-self-start"
          onClick={() => {
            void tx.refetchReceipt?.();
            void refetch();
          }}
        >
          Check again
        </Button>
      )}
      {waiting && <p role="status" className={`${NOTE} bg-sand text-ink-soft`}>{waiting}</p>}
      {blocked && <p role="alert" className={`${NOTE} bg-terracotta-tint text-terracotta-strong`}>{blocked}</p>}
      {error && <p role="alert" className={`${NOTE} bg-terracotta-tint text-terracotta-strong`}>{error}</p>}
      {sent && <TxStatus tx={tx} label={sent.epoch === w.epoch ? sent.label : `${sent.label} (epoch from ${formatTime(Number(sent.weekStart))})`} />}
    </section>
  );
}
