// Adapted from 21st.dev @ddoemonn/wizard-steps (id 23576); vertical side-rail layout written for Varada.
"use client";

import { Check } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "@varada/ui/components/ui/button";
import { StepTransition, type StepDirection } from "@varada/ui/components/motion/step-transition";
import { cn } from "@varada/ui/lib/utils";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function clampIndex(value: number, total: number) {
  if (total < 1) return 0;
  return Math.max(0, Math.min(total - 1, Math.trunc(value)));
}

export interface UseStepperOptions {
  total: number;
  index?: number;
  defaultIndex?: number;
  onIndexChange?: (index: number, direction: StepDirection) => void;
  onComplete?: () => void;
}

export interface StepperApi {
  index: number;
  direction: StepDirection;
  /** Furthest step reached so far; the rail lets you jump back to anything up to here. */
  furthest: number;
  total: number;
  isFirst: boolean;
  isLast: boolean;
  next: () => void;
  back: () => void;
  goTo: (index: number) => void;
}

/** Index, direction and furthest-reached bookkeeping for a multi-step flow (controlled or not). */
export function useStepper({ total, index, defaultIndex = 0, onIndexChange, onComplete }: UseStepperOptions): StepperApi {
  const [internal, setInternal] = useState(() => clampIndex(defaultIndex, total));
  const current = clampIndex(index ?? internal, total);

  const [seen, setSeen] = useState<{ index: number; direction: StepDirection }>({ index: current, direction: 1 });
  if (seen.index !== current) setSeen({ index: current, direction: current > seen.index ? 1 : -1 });

  const [furthest, setFurthest] = useState(current);
  if (furthest < current) setFurthest(current);

  const callbacks = useRef({ onIndexChange, onComplete });
  useIsoLayoutEffect(() => {
    callbacks.current = { onIndexChange, onComplete };
  });

  const controlled = index !== undefined;
  const goTo = useCallback(
    (to: number) => {
      const target = clampIndex(to, total);
      if (target === current) return;
      if (!controlled) setInternal(target);
      callbacks.current.onIndexChange?.(target, target > current ? 1 : -1);
    },
    [controlled, current, total],
  );
  const next = useCallback(() => {
    if (current >= total - 1) callbacks.current.onComplete?.();
    else goTo(current + 1);
  }, [current, goTo, total]);
  const back = useCallback(() => goTo(current - 1), [current, goTo]);

  return {
    index: current,
    direction: seen.direction,
    furthest: Math.min(furthest, Math.max(total - 1, 0)),
    total,
    isFirst: current === 0,
    isLast: current === total - 1,
    next,
    back,
    goTo,
  };
}

export interface StepperStep {
  id: string;
  label: string;
  /** Short hint under the label in the vertical rail, and under the heading. */
  description?: string;
  content: ReactNode;
}

export interface StepperProps extends Omit<UseStepperOptions, "total"> {
  steps: StepperStep[];
  /** `horizontal` puts the rail on top; `vertical` makes it a side rail from md up. */
  orientation?: "horizontal" | "vertical";
  /** Accessible name for the progress rail. */
  label?: string;
  /** Show every step as done and render `completeContent` in the panel. */
  complete?: boolean;
  completeContent?: ReactNode;
  /** False disables Next (e.g. the current step's form is invalid). */
  canAdvance?: boolean;
  /** Replace the default Back/Next footer. A function receives the stepper API. */
  footer?: ReactNode | ((api: StepperApi) => ReactNode);
  backLabel?: string;
  nextLabel?: string;
  finishLabel?: string;
  /** Heading level of the step title inside the panel. */
  headingLevel?: 2 | 3 | 4;
  className?: string;
  panelClassName?: string;
}

type FocusIntent = "heading" | "rail" | null;

/**
 * Multi-step wizard. The progress rail is an ordered list of buttons (completed, current with
 * `aria-current="step"`, upcoming) that jumps back to any reached step; arrow keys, Home and End
 * move along it. When the step changes from Next, Back or a rail click, focus lands on the new
 * step's heading. Panels slide in the direction of travel (or just swap with reduced motion).
 */
export function Stepper({
  steps,
  index,
  defaultIndex,
  onIndexChange,
  onComplete,
  orientation = "horizontal",
  label = "Progress",
  complete = false,
  completeContent,
  canAdvance = true,
  footer,
  backLabel = "Back",
  nextLabel = "Next",
  finishLabel = "Finish",
  headingLevel = 3,
  className,
  panelClassName,
}: StepperProps) {
  const api = useStepper({ total: steps.length, index, defaultIndex, onIndexChange, onComplete });
  const { index: at, direction, furthest, total, isFirst, isLast, next, back, goTo } = api;
  const railRef = useRef<HTMLOListElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const intent = useRef<FocusIntent>(null);
  const vertical = orientation === "vertical";

  const step = steps[at];
  const panelKey = complete ? "__complete" : (step?.id ?? "none");

  useEffect(() => {
    const move = intent.current;
    intent.current = null;
    if (move === "rail") {
      railRef.current?.querySelector<HTMLButtonElement>('button[aria-current="step"]')?.focus();
    } else if (move === "heading") {
      panelRef.current?.querySelector<HTMLElement>(`[data-step-heading="${CSS.escape(panelKey)}"]`)?.focus({ preventScroll: false });
    }
  }, [at, panelKey]);

  if (!step) return null;

  const onRailKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const keys: Record<string, number> = {
      ArrowRight: at + 1,
      ArrowDown: at + 1,
      ArrowLeft: at - 1,
      ArrowUp: at - 1,
      Home: 0,
      End: furthest,
    };
    const raw = keys[e.key];
    if (raw === undefined) return;
    e.preventDefault();
    const target = Math.min(clampIndex(raw, total), furthest);
    if (target === at) return;
    intent.current = "rail";
    goTo(target);
  };

  const footerApi: StepperApi = {
    ...api,
    next: () => {
      intent.current = "heading";
      next();
    },
    back: () => {
      intent.current = "heading";
      back();
    },
    goTo: (i) => {
      intent.current = "heading";
      goTo(i);
    },
  };
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  const position = complete ? "All steps complete" : `Step ${at + 1} of ${total}: ${step.label}`;

  const defaultFooter = (
    <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
      {isFirst || complete ? null : (
        <Button
          variant="outline"
          onClick={() => {
            intent.current = "heading";
            back();
          }}
        >
          {backLabel}
        </Button>
      )}
      {complete ? null : (
        <Button
          className="ml-auto"
          disabled={!canAdvance}
          onClick={() => {
            intent.current = "heading";
            next();
          }}
        >
          {isLast ? finishLabel : nextLabel}
        </Button>
      )}
    </div>
  );

  return (
    <div
      data-slot="stepper"
      data-orientation={orientation}
      className={cn("flex w-full flex-col gap-6", vertical && "md:flex-row md:items-start md:gap-10", className)}
    >
      <p aria-live="polite" className="sr-only">
        {position}
      </p>
      <ol
        ref={railRef}
        aria-label={label}
        className={cn("flex list-none items-center gap-1 p-0", vertical && "md:w-60 md:shrink-0 md:flex-col md:items-stretch md:gap-0")}
      >
        {steps.map((s, i) => {
          const done = complete || i < at;
          const here = !complete && i === at;
          const reachable = i <= furthest || complete;
          const state = done ? "complete" : here ? "current" : "upcoming";
          const name = `Step ${i + 1} of ${total}: ${s.label}${done ? ", completed" : ""}`;
          const circle = (
            <span
              aria-hidden="true"
              className={cn(
                "num grid size-9 shrink-0 place-items-center rounded-full border-2 text-sm font-semibold transition-colors",
                state === "complete" && "border-sage bg-sage text-paper",
                state === "current" && "border-primary bg-terracotta-tint text-terracotta-strong",
                state === "upcoming" && "border-line-strong bg-card text-ink-muted",
              )}
            >
              {done ? <Check className="size-4" strokeWidth={3} /> : i + 1}
            </span>
          );
          const text = (
            <span
              aria-hidden="true"
              className={cn(
                "flex-col text-left",
                vertical ? "hidden md:flex" : "hidden lg:flex",
                state === "upcoming" ? "text-ink-muted" : "text-ink",
              )}
            >
              <span className="text-sm font-semibold leading-tight">{s.label}</span>
              {vertical && s.description ? <span className="text-xs text-ink-muted">{s.description}</span> : null}
            </span>
          );
          return (
            <li
              key={s.id}
              data-state={state}
              className={cn(
                "flex flex-1 items-center gap-1 last:flex-none",
                vertical && "md:flex-none md:flex-col md:items-stretch md:gap-0",
              )}
            >
              {reachable ? (
                <button
                  type="button"
                  aria-current={here ? "step" : undefined}
                  aria-label={name}
                  tabIndex={here || (complete && i === total - 1) ? 0 : -1}
                  onKeyDown={onRailKeyDown}
                  onClick={() => {
                    if (here) return;
                    intent.current = "heading";
                    goTo(i);
                  }}
                  className="flex min-h-11 min-w-11 items-center justify-center gap-3 rounded-full p-1 hover:bg-sand md:justify-start"
                >
                  {circle}
                  {text}
                </button>
              ) : (
                <span className="flex min-h-11 min-w-11 items-center justify-center gap-3 p-1 md:justify-start">
                  <span className="sr-only">{name}</span>
                  {circle}
                  {text}
                </span>
              )}
              {i < total - 1 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-0.5 min-w-0 flex-1 rounded-full transition-colors duration-300",
                    vertical && "md:ml-[25px] md:h-5 md:w-0.5 md:min-w-0 md:flex-none",
                    done ? "bg-sage" : "bg-line",
                  )}
                />
              ) : null}
            </li>
          );
        })}
      </ol>

      <div ref={panelRef} className="flex min-w-0 flex-1 flex-col gap-5">
        <StepTransition stepKey={panelKey} direction={direction} panelClassName={cn("flex flex-col gap-4", panelClassName)}>
          {complete ? (
            <div className="flex flex-col gap-2">
              <Heading tabIndex={-1} data-step-heading="__complete" className="font-display text-2xl font-semibold outline-none focus-visible:outline-2">
                All set
              </Heading>
              {completeContent}
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <span className="kicker">
                  Step <span className="num">{at + 1}</span> of <span className="num">{total}</span>
                </span>
                <Heading
                  tabIndex={-1}
                  data-step-heading={step.id}
                  className="font-display text-2xl font-semibold leading-tight outline-none focus-visible:outline-2"
                >
                  {step.label}
                </Heading>
                {step.description ? <p className="text-sm text-muted-foreground">{step.description}</p> : null}
              </div>
              <div>{step.content}</div>
            </>
          )}
        </StepTransition>
        {footer === undefined ? defaultFooter : typeof footer === "function" ? footer(footerApi) : footer}
      </div>
    </div>
  );
}
