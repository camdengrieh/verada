"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { useAppConfig, useDeps } from "@/components/providers";
import { useTx, errorText, type TxOptions } from "@/components/use-tx";
import { lazyEncryptor, type Encryptor } from "@/lib/ballot";
import type { DataDeps } from "@/lib/data";
import { schemeContract, selectVoteAdapter, type VoteAdapter } from "@/lib/vote-adapter";

// One encryptor per data layer, so the FHE key fetched for the first ballot is reused afterwards.
const encryptors = new WeakMap<DataDeps, () => Promise<Encryptor>>();

export interface CastBallotArgs {
  governor: Address;
  token: Address;
  scope: bigint;
  choice: number;
  /** The poll's scheme; defaults to `votingSchemeAddress`. */
  scheme?: Address;
}

export type BallotPhase = "idle" | "encrypting" | "signing" | "sent" | "error";

/** The step that failed, matching VoteFlowDialog: 0 encrypt, 1 wallet signature, 2 submit. */
export type FailedStep = 0 | 1 | 2;

/**
 * Encrypt (or, in development, encode) a choice and send `castBallot` from the voter's wallet. The
 * transaction raises a "vote" toast; pass `txOptions` to say which poll it is for.
 */
export function useCastBallot(txOptions: TxOptions = {}): {
  adapter: VoteAdapter;
  phase: BallotPhase;
  error?: string;
  /** Which step failed when `phase` is "error". */
  failedStep: FailedStep;
  tx: ReturnType<typeof useTx>;
  cast(args: CastBallotArgs): Promise<void>;
  /** Back to idle (e.g. when the vote dialog closes). */
  reset(): void;
} {
  const config = useAppConfig();
  const deps = useDeps();
  const { address } = useAccount();
  const tx = useTx({ kind: "vote", confetti: "vote", ...txOptions });
  const [phase, setPhase] = useState<BallotPhase>("idle");
  const [error, setError] = useState<string>();
  const [failedStep, setFailedStep] = useState<FailedStep>(1);
  const step = useRef<FailedStep>(0);

  const adapter = useMemo(() => {
    let get = encryptors.get(deps);
    if (!get) {
      get = lazyEncryptor(() => ({ chainId: config.chainId, publicClient: deps.chain(), relayerUrl: config.zamaRelayerUrl }));
      encryptors.set(deps, get);
    }
    return selectVoteAdapter(config, get);
  }, [config, deps]);

  async function cast(args: CastBallotArgs) {
    setError(undefined);
    tx.reset();
    const scheme = args.scheme ?? config.votingSchemeAddress;
    step.current = 0;
    if (!address) return fail("Connect a wallet to vote");
    if (!scheme) return fail("votingSchemeAddress is not configured (config.json)");
    try {
      setPhase("encrypting");
      const call = await adapter.buildCall({ ...args, scheme, voter: address });
      step.current = 1;
      setPhase("signing");
      await tx.send({ ...schemeContract, address: scheme, ...call, chainId: config.chainId });
      setPhase("sent");
    } catch (e) {
      fail(errorText(e));
    }
  }

  function fail(message: string) {
    setError(message);
    setFailedStep(step.current);
    setPhase("error");
  }

  const { reset: resetTx } = tx;
  const reset = useCallback(() => {
    setError(undefined);
    setPhase("idle");
    resetTx();
  }, [resetTx]);

  return { adapter, phase, error, failedStep, tx, cast, reset };
}
