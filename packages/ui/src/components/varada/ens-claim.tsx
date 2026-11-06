// Adapted from 21st.dev @ddoemonn/inline-validation (id 23564): debounced check, crossfading status
// icons and message, polite announcement. The stamp's serrated seal follows @designali-in/stamp
// (id 3417). Ink texture, Varada copy, availability states and the stamping motion written for Varada.
"use client";

import { Check, LoaderCircle, Lock, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "@varada/ui/components/ui/button";
import { Input, InputAddon, InputGroup } from "@varada/ui/components/ui/input";
import { cn } from "@varada/ui/lib/utils";
import { ENS_PARENT, LABEL_PROBLEM_TEXT, ensNameFor, labelProblem, normalizeLabel } from "./ens-shared";
import { LogoMark } from "./logo-mark";

export type EnsAvailability = "idle" | "checking" | "available" | "taken" | "reserved" | "invalid";

/** What a lookup can return for a valid label. "reserved" means reserved for the connected wallet. */
export type EnsLookupResult = "available" | "taken" | "reserved";

export interface EnsClaimProps {
  /** The typed label (controlled). */
  value?: string;
  defaultValue?: string;
  onValueChange?: (label: string) => void;
  /**
   * Availability from the app. When set it is shown as is (the app runs `labelProblem` too); when
   * left out, the component validates locally and calls `check`.
   */
  status?: EnsAvailability;
  /** Looks a valid label up, after `debounce` ms of no typing. Aborted when the label changes. */
  check?: (label: string, signal: AbortSignal) => Promise<EnsLookupResult>;
  debounce?: number;
  parent?: string;
  label?: string;
  hint?: string;
  /** Labels offered when the name is taken. */
  suggestions?: string[];
  onClaim?: (label: string) => void;
  claimLabel?: string;
  /** Busy claiming (wallet open): the button shows a spinner. */
  claiming?: boolean;
  disabled?: boolean;
  className?: string;
}

const SETTLED: EnsAvailability[] = ["available", "taken", "reserved", "invalid"];

/** Message for a state, as shown under the field and announced. */
export function availabilityMessage(status: EnsAvailability, name: string, problemText?: string, hint?: string): string {
  switch (status) {
    case "checking":
      return `Checking ${name}…`;
    case "available":
      return `${name} is available`;
    case "taken":
      return `${name} is taken`;
    case "reserved":
      return `${name} is reserved for you`;
    case "invalid":
      return problemText ?? "That name can't be used";
    default:
      return hint ?? "";
  }
}

/** The serrated seal from @designali-in/stamp, as a path in a 64×64 box. */
function serratedPath(teeth = 32, outer = 32, inner = 29) {
  let d = "";
  for (let i = 0; i < teeth * 2; i++) {
    const a = (i / (teeth * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? outer : inner;
    d += `${i === 0 ? "M" : "L"}${(32 + Math.cos(a) * r).toFixed(2)} ${(32 + Math.sin(a) * r).toFixed(2)}`;
  }
  return `${d}Z`;
}
const SEAL = serratedPath();

/** The name pressed onto the paper like a rubber stamp: sage when available, ochre when reserved for you. */
function NameStamp({ name, reserved }: { name: string; reserved: boolean }) {
  const reduced = useReducedMotion();
  const id = `stamp-${useId().replace(/:/g, "")}`;
  const ink = reserved ? "text-ochre-ink border-ochre-ink" : "text-sage-ink border-sage-ink";
  const press = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.15 } }
    : {
        initial: { opacity: 0, scale: 1.9, rotate: -14, y: -18 },
        animate: { opacity: 1, scale: 1, rotate: -3, y: 0 },
        transition: { type: "spring" as const, stiffness: 520, damping: 24, mass: 0.9 },
      };
  return (
    <motion.div
      aria-hidden="true"
      data-slot="ens-stamp"
      className="relative flex items-center gap-3 self-start"
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      {...press}
    >
      {/* Rough ink: speckle erosion plus a slight warp, applied to the HTML stamp as a CSS filter. */}
      <svg width="0" height="0" className="absolute">
        <filter id={id}>
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={1} seed={5} result="noise" />
          <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1 1.35" result="mask" />
          <feComposite in="SourceGraphic" in2="mask" operator="in" result="eroded" />
          <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves={2} seed={9} result="warp" />
          <feDisplacementMap in="eroded" in2="warp" scale={2.5} />
        </filter>
      </svg>
      {reduced ? null : (
        <motion.span
          className={cn("pointer-events-none absolute inset-0 rounded-lg border-2", ink)}
          initial={{ opacity: 0.45, scale: 0.9 }}
          animate={{ opacity: 0, scale: 1.25 }}
          transition={{ duration: 0.55, ease: "easeOut", delay: 0.08 }}
        />
      )}
      <span className="relative grid size-14 shrink-0 place-items-center" style={{ filter: `url(#${id})` }}>
        <svg viewBox="0 0 64 64" className={cn("absolute inset-0 size-full", reserved ? "text-ochre-ink" : "text-sage-ink")}>
          <path d={SEAL} fill="currentColor" fillOpacity={0.12} stroke="currentColor" strokeWidth={1.5} />
          <circle cx="32" cy="32" r="24" fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="2 2" />
        </svg>
        <LogoMark size={30} decorative ringColor="currentColor" className={reserved ? "text-ochre-ink" : "text-sage-ink"} />
      </span>
      <span
        className={cn("flex min-w-0 flex-col rounded-lg border-[2.5px] px-3 py-1.5 outline outline-1 outline-offset-2", ink, reserved ? "outline-ochre-ink/60" : "outline-sage-ink/60")}
        style={{ filter: `url(#${id})` }}
      >
        <span className="text-[11px] font-bold uppercase tracking-[0.2em]">{reserved ? "Reserved for you" : "Available"}</span>
        <span className="num break-all text-base font-bold">{name}</span>
      </span>
    </motion.div>
  );
}

const ICON_BY_STATUS: Partial<Record<EnsAvailability, typeof Check>> = {
  available: Check,
  reserved: Lock,
  taken: X,
  invalid: X,
};

/**
 * Pick a `<label>.varada.eth` name: live availability as you type (checking → available, taken,
 * reserved for you, or invalid), with the name stamping onto the paper when it can be claimed.
 * Settled results are announced politely, at most once per result.
 */
export function EnsClaim({
  value: valueProp,
  defaultValue = "",
  onValueChange,
  status: statusProp,
  check,
  debounce = 350,
  parent = ENS_PARENT,
  label: fieldLabel = "Coin name",
  hint = "3 to 63 characters: lowercase letters, digits and hyphens.",
  suggestions,
  onClaim,
  claimLabel = "Claim name",
  claiming,
  disabled,
  className,
}: EnsClaimProps) {
  const auto = useId();
  const fieldId = `${auto}-field`;
  const messageId = `${auto}-message`;
  const reduced = useReducedMotion();

  const [inner, setInner] = useState(defaultValue);
  const raw = valueProp ?? inner;
  const label = normalizeLabel(raw);
  const name = ensNameFor(label || "yourcoin", parent);
  const problem = labelProblem(label);

  // The last settled result, and for which label it was computed.
  const [resolved, setResolved] = useState<{ label: string; status: EnsAvailability }>({ label: "", status: "idle" });
  const checkRef = useRef(check);
  useEffect(() => {
    checkRef.current = check;
  });

  useEffect(() => {
    if (statusProp !== undefined) return;
    if (problem === "empty") {
      setResolved({ label, status: "idle" });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (problem) {
        setResolved({ label, status: "invalid" });
        return;
      }
      const run = checkRef.current;
      if (!run) {
        setResolved({ label, status: "idle" });
        return;
      }
      run(label, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setResolved({ label, status: result });
        })
        .catch(() => {
          if (!controller.signal.aborted) setResolved({ label, status: "idle" });
        });
    }, debounce);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [label, problem, debounce, statusProp]);

  let status: EnsAvailability;
  if (statusProp !== undefined) status = statusProp;
  else if (resolved.label === label) status = resolved.status;
  else status = problem === "empty" ? "idle" : problem || !check ? "idle" : "checking";

  const message = availabilityMessage(status, name, problem && problem !== "empty" ? LABEL_PROBLEM_TEXT[problem] : undefined, hint);

  // Announce settled results only (not every keystroke, not "checking").
  const announcement = SETTLED.includes(status) && label ? message : "";

  const claimable = (status === "available" || status === "reserved") && !!label;
  const Icon = ICON_BY_STATUS[status];
  const fade = reduced ? { duration: 0 } : ({ type: "spring", stiffness: 300, damping: 30 } as const);

  const set = (next: string) => {
    if (valueProp === undefined) setInner(next);
    onValueChange?.(next);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (claimable && !claiming) onClaim?.(label);
  };

  const tone = useMemo(() => {
    if (status === "available") return "text-sage-ink";
    if (status === "reserved") return "text-ochre-ink";
    if (status === "taken" || status === "invalid") return "text-destructive";
    return "text-ink-muted";
  }, [status]);

  return (
    <form data-slot="ens-claim" data-status={status} onSubmit={submit} className={cn("@container flex flex-col gap-3", className)} noValidate>
      <label htmlFor={fieldId} className="text-sm font-semibold text-ink">
        {fieldLabel}
      </label>
      <div className="flex flex-col gap-2 @md:flex-row">
        <InputGroup
          className={cn(
            "h-12 flex-1",
            status === "available" && "border-sage",
            status === "reserved" && "border-ochre",
          )}
        >
          <Input
            id={fieldId}
            value={raw}
            onChange={(e) => set(e.target.value)}
            disabled={disabled}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            placeholder="harambe"
            aria-describedby={messageId}
            aria-invalid={status === "invalid" || undefined}
            className="num text-base"
          />
          <InputAddon className="num font-normal">.{parent}</InputAddon>
          <span className={cn("grid size-5 shrink-0 place-items-center", tone)} aria-hidden="true">
            {status === "checking" ? (
              <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" />
            ) : Icon ? (
              <motion.span key={status} initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} transition={fade}>
                <Icon className="size-5" strokeWidth={2.5} />
              </motion.span>
            ) : null}
          </span>
        </InputGroup>
        {onClaim ? (
          <Button type="submit" size="lg" disabled={!claimable || disabled || claiming} aria-busy={claiming || undefined} className="h-12 @md:w-auto">
            {claiming ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : null}
            {claimLabel}
          </Button>
        ) : null}
      </div>

      <div className="grid min-h-5">
        <motion.p
          key={`${status}-${status === "idle" ? "" : label}`}
          id={messageId}
          className={cn("col-start-1 row-start-1 m-0 text-sm", tone)}
          initial={reduced ? false : { opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={fade}
        >
          {message}
        </motion.p>
      </div>

      <AnimatePresence mode="popLayout" initial={false}>
        {claimable ? <NameStamp key={`${status}-${label}`} name={name} reserved={status === "reserved"} /> : null}
      </AnimatePresence>

      {status === "taken" && suggestions?.length ? (
        <div className="flex flex-col gap-2">
          <span className="kicker">Try instead</span>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {suggestions.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  onClick={() => set(s)}
                  className="num inline-flex min-h-11 items-center rounded-full border border-line-strong bg-card px-4 text-sm text-ink transition-colors hover:bg-sand"
                >
                  {s}
                  <span className="text-ink-muted">.{parent}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
    </form>
  );
}
