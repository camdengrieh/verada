"use client";

import { isValidLabel } from "@varada/sdk";
import { Check, CircleAlert } from "@varada/ui/components/ui/icons";
import { Field, FieldControl, FieldError, FieldHint, FieldLabel } from "@varada/ui/components/ui/field";
import { Input, InputAddon, InputGroup } from "@varada/ui/components/ui/input";
import { Textarea } from "@varada/ui/components/ui/textarea";
import { useAppConfig } from "@/components/providers";
import type { LabelStatus } from "@/lib/chain-reads";
import { suggestLabel } from "@/lib/launch-steps";
import type { MetadataFields } from "@/lib/launch";
import { LogoField } from "./logo-field";
import type { StepProps } from "./types";

/** Live registry status of the chosen label, as one line under the field. */
export function LabelStatusLine({ name, label, status, loading, failed, account }: { name: string; label: string; status?: LabelStatus; loading: boolean; failed: boolean; account?: string }) {
  if (!isValidLabel(label)) return null;
  if (loading && !status) return <p className="m-0 text-sm text-ink-soft">Checking {name} in the registry</p>;
  if (status?.kind === "available")
    return (
      <p className="m-0 flex items-center gap-1.5 text-sm font-medium text-sage-ink">
        <Check aria-hidden="true" className="size-4" />
        {name} is available
      </p>
    );
  if (status?.kind === "reserved" && status.allowedCreator && account && status.allowedCreator.toLowerCase() === account.toLowerCase())
    return (
      <p className="m-0 flex items-center gap-1.5 text-sm font-medium text-sage-ink">
        <Check aria-hidden="true" className="size-4" />
        {name} is reserved for your wallet
      </p>
    );
  if (status && status.kind !== "unknown") return null; // taken and reserved are shown as the field error
  return (
    <p className="m-0 flex items-start gap-1.5 text-sm text-ink-soft">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        Availability unknown{status?.kind === "unknown" ? ` (${status.reason})` : failed ? " (the registry could not be read)" : ""}. The launch fails safely if {name} is taken.
      </span>
    </p>
  );
}

export function IdentityStep(props: StepProps & { labelLoading: boolean; labelFailed: boolean; onLogo: (ref: string | null) => void; onLogoBusy: (busy: boolean) => void; labelEdited: boolean; setLabelEdited: (v: boolean) => void }) {
  const { state, err, touch, patch, setInput, labelLoading, labelFailed, onLogo, onLogoBusy, labelEdited, setLabelEdited } = props;
  const config = useAppConfig();
  const { input, fields } = state;
  const label = input.label.trim();
  const ensName = `${label || "your-label"}.${config.ensParentName}`;
  const setField = (key: keyof MetadataFields) => (e: { target: { value: string } }) => patch({ fields: { ...fields, [key]: e.target.value } });

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 @lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Field invalid={!!err("name")} required>
          <FieldLabel>Name</FieldLabel>
          <FieldControl>
            <Input value={input.name} maxLength={64} autoComplete="off" placeholder="Harambe Relief Fund" onChange={(e) => setInput({ name: e.target.value })} onBlur={() => touch("name")} />
          </FieldControl>
          <FieldError>{err("name")}</FieldError>
        </Field>
        <Field invalid={!!err("symbol")} required>
          <FieldLabel>Ticker</FieldLabel>
          <FieldControl>
            <Input
              value={input.symbol}
              maxLength={16}
              autoComplete="off"
              autoCapitalize="characters"
              placeholder="HARAMBE"
              onChange={(e) => {
                const symbol = e.target.value.replace(/^\$/, "");
                setInput(labelEdited ? { symbol } : { symbol, label: suggestLabel(symbol) });
              }}
              onBlur={() => touch("symbol")}
            />
          </FieldControl>
          <FieldError>{err("symbol")}</FieldError>
        </Field>
      </div>

      <Field invalid={!!err("label")} required>
        <FieldLabel>ENS name</FieldLabel>
        <InputGroup>
          <FieldControl>
            <Input
              value={input.label}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="harambe"
              onChange={(e) => {
                setLabelEdited(true);
                setInput({ label: e.target.value.toLowerCase() });
              }}
              onBlur={() => touch("label")}
            />
          </FieldControl>
          <InputAddon>.{config.ensParentName}</InputAddon>
        </InputGroup>
        <FieldHint>Your coin&rsquo;s address and page: {ensName}. It follows the ticker until you edit it.</FieldHint>
        <FieldError>{err("label")}</FieldError>
        <div role="status" aria-live="polite">
          <LabelStatusLine name={ensName} label={label} status={state.labelStatus} loading={labelLoading} failed={labelFailed} account={state.account} />
        </div>
      </Field>

      <LogoField
        error={err("logo")}
        onUploading={onLogoBusy}
        onUploaded={(u) => {
          onLogo(u?.reference ?? null);
          touch("logo");
        }}
      />

      <Field>
        <FieldLabel>Description</FieldLabel>
        <FieldControl>
          <Textarea value={fields.description} maxLength={2000} rows={3} placeholder="What is this coin about, and who does it help?" onChange={setField("description")} />
        </FieldControl>
        <FieldHint>
          <span className="num">{fields.description.length}</span> of 2,000 characters. Shown on the coin&rsquo;s page.
        </FieldHint>
      </Field>

      <details className="rounded-xl border border-line bg-paper-card p-4 open:pb-5">
        <summary className="cursor-pointer text-sm font-semibold text-ink">Links (optional)</summary>
        <div className="mt-4 grid gap-4 @lg:grid-cols-2">
          {(
            [
              ["website", "Website", "https://", "url"],
              ["twitter", "X (Twitter) handle", "handle", "text"],
              ["telegram", "Telegram", "handle", "text"],
              ["discord", "Discord invite", "https://discord.gg/…", "text"],
            ] as const
          ).map(([key, label, placeholder, type]) => (
            <Field key={key} invalid={!!err(key)}>
              <FieldLabel>{label}</FieldLabel>
              <FieldControl>
                <Input type={type} value={fields[key]} placeholder={placeholder} autoComplete="off" onChange={setField(key)} onBlur={() => touch(key)} />
              </FieldControl>
              <FieldError>{err(key)}</FieldError>
            </Field>
          ))}
        </div>
      </details>

      <details className="rounded-xl border border-line bg-paper-card p-4 open:pb-5">
        <summary className="cursor-pointer text-sm font-semibold text-ink">Advanced</summary>
        <div className="mt-4">
          <Field>
            <FieldLabel>Metadata URI override</FieldLabel>
            <FieldControl>
              <Input value={input.metadataURI} placeholder="bzz://…" autoComplete="off" onChange={(e) => setInput({ metadataURI: e.target.value })} />
            </FieldControl>
            <FieldHint>Skips the metadata upload and uses this document as it is. Leave empty to have Varada build and store it for you.</FieldHint>
          </Field>
        </div>
      </details>
    </div>
  );
}
