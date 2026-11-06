// Adapted from 21st.dev @ln-dev7/header-17 (id 26888): top nav that collapses into a sheet, here on radix Dialog
"use client";

import { Menu, Search, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useId, useRef, useState, type ComponentProps, type FormEvent, type ReactNode, type Ref } from "react";
import { Divider } from "@verada/ui/components/ui/divider";
import { cn } from "@verada/ui/lib/utils";
import { LogoMark } from "./logo-mark";
import { DefaultLink, type LinkComponent } from "./shared";

export interface SiteNavLink {
  href: string;
  label: string;
}

export interface SiteHeaderProps extends Omit<ComponentProps<"header">, "children"> {
  links: readonly SiteNavLink[];
  /** href of the current page's link; it gets aria-current="page" and the ink pill. */
  activeHref?: string;
  homeHref?: string;
  LinkComponent?: LinkComponent;
  /** Search field. Omit to hide it. */
  search?: {
    value?: string;
    onChange?: (value: string) => void;
    onSubmit?: (value: string) => void;
    placeholder?: string;
    label?: string;
  };
  /** Status slot, normally a PrivacyPill. */
  privacy?: ReactNode;
  /** Wallet slot (connect button or account chip). */
  wallet?: ReactNode;
  /** Where the menu sheet portals to (default `document.body`), e.g. a phone frame in a gallery. */
  menuContainer?: HTMLElement | null;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/**
 * Direction A top navigation: mark and wordmark, pill nav links, a search field with a "/" shortcut,
 * the privacy pill and a wallet slot.
 *
 * It lays out for its own width (a size container), not the viewport's, so it also works inside a
 * narrow column. Tiers by header width: under 448px only the mark and the menu button; from 448px
 * the wallet; from 672px the search field; from 1024px the privacy pill; from 1280px the nav links,
 * and the menu button goes away. Everything hidden at a width is in the menu sheet, so the wallet
 * is never clipped.
 */
export function SiteHeader({
  links,
  activeHref,
  homeHref = "./",
  LinkComponent = DefaultLink,
  search,
  privacy,
  wallet,
  menuContainer,
  className,
  ...props
}: SiteHeaderProps) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    if (!search) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const el = inputRef.current;
      if (!el || el.offsetParent === null) return; // hidden on narrow screens
      e.preventDefault();
      el.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [search]);

  const navLink = (l: SiteNavLink, mobile: boolean) => {
    const active = l.href === activeHref;
    return (
      <LinkComponent
        key={l.href}
        href={l.href}
        aria-current={active ? "page" : undefined}
        onClick={mobile ? () => setOpen(false) : undefined}
        className={cn(
          "inline-flex min-h-11 items-center rounded-full px-3.5 text-[15px] text-ink no-underline transition-colors",
          active ? "bg-ink font-semibold text-paper" : "font-medium hover:bg-sand",
          mobile && "w-full px-4 text-base",
        )}
      >
        {l.label}
      </LinkComponent>
    );
  };

  const searchField = (mobile: boolean) =>
    search ? (
      <SearchField
        id={`${id}-${mobile ? "m" : "d"}`}
        inputRef={mobile ? undefined : inputRef}
        search={search}
        showHint={!mobile}
        onSubmitted={mobile ? () => setOpen(false) : undefined}
        className={mobile ? "w-full" : "hidden min-w-0 flex-[1_1_120px] @2xl:flex"}
      />
    ) : null;

  return (
    <header
      data-slot="site-header"
      className={cn("@container sticky top-0 z-40 border-b border-line bg-card/90 backdrop-blur", className)}
      {...props}
    >
      <div className="flex items-center gap-x-3 px-4 py-3.5 @md:gap-x-5 @2xl:px-10 @7xl:gap-x-7">
        <LinkComponent href={homeHref} aria-label="Varada home" className="inline-flex min-h-11 shrink-0 items-center gap-2.5 text-ink no-underline">
          <LogoMark size={34} decorative />
          <span className="font-display text-2xl font-extrabold tracking-tight @max-3xs:sr-only">Varada</span>
        </LinkComponent>
        <nav aria-label="Main" className="hidden shrink-0 @7xl:block">
          <ul className="m-0 flex list-none flex-nowrap gap-1 p-0">
            {links.map((l) => (
              <li key={l.href}>{navLink(l, false)}</li>
            ))}
          </ul>
        </nav>
        {searchField(false)}
        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2 @2xl:ml-0">
          {privacy ? <div className="hidden shrink-0 @5xl:block">{privacy}</div> : null}
          {wallet ? <div className="hidden shrink-0 @md:block">{wallet}</div> : null}
          <Dialog.Root open={open} onOpenChange={setOpen}>
            <Dialog.Trigger asChild>
              <button type="button" aria-label="Open menu" className="grid size-11 shrink-0 place-items-center rounded-full bg-ink text-paper hover:bg-ink-soft @7xl:hidden">
                <Menu aria-hidden="true" className="size-[18px]" />
              </button>
            </Dialog.Trigger>
            <Dialog.Portal container={menuContainer ?? undefined}>
              <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
              <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-[min(86vw,360px)] flex-col gap-5 overflow-y-auto bg-card p-5 text-card-foreground shadow-float data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right focus-visible:outline-none">
                <div className="flex items-center justify-between">
                  <Dialog.Title className="m-0 inline-flex items-center gap-2 font-display text-xl font-extrabold">
                    <LogoMark size={28} decorative />
                    Varada
                  </Dialog.Title>
                  <Dialog.Close asChild>
                    <button type="button" aria-label="Close menu" className="grid size-11 place-items-center rounded-full border border-line hover:bg-sand">
                      <X aria-hidden="true" className="size-5" />
                    </button>
                  </Dialog.Close>
                </div>
                <Dialog.Description className="sr-only">Site navigation and search</Dialog.Description>
                {searchField(true)}
                <nav aria-label="Main">
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {links.map((l) => (
                      <li key={l.href}>{navLink(l, true)}</li>
                    ))}
                  </ul>
                </nav>
                {privacy || wallet ? (
                  <div className="mt-auto flex flex-col items-start gap-3">
                    <Divider variant="dashed" className="mb-2" />
                    {privacy}
                    {wallet}
                  </div>
                ) : null}
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      </div>
    </header>
  );
}

function SearchField({
  id,
  search,
  inputRef,
  showHint,
  onSubmitted,
  className,
}: {
  id: string;
  search: NonNullable<SiteHeaderProps["search"]>;
  inputRef?: Ref<HTMLInputElement>;
  showHint: boolean;
  onSubmitted?: () => void;
  className?: string;
}) {
  const [inner, setInner] = useState("");
  const value = search.value ?? inner;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    search.onSubmit?.(value);
    onSubmitted?.();
  };
  return (
    <form role="search" onSubmit={submit} className={cn("flex min-h-11 items-center gap-2 rounded-full border border-line bg-paper-card px-3.5 focus-within:border-ink focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring", className)}>
      <Search aria-hidden="true" className="size-[18px] shrink-0 text-ink-muted" />
      <label htmlFor={id} className="sr-only">
        {search.label ?? "Search coins, causes or paste an address"}
      </label>
      <input
        ref={inputRef}
        id={id}
        type="search"
        value={value}
        onChange={(e) => {
          if (search.value === undefined) setInner(e.target.value);
          search.onChange?.(e.target.value);
        }}
        placeholder={search.placeholder ?? "Search coins, causes, label.varada.eth or 0x…"}
        aria-keyshortcuts={showHint ? "/" : undefined}
        className="min-h-10 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-muted focus-visible:outline-none"
      />
      {showHint ? (
        <kbd aria-hidden="true" className="num rounded-md border border-line px-1.5 py-0.5 text-xs text-ink-muted">
          /
        </kbd>
      ) : null}
    </form>
  );
}
