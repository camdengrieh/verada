// Adapted from 21st.dev @shadcnspace/sonner-05 (id 19146), a rich `toast.custom` card with an icon
// tile, status pill and action row, and @cnippet-dev/promise-toast (id 24420), one toast that moves
// through loading, success and error. Rebuilt for Varada transactions: swaps, launches, votes and
// donations, with a cause slot, an explorer-link slot and optional confetti on success.
"use client";

import { CircleAlert, Check, ExternalLink, HandHeart, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { fireConfetti, type ConfettiPreset } from "@varada/ui/components/motion/confetti";
import { Wash, type WashBlob } from "@varada/ui/components/varada/watercolour";
import { cn } from "@varada/ui/lib/utils";

export type TxKind = "swap" | "launch" | "vote" | "donation" | "transaction";
export type TxState = "pending" | "success" | "error";
export type TxToastId = string | number;

const KIND_LABEL: Record<TxKind, string> = {
  swap: "Swap",
  launch: "Launch",
  vote: "Vote",
  donation: "Donation",
  transaction: "Transaction",
};

const DEFAULT_TITLE: Record<TxKind, Record<TxState, string>> = {
  swap: { pending: "Confirming your swap…", success: "Swap confirmed", error: "Swap failed" },
  launch: { pending: "Launching your token…", success: "Token launched", error: "Launch failed" },
  vote: { pending: "Casting your vote privately…", success: "Vote cast", error: "Vote not cast" },
  donation: { pending: "Sending your donation…", success: "Donation sent", error: "Donation failed" },
  transaction: { pending: "Transaction pending…", success: "Transaction confirmed", error: "Transaction failed" },
};

const WASH: Record<TxState, WashBlob[]> = {
  pending: [{ cx: 120, cy: 90, rx: 150, ry: 70, color: "var(--ochre)", opacity: 0.28 }],
  success: [
    { cx: 110, cy: 90, rx: 150, ry: 70, color: "var(--sage)", opacity: 0.3 },
    { cx: 300, cy: 60, rx: 120, ry: 50, color: "var(--ochre)", opacity: 0.16 },
  ],
  error: [{ cx: 120, cy: 90, rx: 150, ry: 70, color: "var(--terracotta)", opacity: 0.24 }],
};

export interface TxDonation {
  /** e.g. "0.042 ETH" (formatted by the app). */
  amount: ReactNode;
  /** The cause it went to, e.g. "Wildlife rescue". */
  cause: ReactNode;
  /** Optional cause icon (e.g. `<CauseIcon cause="wildlife" size={20} decorative />`). */
  icon?: ReactNode;
}

export interface TxToastOptions {
  /** Reuse an id to update an existing toast in place (pending → success). */
  id?: TxToastId;
  kind?: TxKind;
  title?: ReactNode;
  description?: ReactNode;
  /** Cause or token art in the icon tile; the status shows as a badge on its corner. */
  icon?: ReactNode;
  /** Explorer link (or any action), e.g. `<a href={txUrl}>View on Etherscan</a>`. */
  link?: ReactNode;
  /** Convenience: renders an external link with this href (built by the app, never here). */
  explorerHref?: string;
  explorerLabel?: string;
  /** Success only: what the fee split sent to charity on this trade/launch. */
  donation?: TxDonation;
  /** Success only: fire a confetti preset from the toast (skipped under reduced motion). */
  confetti?: ConfettiPreset | false;
  /** Error only: show a retry action. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Milliseconds; pending defaults to staying until updated. */
  duration?: number;
  /** Render in a specific `<Toaster id>`; omit for the app's default Toaster. */
  toasterId?: string;
  dismissLabel?: string;
}

export interface TxToastCardProps extends Omit<TxToastOptions, "id" | "duration" | "toasterId"> {
  state: TxState;
  /** Used to fire confetti once per toast. */
  toastId?: TxToastId;
  onDismiss?: () => void;
  className?: string;
}

const celebrated = new Set<TxToastId>();

function StatusBadge({ state, small }: { state: TxState; small?: boolean }) {
  const size = small ? "size-5" : "size-10";
  if (state === "success") {
    return (
      <span className={cn(size, "grid place-items-center rounded-full bg-sage text-paper motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-300")}>
        <Check className={small ? "size-3" : "size-5"} strokeWidth={3} />
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className={cn(size, "grid place-items-center rounded-full bg-terracotta-tint text-terracotta-strong", small && "ring-2 ring-popover")}>
        <CircleAlert className={small ? "size-3.5" : "size-5"} strokeWidth={2.5} />
      </span>
    );
  }
  // Pending: an ochre brush arc chasing round the tile.
  return (
    <span className={cn(size, "relative grid place-items-center rounded-full bg-ochre-tint", small && "ring-2 ring-popover")}>
      <svg viewBox="0 0 40 40" className="absolute inset-0 size-full motion-safe:animate-spin [animation-duration:1.4s]">
        <circle cx="20" cy="20" r="16" fill="none" stroke="var(--ochre)" strokeWidth="4" strokeLinecap="round" strokeDasharray="60 101" />
      </svg>
      {small ? null : <span className="size-2 rounded-full bg-ochre-ink" />}
    </span>
  );
}

/** The card a transaction toast renders. Exported for static previews. */
export function TxToastCard({
  state,
  kind = "transaction",
  title,
  description,
  icon,
  link,
  explorerHref,
  explorerLabel = "View on Etherscan",
  donation,
  confetti,
  onRetry,
  retryLabel = "Try again",
  onDismiss,
  dismissLabel = "Dismiss",
  toastId,
  className,
}: TxToastCardProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state !== "success" || !confetti || !ref.current) return;
    if (toastId !== undefined) {
      if (celebrated.has(toastId)) return;
      celebrated.add(toastId);
    }
    fireConfetti({ preset: confetti, origin: ref.current, intensity: 0.7 });
  }, [state, confetti, toastId]);

  const action =
    link ??
    (explorerHref ? (
      <a
        href={explorerHref}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-11 items-center gap-1 rounded-full text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {explorerLabel}
        <ExternalLink aria-hidden="true" className="size-3.5" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    ) : null);

  return (
    <div
      ref={ref}
      data-slot="tx-toast"
      data-state={state}
      data-kind={kind}
      role={state === "error" ? "alert" : undefined}
      className={cn(
        "relative isolate flex w-full gap-3 overflow-hidden rounded-[var(--radius-xl)] border border-line-strong bg-popover p-4 pr-12 font-sans text-popover-foreground shadow-float",
        className,
      )}
    >
      <Wash blobs={WASH[state]} className="absolute -top-6 -left-8 -z-10 h-28 w-72 opacity-70" />
      <div aria-hidden="true" className="relative shrink-0">
        {icon ? (
          <>
            <span className="grid size-10 place-items-center overflow-hidden rounded-full bg-sand">{icon}</span>
            <span className="absolute -right-1 -bottom-1">
              <StatusBadge state={state} small />
            </span>
          </>
        ) : (
          <StatusBadge state={state} />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="kicker text-[11px]!">{KIND_LABEL[kind]}</span>
        <p className="text-[15px] leading-snug font-semibold text-ink">{title ?? DEFAULT_TITLE[kind][state]}</p>
        {description ? <div className="text-sm text-ink-soft">{description}</div> : null}
        {state === "success" && donation ? (
          <p className="mt-1.5 flex items-center gap-2 rounded-xl bg-sage-tint px-2.5 py-1.5 text-sm text-sage-ink">
            <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center overflow-hidden rounded-full">
              {donation.icon ?? <HandHeart className="size-4" />}
            </span>
            <span>
              <strong className="num font-semibold">{donation.amount}</strong> went to {donation.cause}
            </span>
          </p>
        ) : null}
        {action || (state === "error" && onRetry) ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-4">
            {state === "error" && onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex min-h-11 items-center rounded-full text-sm font-semibold text-terracotta-strong underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {retryLabel}
              </button>
            ) : null}
            {action}
          </div>
        ) : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className="absolute top-1 right-1 inline-flex size-11 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-sand hover:text-ink focus-visible:outline-2 focus-visible:outline-ring"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

const DURATION: Record<TxState, number> = { pending: Infinity, success: 7000, error: 10000 };

function show(state: TxState, { id, duration, toasterId, ...card }: TxToastOptions): TxToastId {
  return toast.custom(
    (t) => <TxToastCard state={state} toastId={id ?? t} onDismiss={() => toast.dismiss(t)} {...card} />,
    { id, duration: duration ?? DURATION[state], toasterId },
  );
}

type Resolve<T, O> = O | ((value: T) => O);
const resolve = <T, O>(r: Resolve<T, O> | undefined, value: T): O | undefined =>
  typeof r === "function" ? (r as (value: T) => O)(value) : r;

export interface TxPromiseOptions<T> {
  kind?: TxKind;
  toasterId?: string;
  pending?: Omit<TxToastOptions, "kind" | "toasterId" | "id">;
  success?: Resolve<T, Omit<TxToastOptions, "kind" | "toasterId" | "id">>;
  error?: Resolve<unknown, Omit<TxToastOptions, "kind" | "toasterId" | "id">>;
}

/**
 * Transaction toasts. `pending` returns an id; pass it to `success` or `error` to update the same
 * toast in place. Needs a mounted `<Toaster>` (from ui/toaster).
 *
 * ```ts
 * const id = txToast.pending({ kind: "swap", description: "0.5 ETH for $HARAMBE" });
 * txToast.success(id, { kind: "swap", explorerHref: txUrl, donation: { amount: "0.0045 ETH", cause: "Wildlife rescue" } });
 * await txToast.promise(sendVote(), { kind: "vote", success: { confetti: "vote" } });
 * ```
 */
export const txToast = {
  pending: (options: TxToastOptions = {}) => show("pending", options),
  success: (id: TxToastId | undefined, options: TxToastOptions = {}) => show("success", { ...options, id: id ?? options.id }),
  error: (id: TxToastId | undefined, options: TxToastOptions = {}) => show("error", { ...options, id: id ?? options.id }),
  dismiss: (id?: TxToastId) => toast.dismiss(id),
  /** Pending until the promise settles, then success or error in place. Returns the promise. */
  promise<T>(promise: Promise<T>, { kind, toasterId, pending, success, error }: TxPromiseOptions<T> = {}): Promise<T> {
    const id = show("pending", { ...pending, kind, toasterId });
    promise.then(
      (value) => show("success", { ...resolve(success, value), kind, toasterId, id }),
      (reason: unknown) => show("error", { ...resolve(error, reason), kind, toasterId, id }),
    );
    return promise;
  },
};
