// Written for Varada
"use client";

import type { ComponentProps } from "react";
import { useAssetUrl } from "@verada/ui/lib/assets";
import { cn } from "@verada/ui/lib/utils";

/**
 * Cause categories by the curator agent's ENS label (`<name>.agent.varada.eth`), plus the catch-all
 * `other`. Labels and order are copied from packages/sdk/src/catalog.ts (CATEGORIES); keep the two
 * in step. The UI package doesn't import the SDK.
 */
export const CAUSE_LABELS = {
  disaster: "Disaster relief",
  homeless: "Homelessness",
  hunger: "Hunger & famine",
  children: "Children & youth",
  disease: "Disease",
  cancer: "Cancer",
  wildlife: "Wildlife & endangered species",
  animals: "Animal welfare",
  environment: "Environment & climate",
  water: "Clean water & sanitation",
  health: "Health care",
  "mental-health": "Mental health",
  research: "Medical research",
  education: "Education",
  refugees: "Refugees & displaced people",
  "human-rights": "Human rights",
  women: "Women & girls",
  poverty: "Poverty & livelihoods",
  veterans: "Veterans",
  justice: "Justice & the wrongly accused",
  other: "Other",
} as const;

export type CauseName = keyof typeof CAUSE_LABELS;

export const CAUSE_NAMES = Object.keys(CAUSE_LABELS) as CauseName[];

/** Short labels for chips and dense rows. */
export const CAUSE_SHORT_LABELS: Record<CauseName, string> = {
  disaster: "Disaster relief",
  homeless: "Homelessness",
  hunger: "Hunger",
  children: "Children & youth",
  disease: "Disease",
  cancer: "Cancer",
  wildlife: "Wildlife",
  animals: "Animal welfare",
  environment: "Environment",
  water: "Clean water",
  health: "Health care",
  "mental-health": "Mental health",
  research: "Medical research",
  education: "Education",
  refugees: "Refugees",
  "human-rights": "Human rights",
  women: "Women & girls",
  poverty: "Poverty",
  veterans: "Veterans",
  justice: "Justice",
  other: "Other",
};

export function isCauseName(value: string): value is CauseName {
  return Object.prototype.hasOwnProperty.call(CAUSE_LABELS, value);
}

export interface CauseIconProps extends Omit<ComponentProps<"img">, "src" | "srcSet" | "alt" | "width" | "height"> {
  cause: CauseName;
  /** Rendered size in CSS px (square). */
  size?: number;
  /**
   * Decorative icons (next to a visible label) are hidden from assistive tech. Set false, or pass
   * `label`, when the icon stands alone and has to say which cause it is.
   */
  decorative?: boolean;
  /** Accessible name when not decorative; defaults to the catalogue label. */
  label?: string;
}

/** Painted cause icon from the site's asset pipeline (`assets/causes/<name>-128|256.webp`). */
export function CauseIcon({ cause, size = 40, decorative, label, className, ...props }: CauseIconProps) {
  const url = useAssetUrl();
  const isDecorative = decorative ?? label === undefined;
  return (
    <img
      src={url(`assets/causes/${cause}-128.webp`)}
      srcSet={`${url(`assets/causes/${cause}-128.webp`)} 128w, ${url(`assets/causes/${cause}-256.webp`)} 256w`}
      sizes={`${size}px`}
      width={size}
      height={size}
      alt={isDecorative ? "" : (label ?? CAUSE_LABELS[cause])}
      aria-hidden={isDecorative ? true : undefined}
      loading="lazy"
      decoding="async"
      className={cn("shrink-0 select-none object-contain", className)}
      style={{ width: size, height: size }}
      {...props}
    />
  );
}
