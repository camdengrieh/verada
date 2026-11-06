// Written for Varada (copy control from data/copy-button, adapted from 21st.dev @ddoemonn/copy-button id 23529)
"use client";

import { BadgeCheck, ExternalLink, Star } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { CopyButton } from "@verada/ui/components/data/copy-button";
import { cn } from "@verada/ui/lib/utils";
import { splitEnsName } from "./ens-shared";
import { HIT_AREA } from "./shared";

export interface EnsNameProps extends Omit<ComponentProps<"span">, "children"> {
  /** Full name, e.g. "harambe.varada.eth". */
  name: string;
  /** Show a copy button (copies the full name). */
  copy?: boolean;
  /** Link target for the name's site, usually `ensLimoUrl(name)` → harambe.varada.eth.limo. */
  siteHref?: string;
  siteLabel?: string;
  /** Records checked against the resolver (owner signed them). */
  verified?: boolean;
  /** This is the address's primary (reverse) name. */
  primary?: boolean;
  size?: "sm" | "md" | "lg";
  /** Extra controls after the name (a menu, an edit button). */
  trailing?: ReactNode;
}

const SIZES = {
  sm: "text-sm",
  md: "text-base",
  lg: "font-display text-2xl tracking-tight",
} as const;

/**
 * An ENS name with its label in ink and the parent (`.varada.eth`) dimmed, plus optional verified and
 * primary marks, copy, and a link to the name's site on eth.limo. Long names wrap at the dots.
 */
export function EnsName({
  name,
  copy = true,
  siteHref,
  siteLabel = "Open site",
  verified,
  primary,
  size = "md",
  trailing,
  className,
  ...props
}: EnsNameProps) {
  const { label, parent } = splitEnsName(name);
  const iconSize = size === "lg" ? "size-5" : "size-4";
  return (
    <span data-slot="ens-name" className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1", className)} {...props}>
      <span className={cn("min-w-0 break-words font-semibold text-ink", SIZES[size])}>
        {label}
        <wbr />
        <span className="font-normal text-ink-muted">.{parent}</span>
      </span>
      {verified ? (
        <span className="inline-flex items-center text-sage" title="Records verified">
          <BadgeCheck aria-hidden="true" className={iconSize} />
          <span className="sr-only">, verified</span>
        </span>
      ) : null}
      {primary ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-ochre-tint px-2 py-0.5 text-xs font-semibold text-ochre-ink" title="Primary name for this address">
          <Star aria-hidden="true" className="size-3 fill-current" />
          Primary
        </span>
      ) : null}
      {copy ? <CopyButton value={name} label={`Copy ${name}`} iconOnly variant="ghost" size="icon-sm" className={HIT_AREA} /> : null}
      {siteHref ? (
        <a
          href={siteHref}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${siteLabel}: ${name} (opens in a new tab)`}
          className={cn(
            "inline-flex size-9 items-center justify-center rounded-full text-ink-soft transition-colors hover:bg-sand hover:text-ink",
            HIT_AREA,
          )}
        >
          <ExternalLink aria-hidden="true" className="size-4" />
        </a>
      ) : null}
      {trailing}
    </span>
  );
}
