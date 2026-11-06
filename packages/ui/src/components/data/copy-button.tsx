// Adapted from 21st.dev @ddoemonn/copy-button (id 23529): clipboard hook with fallback, icon and label crossfade, live status.
"use client";

import { type VariantProps } from "class-variance-authority";
import { Check, Copy, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { buttonVariants } from "@varada/ui/components/ui/button";
import { cn } from "@varada/ui/lib/utils";

export type CopyStatus = "idle" | "copied" | "error";

function writeFallback(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}

/** Copy text to the clipboard; `status` returns to idle after `timeout` ms. */
export function useCopyToClipboard({ timeout = 2000, onCopy }: { timeout?: number; onCopy?: (value: string) => void } = {}) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const [ticket, setTicket] = useState(0);
  const mounted = useRef(true);
  const onCopyRef = useRef(onCopy);
  useEffect(() => {
    onCopyRef.current = onCopy;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const copy = useCallback(async (text: string) => {
    let ok = false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else ok = writeFallback(text);
    } catch {
      try {
        ok = writeFallback(text);
      } catch {
        ok = false;
      }
    }
    if (!mounted.current) return ok;
    setStatus(ok ? "copied" : "error");
    setTicket((t) => t + 1);
    if (ok) onCopyRef.current?.(text);
    return ok;
  }, []);

  useEffect(() => {
    if (ticket === 0 || status === "idle") return;
    const id = setTimeout(() => setStatus("idle"), timeout);
    return () => clearTimeout(id);
  }, [ticket, status, timeout]);

  return { copy, status };
}

export interface CopyButtonProps extends VariantProps<typeof buttonVariants> {
  /** The text that goes on the clipboard (full address, ENS name, tx hash). */
  value: string;
  /** What the button does, e.g. "Copy address". Also the accessible name. */
  label?: string;
  copiedLabel?: string;
  errorLabel?: string;
  /** Visible content instead of the label, e.g. a shortened address. */
  children?: ReactNode;
  /** Show only the icon (the label becomes the accessible name). */
  iconOnly?: boolean;
  timeout?: number;
  onCopy?: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

const ICONS = { idle: Copy, copied: Check, error: X } as const;

/** Copies an address or ENS name and confirms it in place (icon, label and a polite announcement). */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  errorLabel = "Copy failed",
  children,
  iconOnly = false,
  timeout = 2000,
  onCopy,
  disabled,
  variant = "soft",
  size,
  className,
}: CopyButtonProps) {
  const { copy, status } = useCopyToClipboard({ timeout, onCopy });
  const reduced = useReducedMotion();
  const fade = reduced ? { duration: 0 } : ({ type: "spring", stiffness: 300, damping: 30 } as const);
  const statusText = status === "copied" ? copiedLabel : status === "error" ? errorLabel : label;

  return (
    <>
      <button
        type="button"
        data-slot="copy-button"
        data-status={status}
        disabled={disabled}
        aria-label={iconOnly ? label : undefined}
        onClick={() => void copy(value)}
        className={cn(
          buttonVariants({ variant, size: size ?? (iconOnly ? "icon" : "md") }),
          status === "copied" && "text-sage-ink",
          status === "error" && "text-destructive",
          className,
        )}
      >
        <span className="grid size-4 shrink-0" aria-hidden="true">
          {(Object.keys(ICONS) as CopyStatus[]).map((key) => {
            const Icon = ICONS[key];
            return (
              <motion.span
                key={key}
                className="col-start-1 row-start-1"
                initial={false}
                animate={{ opacity: status === key ? 1 : 0, scale: status === key ? 1 : 0.6 }}
                transition={fade}
              >
                <Icon className="size-4" strokeWidth={2.25} />
              </motion.span>
            );
          })}
        </span>
        {iconOnly ? null : children ? (
          <>
            <span className="sr-only">{label}: </span>
            {children}
          </>
        ) : (
          <span className="relative grid">
            {/* Reserve the widest label so the pill never changes width. */}
            {[label, copiedLabel, errorLabel].map((text, i) => (
              <motion.span
                key={i}
                aria-hidden={text !== statusText || undefined}
                className="col-start-1 row-start-1 whitespace-nowrap"
                initial={false}
                animate={{ opacity: text === statusText ? 1 : 0, y: text === statusText ? 0 : 3 }}
                transition={fade}
              >
                {text}
              </motion.span>
            ))}
          </span>
        )}
      </button>
      <span role="status" className="sr-only">
        {status === "copied" ? copiedLabel : status === "error" ? errorLabel : ""}
      </span>
    </>
  );
}
