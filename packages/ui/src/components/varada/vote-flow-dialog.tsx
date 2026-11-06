// Adapted from 21st.dev @ddoemonn/task-steps (id 23569) for the steps list, inside a radix Dialog (A-Vote board)
"use client";

import { Check, LoaderCircle, LockKeyhole, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Dialog } from "radix-ui";
import type { ReactNode } from "react";
import { Button } from "@varada/ui/components/ui/button";
import { cn } from "@varada/ui/lib/utils";
import { CauseIcon, type CauseName } from "./cause-icon";
import type { ImageSource } from "./shared";

/**
 * confirm → encrypting (FHE ballot built in the browser) → wallet (waiting for the signature, then
 * the transaction) → sent. `error` keeps the steps visible with the failed one marked.
 */
export type VoteFlowState = "confirm" | "encrypting" | "wallet" | "sent" | "error";

export interface VoteFlowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: VoteFlowState;
  choice: { org: string; category: CauseName };
  /** "38.9M $HARAMBE" */
  weight: string;
  /** Start encrypting and sending. */
  onConfirm: () => void;
  /** Error state: try again from the failed step. */
  onRetry?: () => void;
  /** Error message for the `error` state. */
  error?: string;
  /** Which step failed in the error state (0 encrypt, 1 sign, 2 submit). */
  failedStep?: 0 | 1 | 2;
  /** Art for the sent state. */
  sentImage?: ImageSource & { alt?: string };
  /** Extra content in the sent state (e.g. a transaction link). */
  sentFooter?: ReactNode;
}

const STEPS = ["Choice encrypted in your browser", "Signature from your wallet", "Submitted to the voting contract"] as const;

type StepStatus = "pending" | "active" | "done" | "error";

function stepStatuses(state: VoteFlowState, failedStep: number): StepStatus[] {
  const current = state === "encrypting" ? 0 : state === "wallet" ? 1 : state === "sent" ? 3 : state === "error" ? failedStep : -1;
  return STEPS.map((_, i) => (i < current ? "done" : i === current ? (state === "error" ? "error" : "active") : "pending"));
}

const ACTIVE_LABEL = ["Encrypting your choice", "Waiting for your wallet signature", "Submitting to the voting contract"] as const;

export function VoteFlowDialog({
  open,
  onOpenChange,
  state,
  choice,
  weight,
  onConfirm,
  onRetry,
  error,
  failedStep = 1,
  sentImage,
  sentFooter,
}: VoteFlowDialogProps) {
  const reduced = useReducedMotion();
  const statuses = stepStatuses(state, failedStep);
  const inFlight = state === "encrypting" || state === "wallet";
  const title =
    state === "confirm" ? "Confirm your private vote" : state === "sent" ? "Vote sent" : state === "error" ? "Vote not sent" : "Encrypting your ballot";
  const activeIndex = statuses.indexOf("active");
  const statusText =
    state === "sent" ? "Vote sent" : state === "error" ? `Failed: ${STEPS[failedStep]}` : activeIndex >= 0 ? `${ACTIVE_LABEL[activeIndex]}, step ${activeIndex + 1} of 3` : "";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/55 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <Dialog.Content
          onInteractOutside={(e) => {
            // A click outside shouldn't drop the flow while the wallet is open.
            if (inFlight) e.preventDefault();
          }}
          className={cn(
            "fixed z-50 flex flex-col gap-4 bg-card p-7 text-card-foreground shadow-float focus-visible:outline-none",
            "inset-x-0 bottom-0 max-h-[92dvh] overflow-y-auto rounded-t-[28px] sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-[18vh] sm:w-[min(92vw,520px)] sm:-translate-x-1/2 sm:rounded-[28px]",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-4 sm:data-[state=open]:zoom-in-95 sm:data-[state=open]:slide-in-from-bottom-0",
          )}
        >
          <Dialog.Close asChild>
            <button type="button" aria-label="Close" className="absolute right-3 top-3 grid size-11 place-items-center rounded-full text-ink-muted hover:bg-sand hover:text-ink">
              <X aria-hidden="true" className="size-5" />
            </button>
          </Dialog.Close>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={state === "confirm" ? "confirm" : state === "sent" ? "sent" : "steps"}
              initial={reduced ? { opacity: 0 } : { opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, x: -24 }}
              transition={{ duration: reduced ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] }}
              className="flex flex-col gap-4"
            >
              {state === "confirm" ? (
                <>
                  <Dialog.Title className="m-0 pr-10 font-display text-[26px] font-semibold leading-tight">{title}</Dialog.Title>
                  <div className="flex items-center gap-3 rounded-2xl bg-sage-tint p-3">
                    <CauseIcon cause={choice.category} size={48} decorative />
                    <div className="flex min-w-0 flex-col">
                      <strong className="truncate">{choice.org}</strong>
                      <span className="text-[13px] text-sage-ink">
                        Weight <span className="num">{weight}</span>
                      </span>
                    </div>
                  </div>
                  <Dialog.Description className="m-0 text-sm text-ink-soft">
                    Your choice is encrypted in your browser before it leaves. Your wallet signs one transaction, and you can&apos;t change the vote once it&apos;s sent.
                  </Dialog.Description>
                  <div className="flex flex-wrap justify-end gap-2.5">
                    <Dialog.Close asChild>
                      <Button variant="soft" size="lg">
                        Cancel
                      </Button>
                    </Dialog.Close>
                    <Button variant="cause" size="lg" onClick={onConfirm}>
                      <LockKeyhole aria-hidden="true" />
                      Encrypt and send
                    </Button>
                  </div>
                </>
              ) : state === "sent" ? (
                <div className="flex flex-col items-center gap-3.5 text-center">
                  {sentImage ? (
                    <img src={sentImage.src} srcSet={sentImage.srcSet} sizes={sentImage.sizes ?? "110px"} alt={sentImage.alt ?? ""} className="h-auto w-[110px]" />
                  ) : (
                    <span aria-hidden="true" className="grid size-16 place-items-center rounded-full bg-sage-tint text-sage">
                      <Check className="size-8" strokeWidth={3} />
                    </span>
                  )}
                  <Dialog.Title className="m-0 font-display text-[26px] font-semibold">{title}</Dialog.Title>
                  <Dialog.Description className="m-0 text-sm text-ink-soft">
                    Results are revealed after voting closes. The winner receives this epoch&apos;s pool through Endaoment, in USDC.
                  </Dialog.Description>
                  {sentFooter}
                  <Dialog.Close asChild>
                    <Button variant="ink" size="lg">
                      Done
                    </Button>
                  </Dialog.Close>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3.5 text-center">
                  {state === "error" ? null : (
                    <LoaderCircle aria-hidden="true" className="size-14 animate-spin text-sage motion-reduce:animate-none" strokeWidth={2.4} />
                  )}
                  <Dialog.Title className="m-0 font-display text-2xl font-semibold">{title}</Dialog.Title>
                  <Dialog.Description className="sr-only">Progress of your private vote for {choice.org}.</Dialog.Description>
                  <ol aria-label="Vote progress" className="m-0 flex list-none flex-col gap-2 self-stretch p-0 text-left text-sm sm:self-center">
                    {STEPS.map((step, i) => {
                      const s = statuses[i] ?? "pending";
                      return (
                        <li key={step} aria-current={s === "active" ? "step" : undefined} className="flex items-center gap-2.5">
                          <StepMark status={s} />
                          <span
                            className={cn(
                              s === "done" && "text-gain",
                              s === "active" && "font-semibold text-ink",
                              s === "pending" && "text-ink-muted",
                              s === "error" && "font-semibold text-loss",
                            )}
                          >
                            {s === "active" ? ACTIVE_LABEL[i] : step}
                            <span className="sr-only">{s === "done" ? " (done)" : s === "error" ? " (failed)" : s === "pending" ? " (to do)" : " (in progress)"}</span>
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                  {state === "error" ? (
                    <>
                      <p role="alert" className="m-0 rounded-xl bg-terracotta-tint px-3 py-2 text-sm text-terracotta-strong">
                        {error ?? "Something went wrong. Nothing was sent."}
                      </p>
                      <div className="flex gap-2.5">
                        <Dialog.Close asChild>
                          <Button variant="soft">Close</Button>
                        </Dialog.Close>
                        {onRetry ? (
                          <Button variant="cause" onClick={onRetry}>
                            Try again
                          </Button>
                        ) : null}
                      </div>
                    </>
                  ) : state === "wallet" ? (
                    <p className="m-0 text-[13px] text-ink-muted">Check your wallet. Keep this window open until it&apos;s sent.</p>
                  ) : null}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
          <span role="status" className="sr-only">
            {statusText}
          </span>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function StepMark({ status }: { status: StepStatus }) {
  const base = "grid size-5 shrink-0 place-items-center rounded-full";
  if (status === "done")
    return (
      <span aria-hidden="true" className={cn(base, "bg-sage-tint text-gain")}>
        <Check className="size-3.5" strokeWidth={3} />
      </span>
    );
  if (status === "error")
    return (
      <span aria-hidden="true" className={cn(base, "bg-terracotta-tint text-loss")}>
        <X className="size-3.5" strokeWidth={3} />
      </span>
    );
  if (status === "active")
    return (
      <span aria-hidden="true" className={cn(base, "text-ink")}>
        <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
      </span>
    );
  return (
    <span aria-hidden="true" className={cn(base)}>
      <span className="size-1.5 rounded-full bg-line-strong" />
    </span>
  );
}
