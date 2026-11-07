"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { Address, Hex } from "viem";
import { MAX_BALLOT_OPTIONS } from "@varada/sdk";
import { epochGovernorAbi } from "@varada/sdk/abis";
import { Button } from "@varada/ui/components/ui/button";
import { Card } from "@varada/ui/components/ui/card";
import { Info } from "@varada/ui/components/ui/icons";
import { Progress } from "@varada/ui/components/ui/progress";
import { CauseIcon } from "@varada/ui/components/varada/cause-icon";
import { CatalogBrowser } from "@/components/catalog-browser";
import { useAppConfig, useDeps } from "@/components/providers";
import { sameAddress, TxStatus, useTx } from "@/components/use-tx";
import type { CatalogOrg, TokenDetail } from "@/lib/indexer";
import { causeNameOfOrg } from "@/lib/token-data";
import { addPin, entryInFocus, maxPins, type PinDraft } from "@/lib/profile";

/**
 * The controller's pinned causes: up to PINNED_MAX catalogue orgs inside the token's focus (fewer
 * when the token's ballot is smaller) that lead every ballot from the next epoch. The rest of each
 * ballot is drawn from the focus pool.
 */
export function ShortlistEditor({ token, detail }: { token: Address; detail: TokenDetail }) {
  const config = useAppConfig();
  const deps = useDeps();
  const { address: account } = useAccount();
  const tx = useTx();
  const [draft, setDraft] = useState<PinDraft[]>([]);
  const [error, setError] = useState<string>();
  const focus = detail.focus;
  const max = maxPins(detail.ballotSize?.size);
  const ballot = detail.ballotSize?.size ?? MAX_BALLOT_OPTIONS;

  // Rebuild the draft from the pins on chain: each needs its in-focus entry and proof to be saved again.
  // Keyed on the pins' and focus' content: a refetch hands back new but equal objects, and rebuilding on
  // those would throw away pins the controller has added and not saved yet.
  const pinsKey = (detail.shortlist ?? []).join(",");
  const focusKey = focus ? `${focus.categoryMask}:${focus.regionMask}` : "";
  useEffect(() => {
    let cancelled = false;
    const pins = pinsKey ? pinsKey.split(",") : [];
    const [categoryMask, regionMask] = focusKey.split(":");
    if (!focusKey || pins.length === 0) {
      setDraft([]);
      return;
    }
    void (async () => {
      const out: PinDraft[] = [];
      for (const causeId of pins) {
        const found = await deps.indexer.catalogOrg(causeId).catch(() => null);
        const entry = found && entryInFocus(found.entries, BigInt(categoryMask!), Number(regionMask));
        if (found && entry) out.push(toDraft(found.org, entry));
      }
      if (!cancelled) setDraft(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [pinsKey, focusKey, deps.indexer]);

  if (!sameAddress(account, detail.profile?.controller)) return null;
  const governor = config.governorAddress;

  async function add(org: CatalogOrg) {
    setError(undefined);
    if (!focus) return setError("The token's cause focus is not known yet");
    const found = await deps.indexer.catalogOrg(org.orgId).catch(() => null);
    const entry = found && entryInFocus(found.entries, BigInt(focus.categoryMask), focus.regionMask);
    if (!found || !entry) return setError(`${org.name} is outside this token's focus`);
    const next = addPin(draft, toDraft(found.org, entry), max);
    if (typeof next === "string") return setError(next);
    setDraft(next);
  }

  function save(list: PinDraft[]) {
    setError(undefined);
    if (!governor) return setError("governorAddress is not configured (config.json)");
    if (list.length > max) return setError(`This token's ballot holds ${max} options: unpin ${list.length - max} first`);
    tx.reset();
    const pins = list.map((p) => ({ orgId: p.orgId, bucket: p.bucket, index: p.index, proof: p.proof }));
    void tx.send({ address: governor, abi: epochGovernorAbi, functionName: "setShortlist", args: [token, pins], chainId: config.chainId }).catch(() => {});
  }

  return (
    <section aria-label="Pinned causes" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 font-display text-2xl font-semibold">Pinned causes</h2>
        <p className="m-0 text-sm text-ink-soft">
          Up to {max} causes from this token&apos;s focus that lead every ballot. The other options are drawn in rotation from the
          whole focus pool, so every charity in it gets its turn. Changes take effect from the next epoch once the current ballot is
          prepared.
        </p>
      </div>
      <Card className="p-4 @container sm:p-5">
        <Progress
          label="Pinned"
          value={Math.min(draft.length, max)}
          max={max}
          showValue
          valueText={`${draft.length} of ${max}`}
          tone="cause"
          size="sm"
        />
        <p className="m-0 text-sm text-ink-muted">
          Each ballot holds {ballot} option{ballot === 1 ? "" : "s"} (at most {MAX_BALLOT_OPTIONS}); pinned causes take the first places and the
          rest rotate in from the focus pool.
        </p>
        {draft.length > max && (
          <p role="note" className="m-0 flex items-start gap-2 rounded-xl bg-ochre-tint px-3.5 py-2.5 text-sm font-medium text-ochre-ink">
            <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              This token&apos;s ballot now holds {max} options, so only the first {max} pinned causes make it onto the ballot.
            </span>
          </p>
        )}
        {draft.length === 0 ? (
          <p className="m-0 text-sm text-ink-soft">No causes pinned: every option is drawn from the focus pool.</p>
        ) : (
          <ol className="m-0 grid list-none gap-2 p-0">
            {draft.map((p) => (
              <li key={p.causeId} className="flex min-w-0 items-center gap-3 rounded-2xl border border-line bg-paper-card px-3 py-2">
                <CauseIcon cause={causeNameOfOrg({ categories: p.categories ?? [] })} size={32} decorative />
                <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{p.name}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Unpin ${p.name}`}
                  onClick={() => setDraft((d) => d.filter((x) => x.causeId !== p.causeId))}
                >
                  Unpin
                </Button>
              </li>
            ))}
          </ol>
        )}
        {focus ? (
          <CatalogBrowser
            onSelect={(o) => void add(o)}
            selectLabel="Pin"
            selectedLabel="Pinned"
            selectedIds={draft.map((p) => p.causeId)}
            full={draft.length >= max ? `All ${max} pin slots are used. Unpin a cause to pin another.` : undefined}
            within={{ categories: focus.categories, regions: focus.regions }}
          />
        ) : (
          <p role="note" className="m-0 text-sm text-ink-soft">The token&apos;s cause focus is not indexed yet.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="cause" disabled={tx.isPending} onClick={() => save(draft)}>
            Save pinned causes
          </Button>
          <Button type="button" variant="outline" disabled={tx.isPending || draft.length === 0} onClick={() => save([])}>
            Unpin all
          </Button>
        </div>
        {error && <p role="alert" className="m-0 text-sm font-medium text-destructive">{error}</p>}
        <TxStatus tx={tx} label="Pinned causes update" />
      </Card>
    </section>
  );
}

function toDraft(org: CatalogOrg, entry: { bucket: number; index: number; proof: string[] }): PinDraft {
  return {
    causeId: org.causeId as Hex,
    orgId: org.orgId as Hex,
    bucket: entry.bucket,
    index: entry.index,
    proof: entry.proof as Hex[],
    name: org.name,
    categories: org.categories,
  };
}
