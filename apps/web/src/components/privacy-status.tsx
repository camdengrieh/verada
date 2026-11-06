"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@varada/ui/components/ui/popover";
import { Badge } from "@varada/ui/components/ui/badge";
import { Button } from "@varada/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@varada/ui/components/ui/dialog";
import { Settings2, ShieldCheck } from "@varada/ui/components/ui/icons";
import { Switch } from "@varada/ui/components/ui/switch";
import { PrivacyPill, type PrivacyState } from "@varada/ui/components/varada/privacy-pill";
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react";
import { useAccount } from "wagmi";
import { ConnectionSettingsDialog } from "@/components/connection-settings";
import { usePrivacyPrefs, usePrivateRpc } from "@/components/providers";
import { PRIVACY_ROUTES, PRIVACY_SUMMARY, type RouteKind } from "@/lib/privacy-routes";

/** Dispatch to open the full privacy dialog from anywhere (the header menu listens). */
export const PRIVACY_DETAILS_EVENT = "varada:privacy-details";

export function openPrivacyDetails() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PRIVACY_DETAILS_EVENT));
}

/** Live state of the private read path, as the header pill and the ballot footer show it. */
export function usePrivacyState(): { state: PrivacyState; network: string; direct: boolean } {
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
  if (status.state === "direct") return { state: "direct", network: "your RPC", direct: true };
  const state: PrivacyState =
    status.state === "failed" ? (direct ? "direct" : "failed") : status.state === "ready" ? (rpc.network.anonymizes ? "private" : "direct") : "connecting";
  return { state, network: rpc.network.label, direct };
}

/**
 * Shows how this page reaches the chain, and lets the user choose what goes
 * through the anon network. The anon worker (a mixnet client of several MB) starts on the first
 * chain read; once a wallet is connected, or Varada API routing is on, this panel
 * starts it straight away so the network bootstraps before it is needed.
 */
export function PrivacyStatus({ onDetails, onSettings }: { onDetails?: () => void; onSettings?: () => void }) {
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
    if (!rpc.directMode && (isConnected || prefs.routeIndexer)) void rpc.start().catch(() => {});
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
    case "direct":
      text = "Direct to your RPC: chain reads, account data included, go straight to your own endpoint. Not private.";
      break;
    case "connecting":
      text = `Connecting to ${net}…`;
      break;
    default:
      text = `Private RPC (${net}) starts on the first chain read`;
  }

  const switchId = useId();
  return (
    <aside aria-label="Privacy" className="grid grid-cols-1 gap-3 text-sm">
      <p role="status" className="m-0 text-ink">{text}</p>
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
      {status.state === "failed" && (
        <p className="m-0 text-ink-soft">
          If it stays down, add your own RPC in Connection settings to keep going.
        </p>
      )}
      {direct && !rpc.directMode && (
        <p role="note" className="m-0 rounded-md bg-ochre-tint px-3 py-2 text-ochre-ink">
          Public data is loading directly for this visit. Account data still only loads privately.
        </p>
      )}
      {!rpc.directMode && (
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
      )}
      {(onDetails || onSettings) && (
        <div className="flex flex-wrap gap-2">
          {onDetails && (
            <Button size="sm" variant="soft" onClick={onDetails}>
              <ShieldCheck aria-hidden="true" />
              What goes where
            </Button>
          )}
          {onSettings && (
            <Button size="sm" variant="soft" onClick={onSettings}>
              <Settings2 aria-hidden="true" />
              Connection settings
            </Button>
          )}
        </div>
      )}
    </aside>
  );
}

const KIND_BADGE: Record<RouteKind, { label: string; tone: "cause" | "rwa" | "neutral" | "live" }> = {
  mixnet: { label: "Through the mixnet", tone: "cause" },
  direct: { label: "Direct", tone: "rwa" },
  wallet: { label: "Your wallet", tone: "neutral" },
  chain: { label: "On chain", tone: "neutral" },
};

/** The full account of what leaves the browser, where it goes, and who can see it (docs/PRIVACY.md). */
export function PrivacyDetails({ network }: { network: string }) {
  return (
    <div className="grid grid-cols-1 gap-4 text-sm">
      <p className="m-0 text-ink-soft">{PRIVACY_SUMMARY.replace("{network}", network)}</p>
      <ul aria-label="Where each request goes" className="m-0 grid grid-cols-1 list-none gap-3 p-0">
        {PRIVACY_ROUTES.map((r) => {
          const badge = KIND_BADGE[r.kind];
          return (
            <li key={r.id} className="grid grid-cols-1 gap-1 rounded-2xl border border-line bg-card p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-[15px] text-ink">{r.what}</strong>
                <Badge tone={badge.tone} shape="pill">
                  {r.kind === "mixnet" ? `Through ${network}` : badge.label}
                </Badge>
              </div>
              <p className="m-0 text-ink-soft">{r.sees}</p>
              {r.note && <p className="m-0 text-xs text-ink-muted">{r.note}</p>}
            </li>
          );
        })}
      </ul>
      <p className="m-0 text-xs text-ink-muted">
        Votes, launches and donations are public on chain whatever route you use: the voter and weight are visible, and only the choice on a ballot is encrypted.
        Varada has no analytics and loads no third-party fonts or scripts.
      </p>
    </div>
  );
}

/** Header pill showing the private-RPC state; opens the full privacy controls. */
export function PrivacyMenu() {
  const { state, network } = usePrivacyState();
  const privateRpc = usePrivateRpc();
  const anonymizes = privateRpc.network.anonymizes;
  const rpcDirect = privateRpc.directMode;
  const [prefs, setPrefs] = usePrivacyPrefs();
  const [details, setDetails] = useState(false);
  const [settings, setSettings] = useState(false);
  const [menu, setMenu] = useState(false);
  const [intro, setIntro] = useState(false);

  // Offered once per browser, after the page has mounted so the static export never renders it.
  useEffect(() => {
    if (!prefs.introSeen) setIntro(true);
  }, [prefs.introSeen]);

  useEffect(() => {
    const open = () => setDetails(true);
    window.addEventListener(PRIVACY_DETAILS_EVENT, open);
    return () => window.removeEventListener(PRIVACY_DETAILS_EVENT, open);
  }, []);

  const dismissIntro = useCallback(
    (open: boolean) => {
      setIntro(open);
      if (!open && !prefs.introSeen) setPrefs({ ...prefs, introSeen: true });
    },
    [prefs, setPrefs],
  );

  return (
    <>
      <Popover open={menu} onOpenChange={setMenu}>
        <PopoverTrigger asChild>
          <PrivacyPill state={state} network={network} label={rpcDirect ? "Direct to your RPC" : undefined} />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))]">
          <PrivacyStatus
            onDetails={() => setDetails(true)}
            onSettings={() => {
              setMenu(false);
              setSettings(true);
            }}
          />
        </PopoverContent>
      </Popover>

      <ConnectionSettingsDialog open={settings} onOpenChange={setSettings} />

      <Dialog open={details} onOpenChange={setDetails}>
        <DialogContent size="lg" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>How Varada protects what you look at</DialogTitle>
            <DialogDescription className="sr-only">Which requests go through the {network} mixnet, which go direct, and who can see them.</DialogDescription>
          </DialogHeader>
          <PrivacyDetails network={network} />
          <DialogFooter>
            <PrivacyPill state={state} network={network} />
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={intro} onOpenChange={dismissIntro}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Private by default</DialogTitle>
            <DialogDescription>Varada reads the chain for you without telling anyone who is asking.</DialogDescription>
          </DialogHeader>
          <ul className="m-0 grid grid-cols-1 list-none gap-3 p-0 text-[15px] text-ink-soft">
            <li>
              <strong className="text-ink">{anonymizes ? `Reads go through ${network}.` : `Reads use ${network}, which does not hide your IP.`}</strong>{" "}
              {anonymizes
                ? "The RPC provider sees an exit node, not your IP, and your wallet's lookups never reach Varada."
                : "Your wallet's lookups still never reach Varada."}
            </li>
            <li>
              <strong className="text-ink">Your vote stays secret.</strong> The choice is encrypted in your browser. Only the totals are ever decrypted, after voting ends.
            </li>
            <li>
              <strong className="text-ink">A few things go direct.</strong> Encrypting a ballot asks Zama&apos;s relayer for a proof, and your wallet sends transactions through its own RPC.
            </li>
          </ul>
          <DialogFooter>
            <Button
              variant="soft"
              onClick={() => {
                dismissIntro(false);
                setDetails(true);
              }}
            >
              See what goes where
            </Button>
            <Button variant="cause" onClick={() => dismissIntro(false)}>
              Got it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
