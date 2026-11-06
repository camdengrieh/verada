// Written for Varada (thumb-reach Back / Next and Vote bars from the A-Mobile and C-Mobile boards)
"use client";

import type { ComponentProps, ReactNode } from "react";
import { Button, buttonVariants, type ButtonProps } from "@varada/ui/components/ui/button";
import { DefaultLink, type LinkComponent } from "@varada/ui/components/varada/shared";
import { cn } from "@varada/ui/lib/utils";
import { BOTTOM_TAB_BAR_HEIGHT } from "./bottom-tab-bar";

export interface StickyAction {
  label: ReactNode;
  /** A link… */
  href?: string;
  /** …or a callback. */
  onClick?: () => void;
  disabled?: boolean;
  variant?: ButtonProps["variant"];
  /** Spoken name when the label is short or an icon ("Back to step 2"). */
  ariaLabel?: string;
  /** Leading icon. */
  icon?: ReactNode;
}

export interface StickyActionBarProps extends Omit<ComponentProps<"div">, "children"> {
  primary: StickyAction;
  secondary?: StickyAction;
  /** A line above the buttons: a total, a privacy note, why the primary is disabled. */
  note?: ReactNode;
  /**
   * `fixed` (default) pins it to the bottom of the viewport or of the nearest container with layout
   * containment; `sticky` sticks at the bottom of its scroll parent; `static` leaves it in flow.
   */
  position?: "fixed" | "sticky" | "static";
  /** Sit above a BottomTabBar instead of on the screen edge. */
  aboveTabBar?: boolean;
  LinkComponent?: LinkComponent;
}

/**
 * The bottom action bar for phone flows: an optional note, a secondary (Back, Cancel) and a full-width
 * primary, 52px tall, in thumb reach. Respects the home-indicator inset, or sits on top of the tab bar
 * with `aboveTabBar`. A size container: under 288px the two buttons stack, full width.
 */
export function StickyActionBar({ primary, secondary, note, position = "fixed", aboveTabBar, LinkComponent = DefaultLink, className, style, ...props }: StickyActionBarProps) {
  const action = (a: StickyAction, kind: "primary" | "secondary") => {
    const variant = a.variant ?? (kind === "primary" ? "primary" : "outline");
    const cls = cn(kind === "primary" ? "h-13 min-w-0 flex-1 text-base" : "h-13 shrink-0 px-5 text-[15px] @max-2xs:w-full");
    if (a.href && !a.disabled) {
      return (
        <LinkComponent href={a.href} aria-label={a.ariaLabel} className={cn(buttonVariants({ variant, size: "lg" }), cls)}>
          {a.icon}
          {a.label}
        </LinkComponent>
      );
    }
    return (
      <Button variant={variant} size="lg" disabled={a.disabled} onClick={a.onClick} aria-label={a.ariaLabel} className={cls}>
        {a.icon}
        {a.label}
      </Button>
    );
  };
  return (
    <div
      data-slot="sticky-action-bar"
      className={cn(
        "@container z-30 border-t border-line bg-paper-card/95 backdrop-blur",
        position === "fixed" && "fixed inset-x-0",
        position === "sticky" && "sticky",
        position !== "static" && !aboveTabBar && "bottom-0",
        !aboveTabBar && "pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        aboveTabBar && "pb-3",
        className,
      )}
      style={position !== "static" && aboveTabBar ? { bottom: `calc(${BOTTOM_TAB_BAR_HEIGHT}px + max(0.5rem, env(safe-area-inset-bottom)))`, ...style } : style}
      {...props}
    >
      <div className="flex flex-col gap-2 px-4 pt-3">
        {note ? <div className="text-[13px] text-ink-soft">{note}</div> : null}
        <div className="flex items-center gap-2.5 @max-2xs:flex-col @max-2xs:items-stretch">
          {secondary ? action(secondary, "secondary") : null}
          {action(primary, "primary")}
        </div>
      </div>
    </div>
  );
}
