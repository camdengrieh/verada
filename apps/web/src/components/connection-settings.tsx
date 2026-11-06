"use client";

import { Badge } from "@varada/ui/components/ui/badge";
import { Button } from "@varada/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@varada/ui/components/ui/dialog";
import { Field, FieldControl, FieldError, FieldHint, FieldLabel } from "@varada/ui/components/ui/field";
import { Label } from "@varada/ui/components/ui/label";
import { RadioCard, RadioGroup } from "@varada/ui/components/ui/radio-group";
import { Separator } from "@varada/ui/components/ui/separator";
import { Switch } from "@varada/ui/components/ui/switch";
import { Textarea } from "@varada/ui/components/ui/textarea";
import { useId, useState, type FormEvent } from "react";
import { useAppConfig, usePrivacyPrefs } from "@/components/providers";
import { ANON_NETWORK_IDS, ANON_NETWORKS, isAnonNetworkId } from "@/lib/anon-networks";
import { MAX_USER_RPC_URLS, parseRpcUrlList, type PrivacyPrefs } from "@/lib/privacy-prefs";

const DEFAULT_NETWORK = "default";

/** Connection settings without the user's own settings: the build's defaults. */
function withoutConnection(p: PrivacyPrefs): PrivacyPrefs {
  return { routeIndexer: p.routeIndexer, introSeen: p.introSeen };
}

/**
 * How this browser reaches the chain: the anon network, the user's own RPC endpoints, and direct
 * mode. Saved in this browser only; a change applies at once (the private RPC is rebuilt).
 */
export function ConnectionSettings() {
  const config = useAppConfig();
  const [prefs, setPrefs] = usePrivacyPrefs();
  const saved = prefs.rpcUrls ?? [];
  const [draft, setDraft] = useState(() => saved.join("\n"));
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const ids = { network: useId(), card: useId(), direct: useId(), directHint: useId() };

  const build = ANON_NETWORKS[config.privateRpc.network];
  const direct = prefs.directMode === true && saved.length > 0;

  function onSave(e: FormEvent) {
    e.preventDefault();
    const { urls, errors: problems } = parseRpcUrlList(draft);
    setErrors(problems);
    if (problems.length > 0) return setNotice("");
    const next: PrivacyPrefs = { ...prefs, rpcUrls: urls };
    if (urls.length === 0) {
      delete next.rpcUrls;
      delete next.directMode;
    }
    setPrefs(next);
    setDraft(urls.join("\n"));
    setNotice(urls.length === 0 ? "No endpoints saved." : `Saved ${urls.length} endpoint${urls.length === 1 ? "" : "s"}.`);
  }

  function onRemoveAll() {
    const next = { ...prefs };
    delete next.rpcUrls;
    delete next.directMode;
    setPrefs(next);
    setDraft("");
    setErrors([]);
    setNotice("Endpoints removed.");
  }

  function onReset() {
    setPrefs(withoutConnection(prefs));
    setDraft("");
    setErrors([]);
    setNotice("Connection settings reset to the defaults.");
  }

  return (
    <div className="grid grid-cols-1 gap-5 text-sm">
      <section aria-labelledby={ids.network} className="grid grid-cols-1 gap-3">
        <h3 id={ids.network} className="m-0 text-[15px] font-semibold text-ink">
          Network
        </h3>
        <RadioGroup
          aria-labelledby={ids.network}
          value={prefs.network ?? DEFAULT_NETWORK}
          onValueChange={(v) => {
            const next = { ...prefs };
            if (isAnonNetworkId(v)) next.network = v;
            else delete next.network;
            setPrefs(next);
          }}
          className="gap-2"
        >
          <RadioCard
            value={DEFAULT_NETWORK}
            id={`${ids.card}-default`}
            title="Default"
            description={`${build.label}, run by ${build.operator}`}
            className="p-3"
          />
          {ANON_NETWORK_IDS.map((id) => {
            const n = ANON_NETWORKS[id];
            return (
              <RadioCard
                key={id}
                value={id}
                id={`${ids.card}-${id}`}
                title={
                  <span className="inline-flex flex-wrap items-center gap-2">
                    {n.label}
                    {!n.anonymizes && <Badge tone="rwa">Does not hide your IP</Badge>}
                  </span>
                }
                description={`Run by ${n.operator}`}
                className="p-3"
              />
            );
          })}
        </RadioGroup>
        {direct && <p className="m-0 text-ink-muted">Not used while Direct to my RPC is on.</p>}
      </section>

      <Separator />

      <form onSubmit={onSave} className="grid grid-cols-1 gap-3" aria-label="Your RPC endpoints">
        <Field invalid={errors.length > 0}>
          <FieldLabel>Your RPC endpoints</FieldLabel>
          <FieldControl>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="https://your-node.example"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              className="num text-sm"
            />
          </FieldControl>
          <FieldHint>
            One URL per line, up to {MAX_USER_RPC_URLS}. The private network tries these first; direct mode uses only these.
          </FieldHint>
          <FieldError>{errors.join(" ")}</FieldError>
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm">
            Save endpoints
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onRemoveAll} disabled={saved.length === 0 && draft.trim() === ""}>
            Remove all
          </Button>
        </div>
      </form>

      <Separator />

      <section aria-label="Direct to my RPC" className="grid grid-cols-1 gap-3">
        <div className="flex items-start gap-3">
          <Switch
            id={ids.direct}
            checked={direct}
            disabled={saved.length === 0}
            aria-describedby={ids.directHint}
            onCheckedChange={(on) => {
              const next = { ...prefs };
              if (on) next.directMode = true;
              else delete next.directMode;
              setPrefs(next);
            }}
          />
          <div className="grid grid-cols-1 gap-1">
            <Label htmlFor={ids.direct}>Direct to my RPC</Label>
            <p id={ids.directHint} className="m-0 text-ink-soft">
              {saved.length === 0
                ? "Save an endpoint first. Every read, account data included, then goes straight to it."
                : "Every read, account data included, goes straight to your endpoints. No private network."}
            </p>
          </div>
        </div>
        {direct && (
          <p role="note" className="m-0 rounded-md bg-ochre-tint px-3 py-2 text-ochre-ink">
            Not private: your RPC provider sees your IP address and every address you look up. Use this when the private network is
            unavailable.
          </p>
        )}
      </section>

      <p role="status" className="m-0 min-h-5 text-ink-soft">
        {notice}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-xs text-ink-muted">Saved in this browser only. Nothing is sent to Varada.</p>
        <Button type="button" size="sm" variant="ghost" onClick={onReset}>
          Reset to defaults
        </Button>
      </div>
    </div>
  );
}

export function ConnectionSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Connection settings</DialogTitle>
          <DialogDescription>Keep Varada working if the default network or public RPCs go down.</DialogDescription>
        </DialogHeader>
        <ConnectionSettings />
        <DialogFooter>
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
