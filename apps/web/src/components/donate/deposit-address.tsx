"use client";

import { CopyButton } from "@varada/ui/components/data/copy-button";
import { ExternalLink } from "@varada/ui/components/ui/icons";
import { EnsAddress } from "@varada/ui/components/varada/ens-address";
import { cn } from "@varada/ui/lib/utils";
import { addressUrl } from "@/lib/org-donate";

/**
 * Where a gift lands: the ENS name and the address it resolves to, side by side, each with its own
 * copy button, plus the address on Etherscan. Used for curator vaults (`<cause>.agent.<parent>`)
 * and charities (`<label>.org.<parent>`); without a name only the address shows.
 */
export function DepositAddress({
  address,
  name,
  chainId,
  label = "Deposit address",
  className,
}: {
  address: string;
  name?: string | null;
  chainId: number;
  /** What the address is, for screen readers and the copy buttons. */
  label?: string;
  className?: string;
}) {
  const explorer = addressUrl(chainId, address);
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)} role="group" aria-label={label}>
      <EnsAddress address={address} name={name ?? undefined} copyValue="address" className="min-w-0" />
      {name && <CopyButton value={name} iconOnly size="icon-sm" variant="ghost" label={`Copy the name ${name}`} copiedLabel="Name copied" />}
      {explorer && (
        <a
          href={explorer}
          target="_blank"
          rel="noopener noreferrer"
          className="grid size-9 place-items-center rounded-full text-ink-soft outline-none hover:bg-sand focus-visible:ring-[3px] focus-visible:ring-ring/35"
        >
          <ExternalLink aria-hidden="true" className="size-4" />
          <span className="sr-only">{label} on Etherscan (opens in a new tab)</span>
        </a>
      )}
    </div>
  );
}
