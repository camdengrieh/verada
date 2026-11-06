"use client";

import { REGIONS } from "@varada/sdk";
import { Button } from "@varada/ui/components/ui/button";
import { CircleAlert, ShieldCheck } from "@varada/ui/components/ui/icons";
import { CauseChip } from "@varada/ui/components/varada/cause-chip";
import { ModeBadge, type LiveCadence } from "@varada/ui/components/varada/mode-badge";
import { QuoteAssetIdentity } from "@varada/ui/components/varada/quote-asset";
import { ConnectButton } from "@/components/connect-button";
import { useAppConfig } from "@/components/providers";
import { UsdEquiv } from "@/components/usd-equiv";
import { useUsdQuotes } from "@/hooks/use-usd-quotes";
import { usdNotes, type UsdQuote } from "@varada/sdk";
import { formatDuration, formatEth, formatGwei, formatQuoteAmount } from "@/lib/launch-format";
import { marketCapFromTick, priceFromTick, ROTATIONS, startTickFromMarketCap } from "@/lib/launch";
import { launchErrorHelp } from "@/lib/launch-errors";
import type { WizardState } from "@/lib/launch-steps";
import type { AppQuoteAsset } from "@/lib/quote-assets";
import { causeNameOf } from "./focus-step";

export type GasEstimate =
  | { status: "idle" } // no wallet yet, or the launch is incomplete
  | { status: "loading" }
  | { status: "ready"; gas: bigint; gasPrice: bigint | null }
  | { status: "error"; message: string };

function Row({ label, children, editStep, onEdit }: { label: string; children: React.ReactNode; editStep?: number; onEdit?(step: number): void }) {
  return (
    <div className="grid gap-1 border-b border-line py-3 last:border-b-0 @md:grid-cols-[10rem_minmax(0,1fr)_auto] @md:items-start @md:gap-4">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words text-[15px] font-medium text-ink">{children}</dd>
      {editStep !== undefined && onEdit ? (
        <Button size="sm" variant="soft" className="justify-self-start @md:justify-self-end" onClick={() => onEdit(editStep)} aria-label={`Edit ${label}`}>
          Edit
        </Button>
      ) : null}
    </div>
  );
}

/** Why a dollar figure is approximate, when it is. */
function UsdNotes({ usd }: { usd: UsdQuote }) {
  const notes = usdNotes(usd);
  return notes.length > 0 ? <span className="mt-1 block text-xs text-ink-muted">{notes.join(" ")}</span> : null;
}

export function ReviewStep({
  state,
  quote,
  causeName,
  gas,
  onEdit,
  parseError,
  txError,
  onRerollSalt,
}: {
  state: WizardState;
  quote: AppQuoteAsset | undefined;
  causeName?: string;
  gas: GasEstimate;
  onEdit(step: number): void;
  parseError?: string;
  txError?: string;
  onRerollSalt(): void;
}) {
  const config = useAppConfig();
  const { quoteFor } = useUsdQuotes([quote?.address]);
  const usd = quoteFor(quote?.address);
  const { input, fields } = state;
  const label = input.label.trim();
  const live = input.mode === "live";
  const rotation = ROTATIONS.find((r) => r.key === input.rotation);
  const tick = startTickFromMarketCap(Number(state.marketCap));
  const symbol = quote?.symbol ?? "quote";
  const base = Number(input.baseFeeBps);
  const start = Number(input.sniperFeeStartBps);
  const help = txError ? launchErrorHelp(txError) : null;

  return (
    <div className="flex flex-col gap-5">
      <dl className="m-0 rounded-2xl border border-line bg-paper-card px-4 @lg:px-5">
        <Row label="Coin" editStep={0} onEdit={onEdit}>
          {input.name} <span className="font-normal text-ink-soft">${input.symbol}</span>
        </Row>
        <Row label="ENS name" editStep={0} onEdit={onEdit}>
          {label}.{config.ensParentName}
        </Row>
        <Row label="Logo" editStep={0} onEdit={onEdit}>
          {state.logoRef ? <span className="break-all font-mono text-xs">bzz://{state.logoRef}</span> : "Set by the metadata URI override"}
        </Row>
        {fields.description ? (
          <Row label="Description" editStep={0} onEdit={onEdit}>
            <span className="line-clamp-3 font-normal">{fields.description}</span>
          </Row>
        ) : null}
        <Row label="Giving" editStep={1} onEdit={onEdit}>
          <span className="flex flex-wrap items-center gap-2">
            <ModeBadge giving={live ? { mode: "live", cadence: (input.rotation ?? "24h") as LiveCadence } : { mode: "weekly" }} long />
            {live ? <span className="font-normal text-ink-soft">{rotation?.label.toLowerCase()}</span> : null}
          </span>
          {live ? (
            <span className="mt-1 block text-sm font-normal text-ink-soft">
              First charity: {causeName ?? "chosen"}. Donates once credit reaches <span className="num">{input.donationThreshold}</span> USDC.
            </span>
          ) : null}
        </Row>
        <Row label="Pair" editStep={2} onEdit={onEdit}>
          {quote ? <QuoteAssetIdentity asset={quote} size={32} plain compactMeta /> : <span className="font-mono text-xs">{input.quoteAsset}</span>}
          {tick !== null ? (
            <span className="mt-1 block text-sm font-normal text-ink-soft">
              Starts at <span className="num">{formatQuoteAmount(marketCapFromTick(tick))}</span> {symbol} market cap
              {usd ? (
                <>
                  {" "}
                  (<UsdEquiv units={marketCapFromTick(tick)} usd={usd} />)
                </>
              ) : null}{" "}
              (<span className="num">{formatQuoteAmount(priceFromTick(tick))}</span> {symbol} per token, tick{" "}
              <span className="num">{tick.toLocaleString("en-US")}</span>)
              {usd ? <UsdNotes usd={usd} /> : null}
            </span>
          ) : null}
        </Row>
        <Row label="Cause focus" editStep={3} onEdit={onEdit}>
          <span className="flex flex-wrap gap-1.5">
            {input.categories.length === 0 ? <CauseChip cause="other" label="Any cause" size="sm" /> : input.categories.map((s) => <CauseChip key={s} cause={causeNameOf(s)} size="sm" />)}
          </span>
          <span className="mt-1 block text-sm font-normal text-ink-soft">
            {input.regions.length === 0 ? "Any region" : input.regions.map((s) => REGIONS.find((r) => r.slug === s)?.label ?? s).join(", ")}
            {typeof state.pool === "number" ? (
              <>
                {" "}
                · <span className="num">{state.pool.toLocaleString("en-US")}</span> eligible entries
              </>
            ) : null}
          </span>
        </Row>
        <Row label="Trading fee" editStep={4} onEdit={onEdit}>
          <span className="num">{(base / 100).toFixed(base % 100 === 0 ? 0 : 2)}%</span>
          <span className="ml-2 font-normal text-ink-soft">90% to the cause, 10% to Varada</span>
          {start > 0 ? (
            <span className="mt-1 block text-sm font-normal text-ink-soft">
              Launch protection: +<span className="num">{(start / 100).toFixed(0)}%</span> fading over {formatDuration(Number(input.sniperDecaySeconds))}
            </span>
          ) : (
            <span className="mt-1 block text-sm font-normal text-ink-soft">No launch protection</span>
          )}
        </Row>
      </dl>

      <div className="flex flex-col gap-2 rounded-2xl border border-line bg-paper-card p-4 @lg:p-5" aria-live="polite">
        <span className="text-sm font-semibold text-ink">Network cost</span>
        {gas.status === "idle" ? <p className="m-0 text-sm text-ink-soft">Connect your wallet to estimate the gas for this launch.</p> : null}
        {gas.status === "loading" ? <p className="m-0 text-sm text-ink-soft">Estimating gas</p> : null}
        {gas.status === "ready" ? (
          <p className="m-0 text-sm text-ink">
            About <strong className="num">{gas.gas.toLocaleString("en-US")}</strong> gas
            {gas.gasPrice !== null ? (
              <>
                {" "}
                at <span className="num">{formatGwei(gas.gasPrice)}</span>, roughly <strong className="num">{formatEth(gas.gas * gas.gasPrice)}</strong>
              </>
            ) : null}
            . Launching sends no ETH to the factory; you pay gas only.
          </p>
        ) : null}
        {gas.status === "error" ? (
          <p className="m-0 flex items-start gap-1.5 text-sm text-ink-soft">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>Could not estimate gas: {launchErrorHelp(gas.message).text} Your wallet will estimate it when you sign.</span>
          </p>
        ) : null}
        {!state.account ? (
          <div className="pt-1">
            <ConnectButton />
          </div>
        ) : null}
      </div>

      <p className="m-0 flex items-start gap-2 text-sm text-ink-soft">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-sage" />
        <span>The cause focus, giving mode, pair and fees are fixed forever once the coin is launched. Your wallet address is never sent to Varada&rsquo;s servers; the metadata document holds no address.</span>
      </p>

      {parseError ? (
        <p role="alert" className="m-0 text-sm font-medium text-destructive">
          {parseError}
        </p>
      ) : null}
      {help ? (
        <div role="alert" className="flex flex-col items-start gap-2 rounded-xl border border-destructive/40 bg-paper-card p-4 text-sm font-medium text-destructive">
          <span>{help.text}</span>
          {help.rerollSalt ? (
            <Button size="sm" variant="outline" onClick={onRerollSalt}>
              Use a new salt
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
