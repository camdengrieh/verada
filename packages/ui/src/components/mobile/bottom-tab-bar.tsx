// Adapted from 21st.dev @arunachalam/bottom-nav-bar (id 8343): icon tabs with a sliding active pill
// (motion layoutId). Its six equal tabs become Varada's four plus a raised centre Launch button
// (from the C-Mobile board); labels stay visible, the bar respects the home-indicator inset and can
// hide while scrolling down.
"use client";

import { ChartLine, CircleUserRound, Compass, Plus, Vote, type LucideIcon } from "lucide-react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState, type ComponentProps, type ComponentType } from "react";
import { DefaultLink, type LinkComponent } from "@verada/ui/components/varada/shared";
import { cn } from "@verada/ui/lib/utils";

export interface BottomTab {
  href: string;
  label: string;
  icon: LucideIcon | ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  /** Small count or dot on the icon ("3", or "" for a dot), e.g. open ballots. Also read out. */
  badge?: string | number;
  /** Spoken text for the badge ("3 open ballots"); defaults to the badge value. */
  badgeLabel?: string;
}

export interface BottomTabBarLaunch {
  /** A link to the launch flow… */
  href?: string;
  /** …or a callback (e.g. open the launch sheet). */
  onClick?: () => void;
  /** Accessible name and the caption under the button (default "Launch"). */
  label?: string;
  /** Marks the launch button as the current page. */
  active?: boolean;
}

export interface BottomTabBarProps extends Omit<ComponentProps<"nav">, "children"> {
  /** Usually Discover, Trade, Vote and Me. The first half sits left of the Launch button. */
  tabs: readonly BottomTab[];
  /** href of the current tab; it gets aria-current="page" and the ink pill. */
  activeHref?: string;
  /** The raised centre button. Omit for a plain bar. */
  launch?: BottomTabBarLaunch;
  LinkComponent?: LinkComponent;
  /** Slide the bar away while scrolling down and back on scroll up (always shown while focused). */
  hideOnScroll?: boolean;
  /** What scrolls, for `hideOnScroll` (default the window). */
  scrollContainer?: HTMLElement | null;
  /**
   * `fixed` (default) pins it to the bottom of the viewport, or of the nearest container with
   * layout containment (a phone frame); `sticky` sticks at the bottom of a scrolling parent;
   * `static` leaves it in flow.
   */
  position?: "fixed" | "sticky" | "static";
}

/** Height of the bar without the safe-area inset, for padding content above it. */
export const BOTTOM_TAB_BAR_HEIGHT = 72;

export type VaradaTab = "discover" | "trade" | "vote" | "me";

/** The icons for Varada's four tabs (lucide ships with this package, not the app). */
export const TAB_ICONS: Record<VaradaTab, LucideIcon> = { discover: Compass, trade: ChartLine, vote: Vote, me: CircleUserRound };
const TAB_LABELS: Record<VaradaTab, string> = { discover: "Discover", trade: "Trade", vote: "Vote", me: "Me" };

/**
 * Discover, Trade, Vote and Me with their icons and labels, from the app's hrefs. `extra` adds or
 * overrides per tab, e.g. `{ vote: { badge: 2, badgeLabel: "2 open ballots" } }`.
 */
export function varadaTabs(hrefs: Record<VaradaTab, string>, extra: Partial<Record<VaradaTab, Partial<BottomTab>>> = {}): BottomTab[] {
  return (["discover", "trade", "vote", "me"] as const).map((t) => ({ href: hrefs[t], label: TAB_LABELS[t], icon: TAB_ICONS[t], ...extra[t] }));
}

/**
 * Hidden while the user scrolls down past `offset`, shown again on any scroll up of `threshold` px
 * or more. Returns false when disabled.
 */
export function useHideOnScroll({ enabled = true, target, threshold = 8, offset = 64 }: { enabled?: boolean; target?: HTMLElement | null; threshold?: number; offset?: number } = {}) {
  const [hidden, setHidden] = useState(false);
  const last = useRef(0);
  useEffect(() => {
    if (!enabled) {
      setHidden(false);
      return;
    }
    const el: HTMLElement | Window | null = target ?? (typeof window !== "undefined" ? window : null);
    if (!el) return;
    const read = () => (el instanceof Window ? el.scrollY : el.scrollTop);
    last.current = read();
    const onScroll = () => {
      const y = read();
      const delta = y - last.current;
      if (Math.abs(delta) < threshold) return;
      setHidden(delta > 0 && y > offset);
      last.current = y;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [enabled, target, threshold, offset]);
  return enabled && hidden;
}

/**
 * The phone navigation bar: four tabs and a raised Launch button in the middle. Tabs are links with
 * 56px targets; the current one carries aria-current="page" and an ink pill behind its icon that
 * slides between tabs (no slide with reduced motion). With `hideOnScroll` it tucks away on scroll
 * down and returns on scroll up or when anything in it takes focus.
 */
export function BottomTabBar({
  tabs,
  activeHref,
  launch,
  LinkComponent = DefaultLink,
  hideOnScroll = false,
  scrollContainer,
  position = "fixed",
  className,
  "aria-label": ariaLabel = "Main",
  ...props
}: BottomTabBarProps) {
  const reduced = useReducedMotion();
  const group = useId();
  const hidden = useHideOnScroll({ enabled: hideOnScroll, target: scrollContainer });
  const split = Math.ceil(tabs.length / 2);
  const left = launch ? tabs.slice(0, split) : tabs;
  const right = launch ? tabs.slice(split) : [];
  const columns = tabs.length + (launch ? 1 : 0);

  const tab = (t: BottomTab) => {
    const active = t.href === activeHref;
    const Icon = t.icon;
    const hasBadge = t.badge !== undefined;
    return (
      <li key={t.href} className="flex min-w-0">
        <LinkComponent
          href={t.href}
          aria-current={active ? "page" : undefined}
          className={cn(
            "group flex min-h-14 w-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-[11px] leading-tight no-underline transition-colors",
            "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
            active ? "font-semibold text-ink" : "font-medium text-ink-muted hover:text-ink",
          )}
        >
          <span className="relative grid h-8 w-14 place-items-center">
            {active ? (
              <motion.span
                aria-hidden="true"
                layoutId={reduced ? undefined : `${group}-pill`}
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
                className="absolute inset-0 rounded-full bg-ink"
              />
            ) : null}
            <Icon aria-hidden="true" className={cn("relative size-[22px]", active && "text-paper")} />
            {hasBadge ? (
              <span
                aria-hidden="true"
                className={cn(
                  "num absolute -top-1 right-2 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground ring-2 ring-paper-card",
                  t.badge === "" && "size-2.5 min-w-0 px-0",
                )}
              >
                {t.badge}
              </span>
            ) : null}
          </span>
          <span className="max-w-full truncate">
            {t.label}
            {hasBadge ? <span className="sr-only">, {t.badgeLabel ?? (t.badge === "" ? "new" : t.badge)}</span> : null}
          </span>
        </LinkComponent>
      </li>
    );
  };

  const launchLabel = launch?.label ?? "Launch";
  const launchClass = cn(
    "relative -mt-7 grid size-[60px] place-items-center rounded-[20px] bg-primary text-primary-foreground shadow-float ring-4 ring-paper-card transition-[background-color,transform] hover:bg-terracotta-strong active:translate-y-px",
    "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring",
  );
  const launchInner = (
    <>
      <Plus aria-hidden="true" className="size-7" strokeWidth={2.4} />
      <span className="sr-only">{launchLabel}</span>
    </>
  );

  return (
    <nav
      aria-label={ariaLabel}
      data-slot="bottom-tab-bar"
      data-hidden={hidden ? "true" : undefined}
      className={cn(
        "z-40 border-t border-line bg-paper-card/95 backdrop-blur transition-transform duration-300 ease-out",
        "pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5",
        position === "fixed" && "fixed inset-x-0 bottom-0",
        position === "sticky" && "sticky bottom-0",
        // The raised Launch button stands 28px above the bar, so slide that much further.
        hidden && (launch ? "translate-y-[calc(100%+2.5rem)] focus-within:translate-y-0" : "translate-y-full focus-within:translate-y-0"),
        className,
      )}
      {...props}
    >
      <LayoutGroup id={group}>
        <ul className="m-0 grid list-none items-end gap-1 px-2 py-0" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {left.map(tab)}
          {launch ? (
            <li className="flex flex-col items-center gap-0.5">
              {launch.href ? (
                <LinkComponent href={launch.href} aria-current={launch.active ? "page" : undefined} className={launchClass}>
                  {launchInner}
                </LinkComponent>
              ) : (
                <button type="button" onClick={launch.onClick} aria-current={launch.active ? "page" : undefined} className={launchClass}>
                  {launchInner}
                </button>
              )}
              <span aria-hidden="true" className="text-[11px] font-semibold leading-tight text-ink">
                {launchLabel}
              </span>
            </li>
          ) : null}
          {right.map(tab)}
        </ul>
      </LayoutGroup>
    </nav>
  );
}
