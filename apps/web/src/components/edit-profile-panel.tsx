"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useAccount } from "wagmi";
import { isAddress, zeroAddress, type Address } from "viem";
import { swarmReferenceToBytes32, TOKEN_TEXT_KEYS } from "@varada/sdk";
import { tokenProfileRegistryAbi } from "@varada/sdk/abis";
import { Button } from "@varada/ui/components/ui/button";
import { Card } from "@varada/ui/components/ui/card";
import { Field, FieldControl, FieldLabel } from "@varada/ui/components/ui/field";
import { Input } from "@varada/ui/components/ui/input";
import { LogoUploadField } from "@/components/logo-upload";
import { useAppConfig } from "@/components/providers";
import { sameAddress, TxStatus, useTx } from "@/components/use-tx";
import type { TokenProfile } from "@/lib/indexer";
import type { LogoUpload } from "@/lib/publisher";

const EDITABLE: { key: string; label: string }[] = [
  { key: TOKEN_TEXT_KEYS.description, label: "Description" },
  { key: TOKEN_TEXT_KEYS.url, label: "Website" },
  { key: TOKEN_TEXT_KEYS.twitter, label: "Twitter" },
  { key: TOKEN_TEXT_KEYS.telegram, label: "Telegram" },
  { key: TOKEN_TEXT_KEYS.discord, label: "Discord" },
  { key: TOKEN_TEXT_KEYS.github, label: "GitHub" },
  { key: TOKEN_TEXT_KEYS.avatar, label: "Avatar (URL)" },
];

/** Profile editing for the controller or editor. Each change is one registry transaction. */
export function EditProfilePanel({ token, profile }: { token: Address; profile: TokenProfile | null }) {
  const config = useAppConfig();
  const { address: account } = useAccount();
  const tx = useTx();
  const [texts, setTexts] = useState<Record<string, string>>(profile?.textRecords ?? {});
  const [logo, setLogo] = useState<LogoUpload | null>(null);
  const [editor, setEditor] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => setTexts(profile?.textRecords ?? {}), [profile]);

  const isController = sameAddress(account, profile?.controller);
  const isEditor = sameAddress(account, profile?.editor);
  if (!profile || !account || !(isController || isEditor)) return null;
  const registry = config.profileRegistryAddress;

  function send(functionName: "setText" | "setLogoRef" | "setEditor", args: readonly unknown[]) {
    setError(undefined);
    if (!registry) return setError("profileRegistryAddress is not configured (config.json)");
    tx.reset();
    void tx
      .send({ address: registry, abi: tokenProfileRegistryAbi, functionName, args: args as never, chainId: config.chainId })
      .catch(() => {});
  }

  function onEditor(e: FormEvent) {
    e.preventDefault();
    const v = editor.trim();
    if (v !== "" && !isAddress(v)) return setError("Editor must be an address (empty removes the editor)");
    send("setEditor", [token, v === "" ? zeroAddress : v]);
  }

  return (
    <section aria-label="Edit profile" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 font-display text-2xl font-semibold">Edit profile</h2>
        <p className="m-0 text-sm text-ink-soft">You are this token&apos;s profile {isController ? "controller" : "editor"}. Each save is a separate transaction.</p>
      </div>
      <Card className="gap-5 p-5">
        {EDITABLE.map(({ key, label }) => (
          <form
            key={key}
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              send("setText", [token, key, (texts[key] ?? "").trim()]);
            }}
          >
            <Field className="flex-1">
              <FieldLabel>
                {label} ({key})
              </FieldLabel>
              <FieldControl>
                <Input value={texts[key] ?? ""} onChange={(e) => setTexts((t) => ({ ...t, [key]: e.target.value }))} />
              </FieldControl>
            </Field>
            <Button type="submit" variant="outline" disabled={tx.isPending}>
              Save {label}
            </Button>
          </form>
        ))}

        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <LogoUploadField onUploaded={setLogo} label="New logo" />
          <Button type="button" variant="outline" className="self-start" disabled={!logo || tx.isPending} onClick={() => logo && send("setLogoRef", [token, swarmReferenceToBytes32(logo.reference)])}>
            Set logo
          </Button>
        </div>

        {isController && (
          <form onSubmit={onEditor} className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-end">
            <Field className="flex-1">
              <FieldLabel>Editor address (empty to remove)</FieldLabel>
              <FieldControl>
                <Input value={editor} onChange={(e) => setEditor(e.target.value)} placeholder={profile.editor ?? ""} className="num" />
              </FieldControl>
            </Field>
            <Button type="submit" variant="outline" disabled={tx.isPending}>
              Set editor
            </Button>
          </form>
        )}
        {error && <p role="alert" className="m-0 text-sm font-medium text-destructive">{error}</p>}
        <TxStatus tx={tx} label="Profile update" />
      </Card>
    </section>
  );
}
