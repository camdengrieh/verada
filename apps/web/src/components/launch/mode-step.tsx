"use client";

import { useId, useMemo, useState } from "react";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { Button } from "@varada/ui/components/ui/button";
import { Field, FieldControl, FieldError, FieldHint, FieldLabel } from "@varada/ui/components/ui/field";
import { Input, InputAddon, InputGroup } from "@varada/ui/components/ui/input";
import { RadioCard, RadioGroup } from "@varada/ui/components/ui/radio-group";
import { Heart } from "@varada/ui/components/ui/icons";
import { ToggleGroup, ToggleGroupItem } from "@varada/ui/components/ui/toggle-group";
import { ModeBadge, type LiveCadence } from "@varada/ui/components/varada/mode-badge";
import { DEFAULT_DONATION_THRESHOLD, DONATION_THRESHOLD_PRESETS, ROTATIONS, rotationOf, type GivingModeKey } from "@/lib/launch";
import type { StepProps } from "./types";

export interface ActiveCause {
  causeId: string;
  name: string;
}


export function ModeStep({
  state,
  err,
  touch,
  setInput,
  causes,
  causesLoading,
  causesFailed,
  liveReady,
  epochLength,
}: StepProps & { causes: ActiveCause[] | undefined; causesLoading: boolean; causesFailed: boolean; liveReady: boolean | undefined; epochLength?: string }) {
  const id = useId();
  const mode: GivingModeKey = state.input.mode ?? "weekly";
  const rotation = state.input.rotation ?? "24h";
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (causes ?? []).filter((c) => !q || c.name.toLowerCase().includes(q)).slice(0, 50);
  }, [causes, filter]);
  const cadence = rotation as LiveCadence;
  const asset = state.input.donationAsset ?? "usdc";
  const sym = asset === "eth" ? "ETH" : "USDC";

  return (
    <div className="flex flex-col gap-5">
      <RadioGroup value={mode} onValueChange={(v) => setInput({ mode: v as GivingModeKey })} aria-label="Giving mode" className="grid gap-3 @lg:grid-cols-2">
        <RadioCard
          id={`${id}-weekly`}
          value="weekly"
          tone="cause"
          title={
            <span className="flex flex-wrap items-center gap-2">
              Epoch pool
            </span>
          }
          description={`Fees pool for each epoch${epochLength ? ` (currently ${epochLength})` : ""}. Holders then vote with hidden ballots, in the last part of the epoch, on which charity from your focus receives the pool.`}
        />
        <RadioCard
          id={`${id}-live`}
          value="live"
          title={
            <span className="flex flex-wrap items-center gap-2">
              Live donation <ModeBadge giving={{ mode: "live", cadence }} />
            </span>
          }
          description="Each swap's cause share is converted to your donation asset (USDC or ETH, chosen on the Fees step) and donated as trading happens. Holders rotate the charity by private vote on the schedule you pick."
        />
      </RadioGroup>
      {err("mode") ? (
        <p role="alert" className="m-0 text-sm font-medium text-destructive">
          {err("mode")}
        </p>
      ) : null}
      {mode === "live" && liveReady === undefined ? <p className="m-0 text-sm text-ink-soft">Live donation availability could not be confirmed from the chain; the launch will fail safely if it is not enabled.</p> : null}

      {mode === "live" ? (
        <div className="flex flex-col gap-6 rounded-2xl border border-line bg-paper-card p-4 @lg:p-5">
          <Field>
            <FieldLabel id={`${id}-rot`}>Rotation</FieldLabel>
            <ToggleGroup type="single" aria-labelledby={`${id}-rot`} value={rotation} onValueChange={(v) => v && setInput({ rotation: v })} className="w-full flex-wrap">
              {ROTATIONS.map((r) => (
                <ToggleGroupItem key={r.key} value={r.key} aria-label={r.label}>
                  {r.key === "week" ? "Weekly" : r.key}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldHint>Holders can vote to move to the next charity {rotationOf(rotation)?.label.toLowerCase() ?? ""}. A later holder vote can change the period.</FieldHint>
          </Field>

          <Field invalid={!!err("donationThreshold")}>
            <FieldLabel>Donation threshold</FieldLabel>
            <InputGroup>
              <FieldControl>
                <Input
                  inputMode="decimal"
                  className="num"
                  value={state.input.donationThreshold ?? DEFAULT_DONATION_THRESHOLD[asset]}
                  onChange={(e) => setInput({ donationThreshold: e.target.value })}
                  onBlur={() => touch("donationThreshold")}
                />
              </FieldControl>
              <InputAddon>{sym}</InputAddon>
            </InputGroup>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Threshold presets">
              {DONATION_THRESHOLD_PRESETS[asset].map((p) => (
                <Button key={p} size="sm" variant={state.input.donationThreshold === p ? "primary" : "outline"} onClick={() => setInput({ donationThreshold: p })}>
                  <span className="num">{p}</span> {sym}
                </Button>
              ))}
            </div>
            <FieldHint>
              A swap pushes the donation once the charity&rsquo;s credit reaches this amount. A threshold of zero would donate on every swap and add about 105,000 to 150,000 gas to each, so
              it is not offered. Swaps of a live coin need a gas limit of roughly 860,000.
            </FieldHint>
            <FieldError>{err("donationThreshold")}</FieldError>
          </Field>

          <Field invalid={!!err("initialCause")}>
            <FieldLabel id={`${id}-cause`}>First charity</FieldLabel>
            <FieldHint>The charity that receives fees in the first rotation. Holders choose later ones. Only charities already active in the cause registry can start a live coin.</FieldHint>
            {causesLoading ? <p className="m-0 text-sm text-ink-soft">Loading active charities</p> : null}
            {causesFailed ? <p role="alert" className="m-0 text-sm font-medium text-destructive">Could not load the cause registry from the indexer. Try again in a moment.</p> : null}
            {causes && causes.length === 0 ? (
              <EmptyState size="compact" icon={<Heart />} title="No active charities yet" body="A charity becomes active after it wins an epoch vote. Until one has, launch with the epoch pool." />
            ) : null}
            {causes && causes.length > 0 ? (
              <>
                {causes.length > 8 ? <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name" aria-label="Filter charities" /> : null}
                <RadioGroup value={state.input.initialCause ?? ""} onValueChange={(v) => setInput({ initialCause: v })} aria-labelledby={`${id}-cause`} className="max-h-64 gap-2 overflow-y-auto pr-1">
                  {shown.map((c) => (
                    <RadioCard key={c.causeId} id={`${id}-c-${c.causeId.slice(2, 10)}`} value={c.causeId} tone="cause" title={c.name} className="p-3" />
                  ))}
                </RadioGroup>
                {shown.length === 0 ? <p className="m-0 text-sm text-ink-soft">No charity matches that name.</p> : null}
              </>
            ) : null}
            <FieldError>{err("initialCause")}</FieldError>
          </Field>
        </div>
      ) : null}
    </div>
  );
}
