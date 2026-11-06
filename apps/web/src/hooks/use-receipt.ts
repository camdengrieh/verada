"use client";

import { useCallback, useEffect, useState } from "react";
import type { Hex, TransactionReceipt } from "viem";
import { usePublicClient } from "wagmi";
import { friendlyTxError } from "@/lib/tx-errors";

export interface ReceiptState {
  data: TransactionReceipt | undefined;
  /** Why the receipt could not be read (network, timeout). A reverted receipt is not an error: it is `data`. */
  error: Error | null;
  /** For a reverted receipt: the decoded reason from replaying the call, when the node gives one. */
  revertReason: string | undefined;
  refetch: () => void;
}

function reasonOf(e: unknown): string | undefined {
  const friendly = friendlyTxError(e);
  if (friendly) return friendly;
  const short = (e as { shortMessage?: unknown } | null)?.shortMessage;
  return typeof short === "string" && short ? short : undefined;
}

/**
 * Waits for a transaction's receipt through the public client. wagmi's own waitForTransactionReceipt
 * throws when the receipt says "reverted", which would hide the revert behind a read failure; viem's
 * returns it, so `data.status === "reverted"` is reachable, and the call is replayed at the mined
 * block to recover the revert reason.
 */
export function useReceipt(hash: Hex | undefined, chainId: number): ReceiptState {
  const client = usePublicClient({ chainId });
  const [state, setState] = useState<{ hash?: Hex; data?: TransactionReceipt; error: Error | null; revertReason?: string }>({ error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!hash || !client) return;
    let cancelled = false;
    setState({ hash, error: null });
    void (async () => {
      try {
        const data = await client.waitForTransactionReceipt({ hash });
        if (cancelled) return;
        let revertReason: string | undefined;
        if (data.status === "reverted") {
          try {
            const t = await client.getTransaction({ hash });
            await client.call({ account: t.from, to: t.to ?? undefined, data: t.input, value: t.value, gas: t.gas, blockNumber: data.blockNumber });
          } catch (e) {
            revertReason = reasonOf(e);
          }
          if (cancelled) return;
        }
        setState({ hash, data, error: null, revertReason });
      } catch (e) {
        if (!cancelled) setState({ hash, error: e instanceof Error ? e : new Error(String(e)) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hash, client, attempt]);

  const refetch = useCallback(() => setAttempt((n) => n + 1), []);
  const current = Boolean(hash) && state.hash === hash;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : null,
    revertReason: current ? state.revertReason : undefined,
    refetch,
  };
}
