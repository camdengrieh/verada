// Adapted from 21st.dev @klyv-ui/pull-to-refresh (id 44223): the pull only starts when the list is
// already at the top, travel past the threshold is damped, the indicator fills as a ring until
// release would fire, the spinner stays until the refresh promise settles, and a real Refresh button
// is always there. Touch is handled with non-passive touch listeners (pointer events get cancelled
// by the browser's own scroll on phones), the mouse with pointer events; Varada tokens throughout.
"use client";

import { LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { usePrefersReducedMotion } from "@verada/ui/components/motion/marquee";
import { cn } from "@verada/ui/lib/utils";

export interface PullToRefreshProps extends Omit<ComponentProps<"div">, "children"> {
  /** The scrolling content. */
  children: ReactNode;
  /** Runs the refresh; return a promise to keep the spinner until it settles. */
  onRefresh: () => void | Promise<void>;
  /** Pixels of pull before a release refreshes. */
  threshold?: number;
  /** Shown at each stage. */
  labels?: { pull?: string; release?: string; refreshing?: string; button?: string };
  /** The Refresh button above the list, for people who can't (or don't know to) drag. On by default. */
  showButton?: boolean;
  /** Controlled refreshing state, e.g. while a query refetches for another reason. */
  refreshing?: boolean;
  disabled?: boolean;
  /** Classes for the scroll area (give it a height, e.g. `h-full` or `max-h-[60dvh]`). */
  scrollClassName?: string;
  /** Receives the scroll area, e.g. for a BottomTabBar's `scrollContainer`. */
  scrollRef?: (el: HTMLDivElement | null) => void;
}

/** Past the threshold the pull gets heavier, so the edge feels elastic. */
export function resistPull(distance: number, threshold: number): number {
  if (distance <= threshold) return distance;
  return threshold + (distance - threshold) * 0.35;
}

/**
 * Drag the top of a list down past a threshold to reload it. The gesture only starts when the list
 * is scrolled to the top, so it never steals an ordinary scroll. With reduced motion the list does
 * not move: the strip above it shows the pull state and then the spinner, and the button works as
 * always.
 */
export function PullToRefresh({
  children,
  onRefresh,
  threshold = 72,
  labels,
  showButton = true,
  refreshing: refreshingProp,
  disabled,
  className,
  scrollClassName,
  scrollRef: onScrollRef,
  ...props
}: PullToRefreshProps) {
  const reduced = usePrefersReducedMotion();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const onScrollRefRef = useRef(onScrollRef);
  onScrollRefRef.current = onScrollRef;
  const setScrollEl = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    onScrollRefRef.current?.(el);
  }, []);
  const start = useRef<number | null>(null);
  const pullRef = useRef(0);
  const [pull, setPull] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [innerRefreshing, setInnerRefreshing] = useState(false);
  const refreshing = refreshingProp ?? innerRefreshing;
  const busy = useRef(false);
  busy.current = refreshing;

  const copy = {
    pull: labels?.pull ?? "Pull to refresh",
    release: labels?.release ?? "Release to refresh",
    refreshing: labels?.refreshing ?? "Refreshing…",
    button: labels?.button ?? "Refresh",
  };
  const armed = pull >= threshold;
  const progress = Math.min(1, pull / threshold);

  const run = async () => {
    if (busy.current) return;
    busy.current = true;
    setInnerRefreshing(true);
    setPull(0);
    pullRef.current = 0;
    try {
      await onRefresh();
    } finally {
      busy.current = false;
      setInnerRefreshing(false);
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  const update = (distance: number) => {
    const p = distance <= 0 ? 0 : resistPull(distance, threshold);
    pullRef.current = p;
    setPull(p);
  };
  const release = () => {
    if (start.current === null) return;
    start.current = null;
    setDragging(false);
    if (pullRef.current >= threshold) void runRef.current();
    else update(0);
  };
  const releaseRef = useRef(release);
  releaseRef.current = release;

  // Touch: non-passive so a pull at the top can stop the page from scrolling or bouncing.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || disabled) return;
    const onStart = (e: TouchEvent) => {
      if (busy.current || el.scrollTop > 0 || e.touches.length !== 1) return;
      start.current = e.touches[0]!.clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (start.current === null) return;
      const d = e.touches[0]!.clientY - start.current;
      if (d <= 0 || el.scrollTop > 0) {
        start.current = d <= 0 ? start.current : null;
        update(0);
        return;
      }
      if (e.cancelable) e.preventDefault();
      setDragging(true);
      update(d);
    };
    const onEnd = () => releaseRef.current();
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, threshold]);

  const offset = reduced ? 0 : refreshing ? threshold * 0.7 : pull;
  const stripHeight = reduced ? (pull > 0 || refreshing ? 40 : 0) : Math.max(pull, refreshing ? threshold * 0.7 : 0);
  const status = refreshing ? copy.refreshing : armed ? copy.release : copy.pull;

  return (
    <div data-slot="pull-to-refresh" className={cn("relative isolate flex min-h-0 flex-col gap-2", className)} {...props}>
      {showButton ? (
        <div className="flex justify-end px-1">
          <button
            type="button"
            onClick={() => void run()}
            disabled={disabled || refreshing}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold text-ink-soft transition-colors hover:bg-sand hover:text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <RefreshCw aria-hidden="true" className={cn("size-4", refreshing && "motion-safe:animate-spin")} />
            {copy.button}
          </button>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* The indicator sits behind the list and is uncovered by the pull (or shown in place with reduced motion). */}
        <div
          aria-hidden="true"
          className={cn("absolute inset-x-0 top-0 flex items-center justify-center gap-2 overflow-hidden text-[13px] font-semibold", armed || refreshing ? "text-ink" : "text-ink-muted")}
          style={{ height: stripHeight }}
        >
          {refreshing ? (
            <LoaderCircle className="size-5 motion-safe:animate-spin" />
          ) : (
            <svg viewBox="0 0 24 24" className="size-5 -rotate-90">
              <circle cx="12" cy="12" r="9" fill="none" stroke="var(--line-strong)" strokeWidth="2.5" />
              <circle cx="12" cy="12" r="9" fill="none" stroke="var(--sage)" strokeWidth="2.5" strokeLinecap="round" pathLength={1} strokeDasharray={`${progress} 1`} />
            </svg>
          )}
          {stripHeight > 24 ? <span>{status}</span> : null}
        </div>
        <div
          ref={setScrollEl}
          onPointerDown={(e) => {
            if (e.pointerType !== "mouse" || e.button !== 0 || disabled || busy.current || (scrollRef.current?.scrollTop ?? 0) > 0) return;
            start.current = e.clientY;
          }}
          onPointerMove={(e) => {
            if (e.pointerType !== "mouse" || start.current === null) return;
            const d = e.clientY - start.current;
            if (d > 4 && !dragging) {
              setDragging(true);
              e.currentTarget.setPointerCapture?.(e.pointerId);
            }
            update(d);
          }}
          onPointerUp={(e) => e.pointerType === "mouse" && release()}
          onPointerCancel={() => release()}
          className={cn(
            "relative h-full overflow-y-auto overscroll-y-contain bg-background",
            dragging && "select-none",
            !dragging && "transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
            scrollClassName,
          )}
          style={{ transform: offset ? `translate3d(0, ${offset}px, 0)` : undefined, marginTop: reduced ? stripHeight : undefined }}
        >
          {children}
        </div>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {refreshing ? copy.refreshing : ""}
      </p>
    </div>
  );
}
