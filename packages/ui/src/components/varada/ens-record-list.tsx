// Written for Varada (status crossfade follows 21st.dev @ddoemonn/inline-validation, id 23564)
"use client";

import { Check, CircleAlert, LoaderCircle, PencilLine, RotateCcw } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, type ComponentProps } from "react";
import { Button } from "@varada/ui/components/ui/button";
import { Input } from "@varada/ui/components/ui/input";
import { Textarea } from "@varada/ui/components/ui/textarea";
import { cn } from "@varada/ui/lib/utils";
import { textRecordMeta } from "./ens-shared";
import { HIT_AREA } from "./shared";

/** saved: matches the resolver · edited: changed here, not sent · pending: in a transaction · error: that transaction failed. */
export type RecordState = "saved" | "edited" | "pending" | "error";

export interface EditableRecord {
  key: string;
  value: string;
  /** What the resolver holds now. Used to work out "edited" when `state` isn't given. */
  savedValue?: string;
  state?: RecordState;
  error?: string;
  placeholder?: string;
}

export function recordState(r: EditableRecord): RecordState {
  if (r.state) return r.state;
  return (r.savedValue ?? "") === r.value ? "saved" : "edited";
}

export interface EnsRecordListProps extends Omit<ComponentProps<"form">, "onChange" | "onSubmit"> {
  /** The name being edited, for labels ("Text records for harambe.varada.eth"). */
  name: string;
  records: EditableRecord[];
  onRecordChange: (key: string, value: string) => void;
  /** Put a record back to its saved value. */
  onRecordReset?: (key: string) => void;
  /** Send every edited record in one transaction. */
  onSave?: () => void;
  saving?: boolean;
}

const STATE_UI: Record<RecordState, { label: string; className: string }> = {
  saved: { label: "Saved", className: "bg-sage-tint text-sage-ink" },
  edited: { label: "Edited", className: "bg-ochre-tint text-ochre-ink" },
  pending: { label: "Pending", className: "bg-stock-tint text-stock-ink" },
  error: { label: "Failed", className: "bg-terracotta-tint text-terracotta-strong" },
};

function StateIcon({ state }: { state: RecordState }) {
  if (state === "pending") return <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />;
  if (state === "saved") return <Check aria-hidden="true" className="size-3.5" />;
  if (state === "error") return <CircleAlert aria-hidden="true" className="size-3.5" />;
  return <PencilLine aria-hidden="true" className="size-3.5" />;
}

/**
 * Edit-profile layout for a name's text records: key with its icon, the value field, and a saved /
 * edited / pending / failed state per row. Edited rows can be reset; the footer sends them together.
 */
export function EnsRecordList({ name, records, onRecordChange, onRecordReset, onSave, saving, className, ...props }: EnsRecordListProps) {
  const auto = useId();
  const reduced = useReducedMotion();
  const fade = reduced ? { duration: 0 } : ({ type: "spring", stiffness: 300, damping: 30 } as const);
  const states = records.map(recordState);
  const edited = states.filter((s) => s === "edited" || s === "error").length;
  const pending = states.filter((s) => s === "pending").length;
  const summary = pending
    ? `${pending} ${pending === 1 ? "record" : "records"} pending`
    : edited
      ? `${edited} unsaved ${edited === 1 ? "change" : "changes"}`
      : "All records saved";

  return (
    <form
      data-slot="ens-record-list"
      aria-label={`Text records for ${name}`}
      className={cn("@container flex flex-col gap-1", className)}
      onSubmit={(e) => {
        e.preventDefault();
        if (edited && !saving) onSave?.();
      }}
      {...props}
    >
      <ul className="m-0 flex list-none flex-col p-0">
        {records.map((r, i) => {
          const meta = textRecordMeta(r.key);
          const Icon = meta.icon;
          const state = states[i] ?? "saved";
          const ui = STATE_UI[state];
          const fieldId = `${auto}-${i}`;
          const statusId = `${fieldId}-status`;
          const Control = r.key === "description" ? Textarea : Input;
          return (
            <li
              key={r.key}
              data-state={state}
              className="grid gap-x-4 gap-y-2 border-b border-dashed border-line-strong py-3 last:border-b-0 @lg:grid-cols-[11rem_minmax(0,1fr)_auto] @lg:items-start"
            >
              <label htmlFor={fieldId} className="flex items-center gap-2.5 @lg:pt-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-sand text-ink-soft">
                  <Icon aria-hidden="true" className="size-4" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-semibold text-ink">{meta.label}</span>
                  <span className="num text-xs text-ink-muted">{r.key}</span>
                </span>
              </label>
              <div className="flex min-w-0 flex-col gap-1">
                <Control
                  id={fieldId}
                  value={r.value}
                  placeholder={r.placeholder}
                  disabled={state === "pending"}
                  aria-describedby={statusId}
                  aria-invalid={state === "error" || undefined}
                  onChange={(e) => onRecordChange(r.key, e.target.value)}
                  className={cn(r.key !== "description" && "num text-[14px]", state === "edited" && "border-ochre")}
                />
                {state === "error" && r.error ? <p className="m-0 text-sm text-destructive">{r.error}</p> : null}
              </div>
              <div className="flex items-center gap-1 @lg:pt-1.5">
                <span id={statusId} className="grid">
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span
                      key={state}
                      initial={reduced ? false : { opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={fade}
                      className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold", ui.className)}
                    >
                      <StateIcon state={state} />
                      {ui.label}
                    </motion.span>
                  </AnimatePresence>
                </span>
                {(state === "edited" || state === "error") && onRecordReset ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={HIT_AREA}
                    aria-label={`Reset ${meta.label}`}
                    onClick={() => onRecordReset(r.key)}
                  >
                    <RotateCcw />
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {onSave ? (
        <div className="flex flex-col gap-2 border-t border-line pt-3 @md:flex-row @md:items-center @md:justify-between">
          <span className="text-sm text-ink-soft">
            {summary}
            {edited ? <span className="text-ink-muted"> · one transaction</span> : null}
          </span>
          <Button type="submit" disabled={!edited || saving} aria-busy={saving || undefined}>
            {saving ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : null}
            {saving ? "Saving…" : edited ? `Save ${edited} ${edited === 1 ? "change" : "changes"}` : "Saved"}
          </Button>
        </div>
      ) : null}
      <span role="status" aria-live="polite" className="sr-only">
        {pending || !edited ? summary : ""}
      </span>
    </form>
  );
}
