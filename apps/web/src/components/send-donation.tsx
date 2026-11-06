"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { remainingStages, type DonationStage } from "@verada/sdk";
import { usdcText } from "@/components/agent-common";
import { useCatalogNames } from "@/components/catalog-browser";
import { causeName, useCauses } from "@/components/epoch-panel";
import { useAppConfig, useDeps } from "@/components/providers";
import { errorText, formatTime, TxStatus, useTx } from "@/components/use-tx";
import { blockedText, donationAddresses, donationRequest, nextWaitingWeek, planWeek, stageLabel, waitText } from "@/lib/donation-push";

const isZero = (h: Hex) => /^0x0*$/.test(h);
const dateOf = (seconds: bigint) => formatTime(Number(seconds)).slice(0, 10);

/**
 * Offered while an ended week's fees have not reached its winning charity. Every step left (close
 * the vote, finalize the winner, move the fees to the donation contract, send the donation) is
 * permissionless, so anyone can push the week through when the platform keeper has not. The plan
 * is read from the chain before every step, with the same SDK code the keeper runs, and the
 * caller's wallet sends it. Hidden when no ended week is waiting or the app lacks the addresses.
 */
export function SendDonation({ token }: { token: Address }) {
  const config = useAppConfig();
  const deps = useDeps();
  const tx = useTx();
  const addrs = donationAddresses(config);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<DonationStage>();
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
  const causes = useCauses();
  const names = useCatalogNames(winner ? [winner] : []);
  const charity = winner ? causeName(causes.data, winner, names.data) : "the winning charity";

  // Each confirmed step re-plans from the chain, which shows the next step (or hides the card).
  const handled = useRef<string | undefined>(undefined);
  const { refetch } = week;
  useEffect(() => {
    const r = tx.receipt;
    if (!r || r.status !== "success" || handled.current === r.transactionHash) return;
    handled.current = r.transactionHash;
    if (sent === "distribute") setDonated(true);
    void refetch();
  }, [tx.receipt, sent, refetch]);

  if (!addrs) return null;
  if (!w) {
    if (!donated) return null;
    return (
      <section aria-label="Send this week's donation">
        <h2>Send this week&apos;s donation</h2>
        <p role="status">The donation was sent. Thank you for paying the gas.</p>
        <TxStatus tx={tx} label={stageLabel("distribute", "the charity")} />
      </section>
    );
  }

  const { step, state } = w;
  const stages = remainingStages(step, w.hasBallots);
  const current = step.type === "done" ? undefined : step.stage;
  const amount = state.settled ? state.pending : state.epochPool;
  const busy = planning || tx.isPending || Boolean(tx.hash && !tx.receipt && !tx.receiptError);
  const waiting = waitText(step, formatTime);
  const blocked = blockedText(step, charity);

  async function sendNext() {
    setError(undefined);
    setPlanning(true);
    let request: ReturnType<typeof donationRequest>;
    let stage: DonationStage | undefined;
    try {
      // Fresh from the chain: someone else may have sent this step since the card loaded.
      const fresh = await planWeek(deps, addrs!, token, w!.epoch);
      request = donationRequest(fresh.step, addrs!, config.chainId);
      stage = fresh.step.type === "send" ? fresh.step.stage : undefined;
    } catch (e) {
      setPlanning(false);
      return setError(errorText(e));
    }
    setPlanning(false);
    if (!request) return void refetch();
    tx.reset();
    setSent(stage);
    try {
      await tx.send(request as never);
    } catch {
      // Shown by TxStatus (wallet rejection, revert on estimate).
    }
  }

  return (
    <section aria-label="Send this week's donation">
      <h2>Send this week&apos;s donation</h2>
      <p>
        The week of {dateOf(state.epochStart)} to {dateOf(state.epochEnd)} has ended, but its donation has not gone out yet
        {amount > 0n ? ` (${usdcText(amount)} for the cause so far)` : ""}.
      </p>
      {stages.length > 0 && (
        <>
          <p>What is left:</p>
          <ol aria-label="Steps left">
            {stages.map((s) => (
              <li key={s} aria-current={s === current ? "step" : undefined}>
                {stageLabel(s, charity)}
              </li>
            ))}
          </ol>
        </>
      )}
      <p>
        Anyone can do these steps, not only the platform. Each one is checked on chain: the money can only go to the week&apos;s winning
        charity, never to you or anyone else, and you pay the gas.
      </p>
      {step.type === "send" && (
        <button type="button" onClick={() => void sendNext()} disabled={busy}>
          {planning ? "Checking the chain" : stageLabel(step.stage, charity)}
        </button>
      )}
      {waiting && <p role="status">{waiting}</p>}
      {blocked && <p role="alert">{blocked}</p>}
      {error && <p role="alert">{error}</p>}
      {sent && <TxStatus tx={tx} label={stageLabel(sent, charity)} />}
    </section>
  );
}
