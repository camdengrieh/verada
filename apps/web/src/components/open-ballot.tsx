"use client";

import { Button } from "@varada/ui/components/ui/button";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { useAppConfig, useDeps } from "@/components/providers";
import { TxStatus, useTx } from "@/components/use-tx";
import { openingErrorText, openingRequest, planOpening } from "@/lib/open-ballot";

/**
 * Offered while the current epoch's ballot is not prepared. The platform keeper only opens epochs
 * of tokens with recent fees, ballots or pin changes, so a quiet token's voter opens it here: the
 * button plans the same `openEpoch` / `prepareBallot` / `prepareCuratedBallot` the keeper would
 * send and the voter's wallet sends it. When a curator agent's published picks cannot be obtained,
 * nothing is sent: the governor takes no ballot without them, so the button explains the wait.
 */
export function OpenBallot({ token, epoch, onOpened }: { token: Address; epoch: bigint; onOpened: () => void }) {
  const config = useAppConfig();
  const deps = useDeps();
  const tx = useTx({
    kind: "transaction",
    description: `Epoch ${epoch}`,
    titles: { pending: "Opening this epoch's ballot…", success: "Ballot opened", error: "Ballot not opened" },
    confetti: "vote",
  });
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string>();
  const [opened, setOpened] = useState(false);
  const governor = config.governorAddress as Address;

  const confirmed = tx.receipt?.status === "success";
  useEffect(() => {
    if (confirmed) {
      setOpened(true);
      onOpened();
    }
  }, [confirmed, onOpened]);

  async function open() {
    setError(undefined);
    tx.reset();
    setPlanning(true);
    let request: ReturnType<typeof openingRequest>;
    try {
      request = openingRequest(await planOpening(deps, governor, token, epoch), governor, config.chainId);
    } catch (e) {
      setPlanning(false);
      return setError(openingErrorText(e));
    }
    setPlanning(false);
    if (!request) {
      // Prepared on chain already (someone opened it, and the indexer has not caught up yet).
      setOpened(true);
      return onOpened();
    }
    try {
      await tx.send(request as never);
    } catch {
      // Shown by TxStatus (wallet rejection, revert on estimate).
    }
  }

  if (opened) {
    return (
      <div role="group" aria-label="Open ballot" className="rounded-2xl bg-sage-tint p-4">
        <p role="status" className="m-0 text-sm text-sage-ink">
          This epoch&apos;s ballot is open. Loading its options from the chain.
        </p>
      </div>
    );
  }
  return (
    <div role="group" aria-label="Open ballot" className="grid grid-cols-1 gap-3 rounded-2xl border border-line bg-paper-card p-4">
      <p className="m-0 text-sm text-ink-soft">
        Nobody has opened this epoch&apos;s ballot yet. Anyone can: the ballot is drawn on chain exactly as the platform keeper would draw
        it, and you pay the gas (about 2M gas for a full 32-option ballot, less for a smaller one).
      </p>
      <div>
        <Button type="button" variant="cause" onClick={() => void open()} disabled={planning || tx.isPending || Boolean(tx.hash && !tx.receipt)}>
          {planning ? "Preparing the ballot" : "Open this epoch's ballot"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="m-0 rounded-xl bg-terracotta-tint px-3 py-2 text-sm text-terracotta-strong">
          {error}
        </p>
      )}
      <TxStatus tx={tx} label="Ballot opening" />
    </div>
  );
}
