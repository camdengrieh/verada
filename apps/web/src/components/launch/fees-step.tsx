"use client";

import { useId } from "react";
import { Field, FieldError, FieldHint, FieldLabel } from "@varada/ui/components/ui/field";
import { Slider } from "@varada/ui/components/ui/slider";
import { Switch } from "@varada/ui/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@varada/ui/components/ui/toggle-group";
import { FeeSplitBar } from "@varada/ui/components/varada/fee-split-bar";
import { DEFAULT_DONATION_THRESHOLD, MAX_FEE_BPS, MAX_SNIPER_START_BPS, MIN_FEE_BPS } from "@/lib/launch";
import { DONATION_ASSETS, type DonationAsset } from "@varada/sdk";
import { RadioCard, RadioGroup } from "@varada/ui/components/ui/radio-group";
import { donationAssetHint } from "@/lib/donation-asset";
import { formatDuration } from "@/lib/launch-format";
import type { StepProps } from "./types";

/** Decay choices for the launch surcharge, in seconds (the factory allows 1 second to 1 day). */
export const DECAY_CHOICES = [60, 300, 1800, 3600, 21_600, 86_400] as const;
/** What turning protection on starts with: a 30% surcharge fading over 5 minutes. */
export const DEFAULT_PROTECTION = { startBps: 3000, decaySeconds: 300 } as const;

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

export function FeesStep({ state, err, setInput, quoteDepthUsd }: StepProps & { quoteDepthUsd?: number | null }) {
  const id = useId();
  const base = Number(state.input.baseFeeBps) || MIN_FEE_BPS;
  const start = Number(state.input.sniperFeeStartBps) || 0;
  const decay = Number(state.input.sniperDecaySeconds) || 0;
  const protectedLaunch = start > 0;
  const asset: DonationAsset = state.input.donationAsset ?? "usdc";
  const hint = donationAssetHint(state.input.quoteAsset, { usdcDepthUsd: quoteDepthUsd });
  const pick = (a: DonationAsset) => {
    if (a === asset) return;
    // The live-donation threshold is written in this asset, so it restarts at that asset's default.
    setInput({ donationAsset: a, donationThreshold: DEFAULT_DONATION_THRESHOLD[a] });
  };

  return (
    <div className="flex flex-col gap-6">
      <Field invalid={!!err("baseFeeBps")}>
        <div className="flex items-baseline justify-between gap-3">
          <FieldLabel id={`${id}-base`}>Trading fee</FieldLabel>
          <output aria-live="polite" className="num text-2xl font-semibold text-ink">
            {pct(base)}
          </output>
        </div>
        <Slider
          aria-labelledby={`${id}-base`}
          tone="cause"
          min={MIN_FEE_BPS}
          max={MAX_FEE_BPS}
          step={25}
          value={[base]}
          formatValue={(v) => pct(v)}
          onValueChange={([v]) => setInput({ baseFeeBps: String(v) })}
        />
        <div aria-hidden="true" className="num flex justify-between text-xs text-ink-muted">
          <span>{pct(MIN_FEE_BPS)}</span>
          <span>{pct(MAX_FEE_BPS)}</span>
        </div>
        <FieldHint>Charged on every swap, from {pct(MIN_FEE_BPS)} to {pct(MAX_FEE_BPS)}. Higher fees raise more for causes and cost traders more.</FieldHint>
        <FieldError>{err("baseFeeBps")}</FieldError>
      </Field>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-ink">Where the fee goes</span>
        <FeeSplitBar causeLabel="to your coin's cause" platformLabel="to Varada" />
        <p className="m-0 text-sm text-ink-soft">The split is fixed: 90% of each fee funds the cause, 10% is Varada&rsquo;s. There is no other recipient.</p>
      </div>

      <Field invalid={!!err("donationAsset")}>
        <FieldLabel id={`${id}-asset`}>Donation asset</FieldLabel>
        <RadioGroup value={asset} onValueChange={(v) => pick(v as DonationAsset)} aria-labelledby={`${id}-asset`} className="grid gap-3 @lg:grid-cols-2">
          {DONATION_ASSETS.map((a) => (
            <RadioCard
              key={a}
              id={`${id}-asset-${a}`}
              value={a}
              tone="cause"
              title={a === "usdc" ? "USDC" : "ETH"}
              description={
                a === "usdc"
                  ? "Fees are converted to USDC and given as dollars. Best when your pair trades against stablecoins or has its deepest pool with USDC."
                  : "Fees are converted to ETH and given through Endaoment, which turns it into dollars for the charity. Best for WETH pairs and pairs with a deeper pool against ETH."
              }
            />
          ))}
        </RadioGroup>
        <FieldHint>
          {hint.suggest ? `${hint.suggest === "usdc" ? "USDC" : "ETH"} looks better for this pair. ` : ""}
          {hint.text} Fixed forever once the coin is launched.
        </FieldHint>
        <FieldError>{err("donationAsset")}</FieldError>
      </Field>

      <div className="flex flex-col gap-4 rounded-2xl border border-line bg-paper-card p-4 @lg:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={`${id}-protect`} className="text-sm font-semibold text-ink">
              Launch protection
            </label>
            <p id={`${id}-protect-hint`} className="m-0 text-sm text-ink-soft">
              An extra fee at the start that fades to the base fee, so bots that buy in the first seconds pay more.
            </p>
          </div>
          <Switch
            id={`${id}-protect`}
            aria-describedby={`${id}-protect-hint`}
            checked={protectedLaunch}
            onCheckedChange={(on) =>
              setInput(on ? { sniperFeeStartBps: String(DEFAULT_PROTECTION.startBps), sniperDecaySeconds: String(DEFAULT_PROTECTION.decaySeconds) } : { sniperFeeStartBps: "0", sniperDecaySeconds: "0" })
            }
          />
        </div>
        {protectedLaunch ? (
          <div className="flex flex-col gap-5">
            <Field invalid={!!err("sniperFeeStartBps")}>
              <div className="flex items-baseline justify-between gap-3">
                <FieldLabel id={`${id}-start`}>Starting surcharge</FieldLabel>
                <output aria-live="polite" className="num text-lg font-semibold text-ink">
                  {pct(start)}
                </output>
              </div>
              <Slider aria-labelledby={`${id}-start`} min={500} max={MAX_SNIPER_START_BPS} step={500} value={[Math.max(start, 500)]} formatValue={(v) => pct(v)} onValueChange={([v]) => setInput({ sniperFeeStartBps: String(v) })} />
              <FieldHint>Up to {pct(MAX_SNIPER_START_BPS)}. The first trade pays the base fee plus this.</FieldHint>
              <FieldError>{err("sniperFeeStartBps")}</FieldError>
            </Field>
            <Field invalid={!!err("sniperDecaySeconds")}>
              <FieldLabel id={`${id}-decay`}>Fades to the base fee over</FieldLabel>
              <ToggleGroup type="single" aria-labelledby={`${id}-decay`} value={String(decay)} onValueChange={(v) => setInput({ sniperDecaySeconds: v })} className="w-full flex-wrap">
                {DECAY_CHOICES.map((s) => (
                  <ToggleGroupItem key={s} value={String(s)}>
                    {formatDuration(s)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FieldError>{err("sniperDecaySeconds")}</FieldError>
            </Field>
          </div>
        ) : null}
      </div>
    </div>
  );
}
