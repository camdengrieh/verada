// Written for Varada: props, classes and the in-place variant the mobile bottom sheets share.
"use client";

import { X } from "lucide-react";
import { createContext, useContext, useId, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import { DrawerDescription, DrawerTitle } from "@verada/ui/components/ui/drawer";
import { cn } from "@verada/ui/lib/utils";

/** Open state and placement, common to every mobile sheet (all built on ui/drawer, i.e. vaul). */
export interface MobileSheetBaseProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Where the sheet portals to (default `document.body`). Pass a phone frame (an element with layout
   * containment, e.g. `@container`) and the sheet, its overlay and its snap points fit that frame;
   * the sheet then also leaves the body's styles alone (no iOS scroll lock on the page).
   */
  container?: HTMLElement | null;
  /**
   * Modal (default): overlay, focus trap, outside content inert. `false` is vaul's non-modal mode:
   * no overlay, outside clicks don't close it. vaul still runs Radix Dialog as modal underneath
   * (other content is hidden from assistive tech while it is open), so to show a sheet open beside
   * other content use `inline` instead.
   */
  modal?: boolean;
  /**
   * Render in place instead of as a drawer: a non-modal panel pinned to the bottom of the nearest
   * positioned ancestor, with no portal, drag, focus trap or scroll lock. For previews such as
   * phone frames in a gallery, where several sheets are open at once. Close (and Escape) still call
   * `onOpenChange(false)`.
   */
  inline?: boolean;
}

/** Heights relative to the portal container instead of the viewport, when there is one. */
export const CONTAINED_SHEET =
  "max-h-[88%] data-[vaul-snap-points=true]:h-[96%] data-[vaul-snap-points=true]:max-h-[96%]";

const InlineIds = createContext<{ title: string; description: string } | null>(null);

function InlineTitle({ className, ...props }: ComponentProps<"h2">) {
  const ids = useContext(InlineIds);
  return <h2 id={ids?.title} className={cn("m-0 font-display text-xl font-semibold leading-tight text-ink", className)} {...props} />;
}

function InlineDescription({ className, ...props }: ComponentProps<"p">) {
  const ids = useContext(InlineIds);
  return <p id={ids?.description} className={cn("m-0 text-sm text-ink-soft", className)} {...props} />;
}

/** Title and description parts for a sheet: vaul's (Radix Dialog) in a drawer, plain ones inline. */
export function sheetParts(inline: boolean | undefined) {
  return inline ? { Title: InlineTitle, Description: InlineDescription } : { Title: DrawerTitle, Description: DrawerDescription };
}

export interface InlineSheetProps extends Omit<ComponentProps<"section">, "children"> {
  onClose: () => void;
  closeLabel?: string;
  children: ReactNode;
}

/**
 * The in-place sheet: same paper, radius, handle and 44px close corner as DrawerContent, as a
 * non-modal dialog (role="dialog", aria-modal="false") labelled by its title.
 */
export function InlineSheet({ onClose, closeLabel = "Close", className, children, onKeyDown, ...props }: InlineSheetProps) {
  const id = useId();
  const ids = { title: `${id}-title`, description: `${id}-desc` };
  return (
    <InlineIds.Provider value={ids}>
      <section
        role="dialog"
        aria-modal="false"
        aria-labelledby={ids.title}
        aria-describedby={ids.description}
        onKeyDown={(e: KeyboardEvent<HTMLElement>) => {
          onKeyDown?.(e);
          if (e.key === "Escape" && !e.defaultPrevented) {
            e.stopPropagation();
            onClose();
          }
        }}
        className={cn(
          "absolute inset-x-0 bottom-0 z-50 mx-auto flex max-h-[88%] w-full max-w-xl flex-col rounded-t-3xl border border-b-0 border-line bg-paper-card text-card-foreground shadow-float",
          "pb-[env(safe-area-inset-bottom)] motion-safe:animate-in motion-safe:slide-in-from-bottom-8 motion-safe:fade-in-0",
          className,
        )}
        {...props}
      >
        <span aria-hidden="true" className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-ink-muted/50" />
        {children}
        <button
          type="button"
          aria-label={closeLabel}
          onClick={onClose}
          className="absolute top-2 right-2 inline-flex size-11 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-sand hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <X aria-hidden="true" className="size-5" />
        </button>
      </section>
    </InlineIds.Provider>
  );
}
