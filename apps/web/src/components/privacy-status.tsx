"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@varada/ui/components/ui/popover";
import { Button } from "@varada/ui/components/ui/button";
import { Switch } from "@varada/ui/components/ui/switch";
import { PrivacyPill, type PrivacyState } from "@varada/ui/components/varada/privacy-pill";
import { useEffect, useId, useSyncExternalStore } from "react";
import { useAccount } from "wagmi";
import { usePrivacyPrefs, usePrivateRpc } from "@/components/providers";

/**
 * Shows how this page reaches the chain, and lets the user choose what goes
 * through the anon network. The anon worker (Nym's is ~18 MB) starts on the first
 * chain read; once a wallet is connected, or Varada API routing is on, this panel
 * starts it straight away so the network bootstraps before it is needed.
 */
export function PrivacyStatus() {
  const rpc = usePrivateRpc();
  const [prefs, setPrefs] = usePrivacyPrefs();
  const { isConnected } = useAccount();
  const status = useSyncExternalStore(
    (l) => rpc.subscribe(l),
    () => rpc.getStatus(),
    () => rpc.getStatus(),
  );
  const direct = useSyncExternalStore(
    (l) => rpc.subscribe(l),
    () => rpc.directPublicAllowed,
    () => false,
  );

  useEffect(() => {
    if (isConnected || prefs.routeIndexer) void rpc.start().catch(() => {});
  }, [rpc, isConnected, prefs.routeIndexer]);

  const net = rpc.network.label;
  let text: string;
  switch (status.state) {
    case "ready":
      text = rpc.network.anonymizes ? `Private RPC on: chain reads go through ${net}` : `RPC through ${net}: NOT anonymized`;
      break;
    case "failed":
      text = `Private RPC unavailable (${status.message}). Account data will not load until it reconnects.`;
      break;
    case "connecting":
      text = `Connecting to ${net}…`;
      break;
    default:
      text = `Private RPC (${net}) starts on the first chain read`;
  }

  const switchId = useId();
  return (
    <aside aria-label="Privacy" className="grid gap-3 text-sm">
      <p role="status" className="text-ink">{text}</p>
      {status.state === "failed" && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void rpc.retry().catch(() => {})}>
            Retry
          </Button>
          {!direct && (
            <Button size="sm" variant="outline" onClick={() => rpc.allowDirectForPublic(true)}>
              Load public data directly (the RPC provider sees your IP; never used for account data)
            </Button>
          )}
        </div>
      )}
      {direct && (
        <p role="note" className="rounded-md bg-ochre-tint px-3 py-2 text-ochre-ink">
          Public data is loading directly for this visit. Account data still only loads privately.
        </p>
      )}
      <div className="flex items-start gap-3">
        <Switch
          id={switchId}
          checked={prefs.routeIndexer}
          onCheckedChange={(on) => setPrefs({ ...prefs, routeIndexer: on })}
          aria-label={`Also route Varada API requests through ${net}`}
        />
        <label htmlFor={switchId} className="text-ink-soft">
          Also route Varada API requests through {net} (slower; Varada never sees your IP)
        </label>
      </div>
    </aside>
  );
}

/** Header pill showing the private-RPC state; opens the full privacy controls. */
export function PrivacyMenu() {
  const rpc = usePrivateRpc();
  const status = useSyncExternalStore(
    (l) => rpc.subscribe(l),
    () => rpc.getStatus(),
    () => rpc.getStatus(),
  );
  const direct = useSyncExternalStore(
    (l) => rpc.subscribe(l),
    () => rpc.directPublicAllowed,
    () => false,
  );
  const state: PrivacyState =
    status.state === "failed"
      ? direct
        ? "direct"
        : "failed"
      : status.state === "ready"
        ? rpc.network.anonymizes
          ? "private"
          : "direct"
        : "connecting";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <PrivacyPill state={state} network={rpc.network.label} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))]">
        <PrivacyStatus />
      </PopoverContent>
    </Popover>
  );
}
