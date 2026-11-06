"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { ballotGasHint, BALLOT_GAS_PER_TALLY_WORD, effectiveBallotSize, MAX_BALLOT_OPTIONS } from "@varada/sdk";
import { epochGovernorAbi } from "@varada/sdk/abis";
import { useAppConfig } from "@/components/providers";
import { sameAddress, TxStatus, useTx } from "@/components/use-tx";
import type { TokenDetail } from "@/lib/indexer";
import { BALLOT_SIZE_CHOICES } from "@/lib/profile";

/** Plain-English gas hint for a ballot of `size` options. */
export function ballotGasText(size: number): string {
  const { words, unusedCounters, savedPerVoter } = ballotGasHint(size);
  const counted = `${size} options are counted in ${words} encrypted tally ${words === 1 ? "word" : "words"}`;
  const waste = unusedCounters === 0 ? ", with no space left over." : `, leaving room for ${unusedCounters} more at the same cost.`;
  const saving =
    savedPerVoter > 0
      ? ` Compared with a full ${MAX_BALLOT_OPTIONS}-option ballot, each voter saves about ${Math.round(savedPerVoter / 1000)}k gas per ballot.`
      : "";
  return counted + waste + saving;
}

/**
 * The controller's weekly ballot size: follow the platform's cap, or choose 2..32 options (bounded
 * by the cap). Shown next to the pinned causes, since pins past the size are dropped.
 */
export function BallotSizeEditor({ token, detail }: { token: Address; detail: TokenDetail }) {
  const config = useAppConfig();
  const { address: account } = useAccount();
  const tx = useTx();
  const settings = detail.ballotSize;
  const cap = settings?.cap ?? MAX_BALLOT_OPTIONS;
  const [choice, setChoice] = useState<number>(settings?.choice ?? 0);
  const [error, setError] = useState<string>();
  useEffect(() => setChoice(settings?.choice ?? 0), [settings?.choice]);

  if (!sameAddress(account, detail.profile?.controller)) return null;
  const governor = config.governorAddress;
  const size = effectiveBallotSize({ cap, choice });
  const pins = detail.shortlist?.length ?? 0;

  function save() {
    setError(undefined);
    if (!governor) return setError("governorAddress is not configured (config.json)");
    tx.reset();
    void tx.send({ address: governor, abi: epochGovernorAbi, functionName: "setBallotSize", args: [token, choice], chainId: config.chainId }).catch(() => {});
  }

  return (
    <section aria-label="Ballot size">
      <h2>Ballot size</h2>
      <p>
        How many charities each weekly ballot holds. The platform allows up to {cap}
        {settings ? `; this token's ballot now holds up to ${settings.size}` : ""}. A change applies to this week&apos;s ballot if it has
        not been prepared yet, and otherwise from next week.
      </p>
      <label>
        Options per ballot{" "}
        <select value={choice} onChange={(e) => setChoice(Number(e.target.value))}>
          <option value={0}>Follow the platform ({cap})</option>
          {BALLOT_SIZE_CHOICES.map((n) => (
            <option key={n} value={n}>
              {n > cap ? `${n} (capped at ${cap})` : n}
            </option>
          ))}
        </select>
      </label>
      <p role="note">
        Sizes that are multiples of 3 are the most efficient: votes are counted three options to an encrypted word, and each 3 fewer
        options save each voter about {Math.round(BALLOT_GAS_PER_TALLY_WORD / 1000)}k gas per ballot. {ballotGasText(size)}
      </p>
      {pins > size && (
        <p role="note">
          This token has {pins} pinned causes: only the first {size} make it onto a {size}-option ballot.
        </p>
      )}
      <p>
        <button type="button" disabled={tx.isPending || choice === (settings?.choice ?? 0)} onClick={save}>
          Save ballot size
        </button>
      </p>
      {error && <p role="alert">{error}</p>}
      <TxStatus tx={tx} label="Ballot size update" />
    </section>
  );
}
