"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { Button } from "@varada/ui/components/ui/button";
import { Card } from "@varada/ui/components/ui/card";
import { useAppConfig, useDeps } from "@/components/providers";
import { TxStatus, useTx } from "@/components/use-tx";
import { openingErrorText, openingRequest, planOpening } from "@/lib/open-ballot";

/**
 * Offered while the current epoch's ballot is not prepared. The platform keeper only opens epochs
 * of tokens with recent fees, ballots or pin changes, so a quiet token's voter opens it here: the
 * button plans the same `openEpoch` / `prepareBallot` / `prepareCuratedBallot` the keeper would
 * send and the voter's wallet sends it. When a curator agent's picks cannot be obtained, the plan
 * is `requestCurationSkip` instead, and the ballot can be opened in rotation once its grace ends.
 */
export function OpenBallot({ token, epoch, onOpened }: { token: Address; epoch: bigint; onOpened: () => void }) {
  const config = useAppConfig();
  const deps = useDeps();
  const tx = useTx();
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<string>();
  const [opened, setOpened] = useState(false);
  const governor = config.governorAddress as Address;

  const confirmed = tx.receipt?.status === "success";
  const skipRequested = confirmed && sent === "requestCurationSkip";
  useEffect(() => {
    if (confirmed && sent !== "requestCurationSkip") {
      setOpened(true);
      onOpened();
    }
  }, [confirmed, sent, onOpened]);

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
    setSent(request.functionName);
    try {
      await tx.send(request as never);
    } catch {
      // Shown by TxStatus (wallet rejection, revert on estimate).
    }
  }

  if (opened) {
    return (
      <Card role="group" aria-label="Open ballot" tone="sand" className="p-4">
        <p role="status" className="m-0 text-sm">This week&apos;s ballot is open. Loading its options from the chain.</p>
      </Card>
    );
  }
  return (
    <Card role="group" aria-label="Open ballot" tone="sand" className="flex flex-col gap-3 p-4">
      <p className="m-0 text-sm text-ink-soft">
        Nobody has opened this week&apos;s ballot yet. Anyone can: the ballot is drawn on chain exactly as the platform keeper would draw
        it, and you pay the gas (about 2M gas for a full 32-option ballot, less for a smaller one).
      </p>
      <Button type="button" variant="cause" className="self-start" onClick={() => void open()} disabled={planning || tx.isPending || Boolean(tx.hash && !tx.receipt)}>
        {planning ? "Preparing the ballot" : "Open this week's ballot"}
      </Button>
      {error && <p role="alert" className="m-0 text-sm text-destructive">{error}</p>}
      {skipRequested && (
        <p role="status" className="m-0 text-sm">
          A curator agent&apos;s picks for this ballot are missing, so you asked for them to be skipped. Anyone holding the picks can still
          use them for the next 6 hours; after that the ballot can be opened in rotation.
        </p>
      )}
      <TxStatus tx={tx} label={sent === "requestCurationSkip" ? "Skip request" : "Ballot opening"} />
    </Card>
  );
}
