"use client";

import { useEffect } from "react";
import { Button, buttonVariants } from "@varada/ui/components/ui/button";
import { CopyButton } from "@varada/ui/components/data/copy-button";
import { ExternalLink, Sparkles } from "@varada/ui/components/ui/icons";
import { useConfetti } from "@varada/ui/components/motion/confetti";
import { ModeBadge, type LiveCadence } from "@varada/ui/components/varada/mode-badge";
import { cn } from "@varada/ui/lib/utils";
import { siteBase } from "@/lib/base";
import { useAppConfig } from "@/components/providers";
import { ensGatewayUrl } from "@/lib/host";
import { shareLinks } from "@/lib/launch-tx";

/** Shown once the launch transaction confirms and the factory's `TokenCreated` log names the token. */
export function LaunchSuccess({
  name,
  symbol,
  label,
  token,
  txHash,
  live,
  rotation,
  donationAsset = "usdc",
  onAgain,
}: {
  name: string;
  symbol: string;
  label: string;
  token: string | null;
  txHash?: string;
  live: boolean;
  rotation?: string;
  donationAsset?: "usdc" | "eth";
  onAgain(): void;
}) {
  const config = useAppConfig();
  const { fire } = useConfetti({ preset: "launch" });
  useEffect(() => {
    fire({ x: 0.5, y: 0.35, unit: "fraction" });
  }, [fire]);

  const ens = `${label}.${config.ensParentName}`;
  const pageUrl = ensGatewayUrl(label, config.ensParentName);
  const share = shareLinks({ name, symbol, pageUrl });
  const tokenHref = token ? `${siteBase()}token/?address=${token}` : null;
  const link = "gap-2";

  return (
    <section aria-labelledby="launch-done" className="flex flex-col gap-6 rounded-[28px] border border-line bg-paper-card p-6 @lg:p-8">
      <div className="flex flex-col gap-3">
        <span className="inline-flex w-fit items-center gap-2 rounded-full bg-sage-tint px-3 py-1 text-sm font-semibold text-sage-ink">
          <Sparkles aria-hidden="true" className="size-4" />
          Launched
        </span>
        <h2 id="launch-done" tabIndex={-1} className="m-0 font-display text-3xl font-semibold leading-tight @lg:text-4xl">
          {name} is live
        </h2>
        <p className="m-0 flex flex-wrap items-center gap-2 text-[15px] text-ink-soft">
          <span>
            ${symbol} · {ens}
          </span>
          <ModeBadge giving={live ? { mode: "live", cadence: (rotation ?? "24h") as LiveCadence } : { mode: "weekly" }} long />
          <span className="text-ink-soft">Donations paid in {donationAsset === "eth" ? "ETH" : "USDC"}</span>
        </p>
        {!token ? <p className="m-0 text-sm text-ink-soft">The transaction confirmed, but the token address could not be read from the receipt. Find the coin on the home page.</p> : null}
      </div>

      <div className="flex flex-wrap gap-3">
        {tokenHref ? (
          <a href={tokenHref} className={cn(buttonVariants({ size: "lg" }), link)}>
            Open the token page
          </a>
        ) : null}
        <a href={pageUrl} target="_blank" rel="noreferrer noopener" className={cn(buttonVariants({ size: "lg", variant: "outline" }), link)}>
          {ens}
          <ExternalLink aria-hidden="true" />
        </a>
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-5">
        <span className="text-sm font-semibold text-ink">Share it</span>
        <div className="flex flex-wrap gap-2">
          <CopyButton value={pageUrl} label="Copy link" variant="outline" />
          <a href={share.x} target="_blank" rel="noreferrer noopener" className={cn(buttonVariants({ variant: "outline" }), link)}>
            Share on X
            <ExternalLink aria-hidden="true" />
          </a>
          <a href={share.telegram} target="_blank" rel="noreferrer noopener" className={cn(buttonVariants({ variant: "outline" }), link)}>
            Share on Telegram
            <ExternalLink aria-hidden="true" />
          </a>
        </div>
        {token ? (
          <p className="m-0 break-all text-sm text-ink-muted">
            Token address <code className="font-mono text-xs">{token}</code>
            {txHash ? (
              <>
                {" "}
                · transaction <code className="font-mono text-xs">{txHash}</code>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
      <Button variant="soft" className="w-fit" onClick={onAgain}>
        Launch another coin
      </Button>
    </section>
  );
}
