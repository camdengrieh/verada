// Adapted from 21st.dev @efferd/header-with-search (id 8127): its search modal (a drawer on phones,
// grouped results with a title, description and category, an empty state with "Clear search")
// becomes a full-screen radix Dialog sheet with the field and Cancel at the top, recent searches and
// suggestion chips before typing, and arrow-key movement from the field into the results.
"use client";

import { ArrowUpLeft, Clock, Search, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Divider } from "@verada/ui/components/ui/divider";
import { DefaultLink, type LinkComponent } from "@verada/ui/components/varada/shared";
import { cn } from "@verada/ui/lib/utils";

export interface MobileSearchResult {
  id: string;
  title: string;
  subtitle?: string;
  /** Heading the result is listed under ("Coins", "Causes", "Addresses"). */
  group?: string;
  /** A link… */
  href?: string;
  /** …or a callback. The sheet closes after either. */
  onSelect?: () => void;
  /** Art or logo before the text (decorative). */
  media?: ReactNode;
  /** After the text, e.g. a price change. */
  trailing?: ReactNode;
}

export interface MobileSearchSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The query (controlled) … */
  value?: string;
  /** … or its starting value. */
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Enter / the keyboard's search key. */
  onSubmit?: (value: string) => void;
  placeholder?: string;
  label?: string;
  /** Results for the current query; the app does the searching. */
  results?: readonly MobileSearchResult[];
  /** Shown while the app searches. */
  loading?: boolean;
  /** Chips offered before typing ("$HARAMBE", "wildlife"); a tap fills the query. */
  suggestions?: readonly string[];
  suggestionsLabel?: string;
  /** Recent queries, newest first; a tap fills the query. */
  recent?: readonly string[];
  onClearRecent?: () => void;
  /** Text when a query has no results. */
  emptyText?: (query: string) => ReactNode;
  LinkComponent?: LinkComponent;
  /** Where the sheet portals to (default `document.body`), e.g. a phone frame. */
  container?: HTMLElement | null;
  /** Replaces the default body (recent, suggestions, results). */
  children?: ReactNode;
}

function groupResults(results: readonly MobileSearchResult[]) {
  const groups = new Map<string, MobileSearchResult[]>();
  for (const r of results) {
    const key = r.group ?? "";
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()];
}

const NAV_KEYS = ["ArrowDown", "ArrowUp", "Home", "End"];

/**
 * Full-screen search for phones, opened from the mobile header's search button. The field takes
 * focus when it opens; Cancel, Escape or picking a result closes it. Before typing it lists recent
 * searches and suggestion chips; after, results grouped under headings, with a live count. Arrow
 * Down moves from the field into the results, arrows move between them, Home and End jump.
 */
export function MobileSearchSheet({
  open,
  onOpenChange,
  value,
  defaultValue = "",
  onValueChange,
  onSubmit,
  placeholder = "Coins, causes, label.varada.eth or 0x…",
  label = "Search coins, causes or paste an address",
  results,
  loading,
  suggestions,
  suggestionsLabel = "Try",
  recent,
  onClearRecent,
  emptyText = (q) => <>Nothing matches &ldquo;{q}&rdquo;. Try a ticker, a cause or a full address.</>,
  LinkComponent = DefaultLink,
  container,
  children,
}: MobileSearchSheetProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [inner, setInner] = useState(defaultValue);
  const query = value ?? inner;
  const trimmed = query.trim();

  const set = (v: string) => {
    if (value === undefined) setInner(v);
    onValueChange?.(v);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit?.(query);
  };
  const close = () => onOpenChange(false);

  // Buttons carry data-search-item; the app's link component can't take data attributes, so links
  // carry a marker span and the anchor around it is the item.
  const items = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-search-item], [data-search-anchor]") ?? []).map((el) =>
      el.hasAttribute("data-search-anchor") ? (el.closest<HTMLElement>("a, [href]") ?? el) : el,
    );
  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "ArrowDown") return;
    const first = items()[0];
    if (!first) return;
    e.preventDefault();
    first.focus();
  };
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!NAV_KEYS.includes(e.key)) return;
    const all = items();
    const i = all.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    if (e.key === "ArrowUp" && i === 0) {
      inputRef.current?.focus();
      return;
    }
    const next = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : Math.min(all.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)));
    all[next]?.focus();
  };

  const itemClass =
    "flex min-h-14 w-full items-center gap-3 rounded-2xl px-3 py-2 text-left text-ink no-underline transition-colors hover:bg-sand focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring";

  const result = (r: MobileSearchResult) => {
    const content = (
      <>
        {r.media ? <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl bg-paper">{r.media}</span> : null}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] font-semibold">{r.title}</span>
          {r.subtitle ? <span className="truncate text-[13px] text-ink-muted">{r.subtitle}</span> : null}
        </span>
        {r.trailing ? <span className="shrink-0 text-[13px]">{r.trailing}</span> : null}
      </>
    );
    return (
      <li key={r.id}>
        {r.href ? (
          <LinkComponent
            href={r.href}
            className={itemClass}
            onClick={() => {
              r.onSelect?.();
              close();
            }}
          >
            <span data-search-anchor="" className="contents">
              {content}
            </span>
          </LinkComponent>
        ) : (
          <button
            type="button"
            data-search-item=""
            className={itemClass}
            onClick={() => {
              r.onSelect?.();
              close();
            }}
          >
            {content}
          </button>
        )}
      </li>
    );
  };

  const chip = (q: string, i: number, icon?: ReactNode) => (
    <button
      key={`${q}-${i}`}
      type="button"
      data-search-item=""
      onClick={() => {
        set(q);
        inputRef.current?.focus();
      }}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line-strong bg-paper-card px-3.5 text-sm font-semibold text-ink hover:bg-sand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {icon}
      {q}
    </button>
  );

  const body = children ?? (
    <>
      {!trimmed ? (
        <div className="flex flex-col gap-5">
          {recent?.length ? (
            <section aria-labelledby={`${id}-recent`} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <h2 id={`${id}-recent`} className="kicker m-0 font-sans">
                  Recent
                </h2>
                {onClearRecent ? (
                  <button type="button" onClick={onClearRecent} className="min-h-11 rounded-full px-3 text-[13px] font-semibold text-primary hover:bg-sand">
                    Clear
                  </button>
                ) : null}
              </div>
              <ul className="m-0 flex list-none flex-col p-0">
                {recent.map((q, i) => (
                  <li key={`${q}-${i}`}>
                    <button
                      type="button"
                      data-search-item=""
                      onClick={() => {
                        set(q);
                        inputRef.current?.focus();
                      }}
                      className={itemClass}
                    >
                      <Clock aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
                      <span className="min-w-0 flex-1 truncate text-[15px]">{q}</span>
                      <ArrowUpLeft aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
                      <span className="sr-only">, search again</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {recent?.length && suggestions?.length ? <Divider variant="dashed" /> : null}
          {suggestions?.length ? (
            <section aria-labelledby={`${id}-try`} className="flex flex-col gap-2">
              <h2 id={`${id}-try`} className="kicker m-0 font-sans">
                {suggestionsLabel}
              </h2>
              <div className="flex flex-wrap gap-2">{suggestions.map((q, i) => chip(q, i))}</div>
            </section>
          ) : null}
        </div>
      ) : loading ? (
        <p className="m-0 px-1 py-6 text-center text-sm text-ink-soft">Searching…</p>
      ) : results && results.length ? (
        <div className="flex flex-col gap-4">
          {groupResults(results).map(([group, rs]) => (
            <section key={group || "results"} aria-label={group || "Results"} className="flex flex-col gap-1">
              {group ? <h2 className="kicker m-0 px-1 font-sans">{group}</h2> : null}
              <ul className="m-0 flex list-none flex-col p-0">{rs.map(result)}</ul>
            </section>
          ))}
        </div>
      ) : results ? (
        <p className="m-0 px-1 py-6 text-center text-sm text-ink-soft">{emptyText(trimmed)}</p>
      ) : null}
    </>
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={container ?? undefined}>
        <Dialog.Content
          data-slot="mobile-search-sheet"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          className="@container fixed inset-0 z-50 flex flex-col bg-paper text-ink outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-8 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-bottom-8"
        >
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <Dialog.Description className="sr-only">Search coins, causes and addresses. Results update as you type.</Dialog.Description>
          <div className="flex items-center gap-2 border-b border-line bg-paper-card px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <form role="search" onSubmit={submit} className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-full border-[1.5px] border-line-strong bg-paper px-3.5 focus-within:border-ink focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
              <Search aria-hidden="true" className="size-[18px] shrink-0 text-ink-muted" />
              <label htmlFor={`${id}-q`} className="sr-only">
                {label}
              </label>
              <input
                ref={inputRef}
                id={`${id}-q`}
                type="search"
                enterKeyHint="search"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={query}
                onChange={(e) => set(e.target.value)}
                onKeyDown={onInputKey}
                placeholder={placeholder}
                className="min-h-11 min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-muted focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
              />
              {query ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => {
                    set("");
                    inputRef.current?.focus();
                  }}
                  className="-mr-2 grid size-11 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-sand hover:text-ink"
                >
                  <X aria-hidden="true" className="size-4" />
                </button>
              ) : null}
            </form>
            <Dialog.Close className="min-h-12 shrink-0 rounded-full px-3 text-[15px] font-semibold text-ink hover:bg-sand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              Cancel
            </Dialog.Close>
          </div>
          <div ref={listRef} onKeyDown={onListKey} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
            {body}
          </div>
          <span role="status" className="sr-only">
            {trimmed && results && !loading ? `${results.length} ${results.length === 1 ? "result" : "results"}` : ""}
          </span>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
