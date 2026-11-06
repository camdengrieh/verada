"use client";

import { Button } from "@varada/ui/components/ui/button";
import { Badge } from "@varada/ui/components/ui/badge";
import { Card } from "@varada/ui/components/ui/card";
import { Check } from "@varada/ui/components/ui/icons";
import { CauseChip } from "@varada/ui/components/varada/cause-chip";
import { cn } from "@varada/ui/lib/utils";
import { CATEGORIES, REGIONS } from "@varada/sdk";
import { causeNameOfSlug } from "@/lib/causes-client";

export const categoryLabelOf = (slug: string) => CATEGORIES.find((c) => c.slug === slug)?.label ?? slug;
export const regionLabelOf = (slug: string) => REGIONS.find((r) => r.slug === slug)?.label ?? slug;

export interface OrgCardData {
  name: string;
  country: string | null;
  state?: string | null;
  ein?: string | null;
  nteeCode?: string | null;
  categories: readonly string[];
  regions: readonly string[];
}

const MAX_CHIPS = 3;

/** One nonprofit from the Varada catalogue: where it works, its causes and regions, and an optional action. */
export function OrgCard({
  org,
  onSelect,
  selectLabel = "Add",
  selected = false,
  selectedLabel = "Added",
  disabledReason,
  disabledReasonId,
}: {
  org: OrgCardData;
  onSelect?(): void;
  selectLabel?: string;
  /** Already chosen: the card takes the sage state and shows `selectedLabel` instead of the button. */
  selected?: boolean;
  selectedLabel?: string;
  /** Why the action is unavailable (a limit was reached); disables the button. `disabledReasonId` is the element that says it. */
  disabledReason?: string;
  disabledReasonId?: string;
}) {
  const place = [org.state, org.country].filter(Boolean).join(", ");
  const shown = org.categories.slice(0, MAX_CHIPS);
  const more = org.categories.length - shown.length;
  return (
    <Card
      data-slot="org-card"
      data-selected={selected || undefined}
      className={cn("flex h-full min-w-0 flex-col gap-3 p-4 transition-colors", selected && "border-sage bg-sage-tint")}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="m-0 font-display text-lg font-semibold leading-snug [overflow-wrap:anywhere]">{org.name}</h3>
        <p className="m-0 text-[13px] text-ink-muted">
          {[place, org.ein ? `EIN ${org.ein}` : null, org.nteeCode ? `NTEE ${org.nteeCode}` : null].filter(Boolean).join(" · ") || "Catalogue organization"}
        </p>
      </div>
      {org.categories.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Causes">
          {shown.map((slug) => (
            <li key={slug} className="max-w-full">
              <CauseChip cause={causeNameOfSlug(slug)} label={categoryLabelOf(slug)} size="sm" />
            </li>
          ))}
          {more > 0 && (
            <li>
              <Badge tone="outline" title={org.categories.slice(MAX_CHIPS).map(categoryLabelOf).join(", ")}>
                +{more} more
              </Badge>
            </li>
          )}
        </ul>
      )}
      {org.regions.length > 0 && (
        <p className="m-0 text-[13px] text-ink-soft">
          <span className="sr-only">Regions: </span>
          {org.regions.map(regionLabelOf).join(" · ")}
        </p>
      )}
      {onSelect && (
        <div className="mt-auto pt-1">
          {selected ? (
            <Badge tone="cause" shape="pill" className="bg-paper-card py-1.5 text-sm">
              <Check aria-hidden="true" />
              {selectedLabel}
            </Badge>
          ) : (
            <Button
              variant="outline"
              size="md"
              onClick={onSelect}
              disabled={disabledReason !== undefined}
              aria-describedby={disabledReason !== undefined ? disabledReasonId : undefined}
              aria-label={`${selectLabel} ${org.name}`}
            >
              {selectLabel}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
