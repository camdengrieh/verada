"use client";
// shadcn/ui new-york Field pattern (label + control + hint + error), Direction A styling
import { Slot } from "radix-ui";
import { createContext, useContext, useEffect, useId, useMemo, useState, type ComponentProps } from "react";
import { CircleAlert } from "lucide-react";
import { Label } from "@varada/ui/components/ui/label";
import { cn } from "@varada/ui/lib/utils";

interface FieldContextValue {
  controlId: string;
  hintId: string;
  errorId: string;
  invalid: boolean;
  disabled: boolean;
  required: boolean;
  hasHint: boolean;
  hasError: boolean;
  setHasHint: (v: boolean) => void;
  setHasError: (v: boolean) => void;
}

const FieldContext = createContext<FieldContextValue | null>(null);

function useField(part: string): FieldContextValue {
  const ctx = useContext(FieldContext);
  if (!ctx) throw new Error(`${part} must be used inside <Field>.`);
  return ctx;
}

export interface FieldProps extends ComponentProps<"div"> {
  /** Marks the control `aria-invalid` and shows `FieldError`. */
  invalid?: boolean;
  disabled?: boolean;
  required?: boolean;
  /** Id for the control; generated when omitted. */
  controlId?: string;
}

/**
 * Wires a label, one control, a hint and an error together: the label targets the control, the
 * control is described by the hint and the error (`aria-describedby`), and `invalid` sets
 * `aria-invalid`. Wrap the control in `FieldControl`.
 *
 * @example
 * <Field invalid={!!error}>
 *   <FieldLabel>Amount</FieldLabel>
 *   <FieldControl><Input inputMode="decimal" /></FieldControl>
 *   <FieldHint>Fees: 1% of the trade, 90% to causes.</FieldHint>
 *   <FieldError>{error}</FieldError>
 * </Field>
 */
export function Field({ className, invalid = false, disabled = false, required = false, controlId, ...props }: FieldProps) {
  const auto = useId();
  const id = controlId ?? `field-${auto}`;
  const [hasHint, setHasHint] = useState(false);
  const [hasError, setHasError] = useState(false);
  const value = useMemo<FieldContextValue>(
    () => ({
      controlId: id,
      hintId: `${id}-hint`,
      errorId: `${id}-error`,
      invalid,
      disabled,
      required,
      hasHint,
      hasError,
      setHasHint,
      setHasError,
    }),
    [id, invalid, disabled, required, hasHint, hasError],
  );
  return (
    <FieldContext.Provider value={value}>
      <div
        data-slot="field"
        data-invalid={invalid || undefined}
        data-disabled={disabled || undefined}
        className={cn("group flex flex-col gap-2", className)}
        {...props}
      />
    </FieldContext.Provider>
  );
}

/** The field's label; `required` adds a visual marker (the control itself carries `required`). */
export function FieldLabel({ className, children, ...props }: ComponentProps<typeof Label>) {
  const { controlId, required, disabled } = useField("FieldLabel");
  return (
    <Label htmlFor={controlId} data-disabled={disabled || undefined} className={className} {...props}>
      {children}
      {required ? (
        <span aria-hidden="true" className="text-primary">
          *
        </span>
      ) : null}
    </Label>
  );
}

/**
 * Passes `id`, `aria-describedby`, `aria-invalid`, `required` and `disabled` to its single child
 * control (Input, Textarea, SelectTrigger, Switch…).
 */
export function FieldControl({ "aria-describedby": extra, ...props }: ComponentProps<typeof Slot.Root>) {
  const { controlId, hintId, errorId, invalid, disabled, required, hasHint, hasError } = useField("FieldControl");
  const describedBy = [extra, hasHint ? hintId : null, invalid && hasError ? errorId : null]
    .filter(Boolean)
    .join(" ");
  return (
    <Slot.Root
      data-slot="field-control"
      id={controlId}
      aria-describedby={describedBy || undefined}
      aria-invalid={invalid || undefined}
      aria-required={required || undefined}
      {...(disabled ? { disabled: true } : null)}
      {...props}
    />
  );
}

/** Helper text under the control. */
export function FieldHint({ className, ...props }: ComponentProps<"p">) {
  const { hintId, setHasHint } = useField("FieldHint");
  useEffect(() => {
    setHasHint(true);
    return () => setHasHint(false);
  }, [setHasHint]);
  return <p data-slot="field-hint" id={hintId} className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

/** Error text, shown only while the field is invalid and the error has content. */
export function FieldError({ className, children, ...props }: ComponentProps<"p">) {
  const { errorId, invalid, setHasError } = useField("FieldError");
  const show = invalid && children != null && children !== false && children !== "";
  useEffect(() => {
    setHasError(show);
    return () => setHasError(false);
  }, [show, setHasError]);
  if (!show) return null;
  return (
    <p
      data-slot="field-error"
      id={errorId}
      className={cn("flex items-start gap-1.5 text-sm font-medium text-destructive [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0", className)}
      {...props}
    >
      <CircleAlert aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** Groups related fields (e.g. a set of checkboxes) under a legend. */
export function FieldSet({ className, ...props }: ComponentProps<"fieldset">) {
  return <fieldset data-slot="field-set" className={cn("flex min-w-0 flex-col gap-3 border-0 p-0", className)} {...props} />;
}

export function FieldLegend({ className, ...props }: ComponentProps<"legend">) {
  return <legend data-slot="field-legend" className={cn("mb-1 text-sm font-semibold text-ink", className)} {...props} />;
}
