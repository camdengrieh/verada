// Adapted from 21st.dev @efferd/header-with-search (id 8127): logo, a search button that opens the
// search modal, and the actions on the right, cut down to the A-Mobile board's phone header (mark,
// wordmark, round search button) with Varada's privacy dot and wallet slot.
"use client";

import { Search } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";
import { LogoMark } from "@verada/ui/components/varada/logo-mark";
import type { PrivacyState } from "@verada/ui/components/varada/privacy-pill";
import { DefaultLink, type LinkComponent } from "@verada/ui/components/varada/shared";
import { cn } from "@verada/ui/lib/utils";
import { MobileSearchSheet, type MobileSearchSheetProps } from "./mobile-search-sheet";

const PRIVACY: Record<PrivacyState, { label: string; dot: string }> = {
  connecting: { label: "Connecting privately through the Nym mixnet", dot: "bg-ochre motion-safe:animate-pulse" },
  private: { label: "Private RPC on: reads go through the Nym mixnet", dot: "bg-sage" },
  failed: { label: "Private RPC failed: the mixnet route is down, retrying", dot: "bg-terracotta" },
  direct: { label: "Not anonymised: reads go to a public RPC that can see your IP", dot: "bg-ochre-ink" },
};

export interface MobileHeaderProps extends Omit<ComponentProps<"header">, "children" | "title"> {
  homeHref?: string;
  LinkComponent?: LinkComponent;
  /**
   * The search sheet the round button opens, minus open state (the header owns it unless
   * `searchOpen` / `onSearchOpenChange` are passed). Omit to hide the button.
   */
  search?: Omit<MobileSearchSheetProps, "open" | "onOpenChange">;
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
  /** Read-path status, shown as a coloured dot (with a spoken label). */
  privacy?: PrivacyState;
  /** Makes the dot a 48px button (e.g. to open privacy details). */
  onPrivacyClick?: () => void;
  /** Wallet slot (a compact connect button or account chip). */
  wallet?: ReactNode;
  /** Replaces the wordmark, e.g. a page title on inner screens. */
  title?: ReactNode;
}

/**
 * The phone header from the A-Mobile board: mark and wordmark, a 48px round search button that opens
 * the full-screen search sheet, the privacy dot and the wallet. A size container: under 288px the
 * wordmark hides (the home link keeps its name). Sticky at the top by default.
 */
export function MobileHeader({
  homeHref = "./",
  LinkComponent = DefaultLink,
  search,
  searchOpen,
  onSearchOpenChange,
  privacy,
  onPrivacyClick,
  wallet,
  title,
  className,
  ...props
}: MobileHeaderProps) {
  const [innerOpen, setInnerOpen] = useState(false);
  const open = searchOpen ?? innerOpen;
  const setOpen = (o: boolean) => {
    if (searchOpen === undefined) setInnerOpen(o);
    onSearchOpenChange?.(o);
  };
  const p = privacy ? PRIVACY[privacy] : null;

  return (
    <header data-slot="mobile-header" className={cn("@container sticky top-0 z-30 border-b border-line bg-paper-card/95 backdrop-blur", className)} {...props}>
      <div className="flex items-center gap-2 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <LinkComponent href={homeHref} aria-label="Varada home" className="inline-flex min-h-12 min-w-0 items-center gap-2 text-ink no-underline">
          <LogoMark size={30} decorative />
          {title ? null : <span className="font-display text-[22px] font-extrabold tracking-tight @max-2xs:sr-only">Varada</span>}
        </LinkComponent>
        {title ? <div className="min-w-0 flex-1 truncate font-display text-lg font-semibold">{title}</div> : null}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {search ? (
            <button
              type="button"
              aria-label="Search"
              aria-haspopup="dialog"
              aria-expanded={open}
              onClick={() => setOpen(true)}
              className="grid size-12 place-items-center rounded-full border border-line bg-paper-card text-ink hover:bg-sand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <Search aria-hidden="true" className="size-[18px]" />
            </button>
          ) : null}
          {p ? (
            onPrivacyClick ? (
              <button
                type="button"
                data-slot="privacy-dot"
                data-state={privacy}
                aria-label={p.label}
                onClick={onPrivacyClick}
                className="grid size-12 place-items-center rounded-full hover:bg-sand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span aria-hidden="true" className={cn("size-3 rounded-full ring-4 ring-paper", p.dot)} />
              </button>
            ) : (
              <span role="img" data-slot="privacy-dot" data-state={privacy} aria-label={p.label} title={p.label} className="grid size-8 place-items-center">
                <span className={cn("size-3 rounded-full ring-4 ring-paper", p.dot)} />
              </span>
            )
          ) : null}
          {wallet}
        </div>
      </div>
      {search ? <MobileSearchSheet {...search} LinkComponent={search.LinkComponent ?? LinkComponent} open={open} onOpenChange={setOpen} /> : null}
    </header>
  );
}
