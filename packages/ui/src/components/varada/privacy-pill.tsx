// Written for Varada
import { CircleAlert, LoaderCircle, LockKeyhole, LockKeyholeOpen } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";

/**
 * Where reads are going: `connecting` to the Nym mixnet, `private` (on), `failed` (the mixnet
 * route is down; reads paused or retrying), `direct` (reads go straight to a public RPC, so the
 * user's IP is not anonymised).
 */
export type PrivacyState = "connecting" | "private" | "failed" | "direct";

const STATES: Record<PrivacyState, { label: string; detail: string; tone: string; Icon: typeof LockKeyhole }> = {
  connecting: { label: "Connecting privately", detail: "Opening a route through the Nym mixnet", tone: "bg-sand text-ink", Icon: LoaderCircle },
  private: { label: "Private RPC on", detail: "Reads go through the Nym mixnet", tone: "bg-sage-tint text-sage-ink", Icon: LockKeyhole },
  failed: { label: "Private RPC failed", detail: "The mixnet route is down; retrying", tone: "bg-terracotta-tint text-terracotta-strong", Icon: CircleAlert },
  direct: { label: "Not anonymised", detail: "Reads go to a public RPC that can see your IP", tone: "bg-ochre-tint text-ochre-ink", Icon: LockKeyholeOpen },
};

type PillBase = {
  state: PrivacyState;
  /** Network name shown after the label when private ("Nym"). */
  network?: string;
  /** Override the visible label. */
  label?: string;
  className?: string;
};

export type PrivacyPillProps =
  | (PillBase & { onClick?: undefined } & Omit<ComponentProps<"span">, "onClick">)
  | (PillBase & { onClick: () => void } & Omit<ComponentProps<"button">, "onClick">);

/** Status pill for the private read path. With `onClick` it is a button (e.g. to open details). */
export function PrivacyPill({ state, network = "Nym", label, className, onClick, ...props }: PrivacyPillProps) {
  const s = STATES[state];
  const text = label ?? (state === "private" ? `${s.label} · ${network}` : s.label);
  const classes = cn(
    "inline-flex min-h-9 items-center gap-2 whitespace-nowrap rounded-full px-3 text-[13px] font-semibold",
    s.tone,
    onClick && "transition-[filter] hover:brightness-95",
    className,
  );
  const content = (
    <>
      <s.Icon aria-hidden="true" className={cn("size-3.5", state === "connecting" && "animate-spin motion-reduce:animate-none")} />
      <span>{text}</span>
      <span className="sr-only">. {s.detail}.</span>
    </>
  );
  if (onClick) {
    return (
      <button type="button" data-slot="privacy-pill" data-state={state} title={s.detail} onClick={onClick} className={cn(classes, "min-h-11")} {...(props as ComponentProps<"button">)}>
        {content}
      </button>
    );
  }
  return (
    <span role="status" data-slot="privacy-pill" data-state={state} title={s.detail} className={classes} {...(props as ComponentProps<"span">)}>
      {content}
    </span>
  );
}
