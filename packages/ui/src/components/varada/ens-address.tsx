// Written for Varada (copy control from data/copy-button, adapted from 21st.dev @ddoemonn/copy-button id 23529)
"use client";

import { ArrowLeftRight, ArrowRight, LoaderCircle } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { ComponentProps } from "react";
import { CopyButton } from "@varada/ui/components/data/copy-button";
import { cn } from "@varada/ui/lib/utils";
import { shortenAddress, splitEnsName, toneFor } from "./ens-shared";
import { HIT_AREA, WASH_FILL, WASH_PIGMENT, type ImageSource } from "./shared";

export interface EnsAddressProps extends Omit<ComponentProps<"div">, "children"> {
  /** 0x… address. */
  address: string;
  /** Resolved name, when there is one. */
  name?: string;
  /** Avatar from the name's `avatar` record (a ready URL), or the coin logo. */
  avatar?: ImageSource;
  /** Still resolving the name: shows a spinner where the name goes. */
  resolving?: boolean;
  /**
   * `forward`: name → address (what the name resolves to). `reverse`: address → name (primary name).
   * `both`: the pair verifies both ways.
   */
  direction?: "forward" | "reverse" | "both";
  /** Which value the copy button copies. */
  copyValue?: "address" | "name";
  /** Drop the copy button. */
  noCopy?: boolean;
  /** With a name, show only the name (the address stays in the tooltip and for screen readers). */
  nameOnly?: boolean;
}

function Avatar({ seed, avatar, label }: { seed: string; avatar?: ImageSource; label?: string }) {
  const tone = toneFor(seed);
  if (avatar) {
    return (
      <img
        src={avatar.src}
        srcSet={avatar.srcSet}
        sizes={avatar.sizes ?? "32px"}
        alt=""
        width={32}
        height={32}
        className="size-8 shrink-0 rounded-full bg-sand object-cover ring-2 ring-card"
      />
    );
  }
  // Fallback: a painted bloom in a stable pigment, with the label's first letter.
  return (
    <span aria-hidden="true" className={cn("relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-full ring-2 ring-card", WASH_FILL[tone])}>
      <span className="absolute -left-1 -top-1 size-6 rounded-full opacity-50 blur-[3px]" style={{ background: WASH_PIGMENT[tone] }} />
      <span className="relative text-xs font-bold uppercase text-ink">{label?.[0] ?? seed.slice(2, 3)}</span>
    </span>
  );
}

/**
 * Address ↔ name chip: avatar, the name with its parent dimmed, a resolves-to arrow and the shortened
 * address, with copy. Screen readers hear "harambe.varada.eth resolves to 0x7f3a…c21e".
 */
export function EnsAddress({
  address,
  name,
  avatar,
  resolving,
  direction = "forward",
  copyValue = "address",
  noCopy,
  nameOnly,
  className,
  ...props
}: EnsAddressProps) {
  const reduced = useReducedMotion();
  const short = shortenAddress(address);
  const parts = name ? splitEnsName(name) : null;
  const Arrow = direction === "both" ? ArrowLeftRight : ArrowRight;
  const relation = direction === "reverse" ? "is the primary name of" : direction === "both" ? "resolves to and from" : "resolves to";
  const copyText = copyValue === "name" && name ? name : address;

  return (
    <div
      data-slot="ens-address"
      className={cn("inline-flex min-h-11 max-w-full items-center gap-2 rounded-full border border-line bg-card py-1 pl-1 pr-1.5", className)}
      {...props}
    >
      <Avatar seed={address.toLowerCase()} avatar={avatar} label={parts?.label} />
      {resolving ? (
        <span className="inline-flex items-center gap-1.5 text-sm text-ink-muted">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
          Resolving…
        </span>
      ) : parts ? (
        <motion.span
          key={name}
          className="min-w-0 truncate text-sm font-semibold text-ink"
          title={nameOnly ? address : undefined}
          initial={reduced ? false : { opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
        >
          {parts.label}
          <span className="font-normal text-ink-muted">.{parts.parent}</span>
        </motion.span>
      ) : null}
      {parts && !resolving && nameOnly ? (
        <span className="sr-only">
          {" "}
          {relation} {short}
        </span>
      ) : (
        <>
          {parts && !resolving ? (
            <>
              <Arrow aria-hidden="true" className="size-3.5 shrink-0 text-ink-muted" />
              <span className="sr-only"> {relation} </span>
            </>
          ) : null}
          <span className="num shrink-0 text-[13px] text-ink-soft" title={address}>
            {short}
          </span>
        </>
      )}
      {noCopy ? null : (
        <CopyButton
          value={copyText}
          label={copyValue === "name" && name ? `Copy ${name}` : "Copy address"}
          iconOnly
          variant="ghost"
          size="icon-sm"
          className={cn("size-8", HIT_AREA, "after:-inset-1.5")}
        />
      )}
    </div>
  );
}
