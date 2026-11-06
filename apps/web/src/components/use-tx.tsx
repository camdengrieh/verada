"use client";

import { txToast, type TxKind, type TxToastId } from "@varada/ui/components/varada/tx-toast";
import type { ConfettiPreset } from "@varada/ui/components/motion/confetti";
import { useEffect, useRef, type ReactNode } from "react";
import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import type { Hex, TransactionReceipt } from "viem";
import { useAppConfig } from "@/components/providers";
import { txUrl } from "@/lib/explorer";
import { friendlyTxError, isUserRejection } from "@/lib/tx-errors";

/** What a transaction toast says. Titles default to the library's wording for the `kind`. */
export interface TxOptions {
  /** Picks the toast's title and icon: a vote, a donation, a launch... */
  kind?: TxKind;
  /** Second line of the toast, e.g. "25 USDC to Homelessness". */
  description?: ReactNode;
  /** Override the default titles. */
  titles?: { pending?: ReactNode; success?: ReactNode; error?: ReactNode };
  /** Confetti on success (skipped under reduced motion). */
  confetti?: ConfettiPreset | false;
  /** False for a write that already shows its own progress. */
  toast?: boolean;
}

/**
 * A wallet write plus its receipt (receipts are read through the private RPC under the account's
 * key). Every write raises a transaction toast: pending once the wallet returns a hash, then
 * confirmed or reverted in place. A rejection or failure before a hash exists is one error toast.
 */
export function useTx(options: TxOptions = {}) {
  const config = useAppConfig();
  const { writeContractAsync, data: hash, isPending, error, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash, chainId: config.chainId, query: { enabled: Boolean(hash) } });

  const opts = useRef(options);
  opts.current = options;
  const toastIds = useRef(new Map<string, TxToastId>());
  const shownErrors = useRef(new WeakSet<object>());

  // Pending toast as soon as the wallet hands back a hash.
  useEffect(() => {
    const o = opts.current;
    if (!hash || o.toast === false || toastIds.current.has(hash)) return;
    toastIds.current.set(
      hash,
      txToast.pending({ kind: o.kind, title: o.titles?.pending, description: o.description, explorerHref: txUrl(config.chainId, hash) }),
    );
  }, [hash, config.chainId]);

  // Settled in place when the receipt arrives.
  const settled = receipt.data;
  useEffect(() => {
    const o = opts.current;
    if (!hash || !settled || o.toast === false) return;
    const id = toastIds.current.get(hash);
    const base = { kind: o.kind, description: o.description, explorerHref: txUrl(config.chainId, hash) };
    if (settled.status === "success") txToast.success(id, { ...base, title: o.titles?.success, confetti: o.confetti });
    else txToast.error(id, { ...base, title: o.titles?.error ?? "Transaction reverted", description: "The chain rejected it. Nothing was spent beyond gas." });
  }, [hash, settled, config.chainId]);

  // The wallet declined, or the call failed before it was sent.
  useEffect(() => {
    const o = opts.current;
    if (!error || o.toast === false || typeof error !== "object" || shownErrors.current.has(error)) return;
    shownErrors.current.add(error);
    txToast.error(undefined, {
      kind: o.kind,
      title: isUserRejection(error) ? "Request declined" : o.titles?.error,
      description: errorText(error),
      duration: 6000,
    });
  }, [error]);

  return { send: writeContractAsync, hash, isPending, error, receipt: receipt.data, receiptError: receipt.error, reset };
}

export type Tx = ReturnType<typeof useTx>;

/** The most useful single line for an error: a recognised reason, else viem's short message. */
export function errorText(e: unknown): string {
  if (!e) return "";
  const friendly = friendlyTxError(e);
  if (friendly) return friendly;
  const err = e as { shortMessage?: unknown; message?: unknown };
  if (typeof err.shortMessage === "string") return err.shortMessage;
  if (typeof err.message === "string") return err.message.split("\n")[0] ?? err.message;
  return String(e);
}

const NOTE = "m-0 rounded-xl px-3 py-2 text-sm";

export function TxStatus({ tx, label = "Transaction" }: { tx: Pick<Tx, "hash" | "isPending" | "error" | "receipt" | "receiptError">; label?: string }) {
  return (
    <>
      {tx.isPending && (
        <p role="status" className={`${NOTE} bg-ochre-tint text-ochre-ink`}>
          Confirm in your wallet
        </p>
      )}
      {tx.error && (
        <p role="alert" className={`${NOTE} bg-terracotta-tint text-terracotta-strong`}>
          {errorText(tx.error)}
        </p>
      )}
      {tx.hash && !tx.receipt && !tx.receiptError && (
        <p role="status" className={`${NOTE} break-all bg-sand text-ink-soft`}>
          {label} submitted: {tx.hash}. Waiting for confirmation
        </p>
      )}
      {tx.receiptError && (
        <p role="alert" className={`${NOTE} bg-terracotta-tint text-terracotta-strong`}>
          Could not read the receipt: {errorText(tx.receiptError)}
        </p>
      )}
      {tx.receipt && <ReceiptLine receipt={tx.receipt} hash={tx.hash} label={label} />}
    </>
  );
}

function ReceiptLine({ receipt, hash, label }: { receipt: TransactionReceipt; hash?: Hex; label: string }) {
  return receipt.status === "success" ? (
    <p role="status" className={`${NOTE} break-all bg-sage-tint text-sage-ink`}>
      {label} confirmed in block {String(receipt.blockNumber)} ({hash})
    </p>
  ) : (
    <p role="alert" className={`${NOTE} break-all bg-terracotta-tint text-terracotta-strong`}>
      {label} reverted ({hash})
    </p>
  );
}

export function shortAddress(a: string | null | undefined): string {
  if (!a) return "none";
  return a.length > 12 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a;
}

/** UTC timestamp, so output does not depend on the viewer's locale. */
export function formatTime(seconds: number | undefined): string {
  if (seconds === undefined) return "unknown";
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}
