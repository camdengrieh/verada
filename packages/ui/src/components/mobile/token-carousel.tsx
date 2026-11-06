// Adapted from 21st.dev @ddoemonn/snap-carousel (id 23559): its carousel semantics (roledescription
// "carousel" and "slide", "n of N" slide names, a keyboard hint, a polite "Slide n of N" status),
// arrow / Home / End keys, peek edges and pill indicators. The physics-driven track is replaced by
// native CSS scroll snap, so touch scrolling keeps the platform's momentum and nothing is inert.
"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { Children, isValidElement, useCallback, useEffect, useId, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@varada/ui/lib/utils";

export interface TokenCarouselProps extends Omit<ComponentProps<"section">, "children"> {
  /** Accessible name ("Trending coins"); also the visible heading unless `heading` is given. */
  label: string;
  /** Visible heading; pass `null` to show none (the label still names the carousel). */
  heading?: ReactNode;
  /** One child per slide (TokenCards, cause cards…). */
  children: ReactNode;
  /** Active slide (controlled) … */
  index?: number;
  /** … or the starting slide. */
  defaultIndex?: number;
  onIndexChange?: (index: number) => void;
  /** Previous / next buttons beside the heading. */
  showControls?: boolean;
  /** Width of each slide; default 84% of the carousel, two up from 448px, three from 768px. */
  slideClassName?: string;
  /** Show page dots (the default up to 7 slides, which fit a phone at 44px each; a "3 / 12" count beyond that). */
  showIndicators?: boolean;
}

/**
 * A horizontal row of cards that snaps one card at a time, with the next card peeking in. Swipe or
 * scroll it, use the previous / next buttons, the page dots (44px targets), or focus it and press the
 * arrow keys, Home and End. A size container: one card per view on phones, two from 448px, three
 * from 768px. Smooth scrolling turns off with reduced motion.
 */
export function TokenCarousel({
  label,
  heading,
  children,
  index: controlled,
  defaultIndex = 0,
  onIndexChange,
  showControls = true,
  slideClassName = "basis-[84%] @md:basis-[calc((100%-2.75rem)/2)] @3xl:basis-[calc((100%-3.5rem)/3)]",
  showIndicators,
  className,
  ...props
}: TokenCarouselProps) {
  const slides = Children.toArray(children);
  const count = slides.length;
  const reduced = useReducedMotion();
  const id = useId();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [inner, setInner] = useState(() => Math.min(Math.max(defaultIndex, 0), Math.max(count - 1, 0)));
  const [announced, setAnnounced] = useState("");
  const index = Math.min(Math.max(controlled ?? inner, 0), Math.max(count - 1, 0));
  const live = useRef(index);
  live.current = index;

  const commit = useCallback(
    (next: number) => {
      if (next === live.current) return;
      live.current = next;
      setInner(next);
      onIndexChange?.(next);
    },
    [onIndexChange],
  );

  const scrollToSlide = useCallback(
    (i: number) => {
      const el = scrollerRef.current;
      const slide = el?.children[i] as HTMLElement | undefined;
      if (!el || !slide) return;
      // The track is the slides' offsetParent (it is positioned), so offsetLeft ignores its scroll.
      const left = slide.offsetLeft - parseFloat(getComputedStyle(el).paddingLeft || "0");
      if (typeof el.scrollTo === "function") el.scrollTo({ left, behavior: reduced ? "auto" : "smooth" });
      else el.scrollLeft = left;
    },
    [reduced],
  );

  const goTo = (i: number) => {
    const next = Math.min(Math.max(i, 0), count - 1);
    commit(next);
    setAnnounced(`Slide ${next + 1} of ${count}`);
    scrollToSlide(next);
  };

  // A controlled index that changes from outside scrolls the row too.
  useEffect(() => {
    if (controlled !== undefined) scrollToSlide(controlled);
  }, [controlled, scrollToSlide]);

  // Follow scrolling: the active slide is the one nearest the start edge (the last one at the end).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const kids = Array.from(el.children) as HTMLElement[];
        if (!kids.length) return;
        if (el.scrollLeft + el.clientWidth >= el.scrollWidth - 2) return commit(kids.length - 1);
        const start = el.scrollLeft + parseFloat(getComputedStyle(el).paddingLeft || "0");
        let best = 0;
        let bestDist = Infinity;
        kids.forEach((k, i) => {
          const d = Math.abs(k.offsetLeft - start);
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        });
        commit(best);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
    };
  }, [commit]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const map: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: count - 1 };
    if (!(e.key in map)) return;
    e.preventDefault();
    goTo(map[e.key]!);
  };

  const dots = showIndicators ?? count <= 7;
  const titleId = `${id}-title`;
  const hintId = `${id}-hint`;
  const shownHeading = heading === undefined ? label : heading;
  const control =
    "grid size-11 place-items-center rounded-full border border-line-strong bg-paper-card text-ink transition-colors hover:bg-sand disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-paper-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

  return (
    <section
      aria-roledescription="carousel"
      aria-label={shownHeading ? undefined : label}
      aria-labelledby={shownHeading ? titleId : undefined}
      data-slot="token-carousel"
      className={cn("@container flex flex-col gap-3", className)}
      {...props}
    >
      {shownHeading || showControls ? (
        <div className="flex items-center justify-between gap-3 px-4">
          {shownHeading ? (
            <h2 id={titleId} className="m-0 font-display text-xl font-semibold">
              {shownHeading}
            </h2>
          ) : (
            <span />
          )}
          {showControls && count > 1 ? (
            <div className="flex shrink-0 gap-1.5">
              <button type="button" className={control} onClick={() => goTo(index - 1)} disabled={index === 0} aria-label="Previous slide" aria-controls={`${id}-track`}>
                <ChevronLeft aria-hidden="true" className="size-5" />
              </button>
              <button type="button" className={control} onClick={() => goTo(index + 1)} disabled={index >= count - 1} aria-label="Next slide" aria-controls={`${id}-track`}>
                <ChevronRight aria-hidden="true" className="size-5" />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div
        ref={scrollerRef}
        id={`${id}-track`}
        tabIndex={0}
        aria-describedby={hintId}
        onKeyDown={onKeyDown}
        className={cn(
          "relative flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto overscroll-x-contain px-4 pb-1",
          "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          "rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        )}
      >
        {slides.map((slide, i) => (
          <div
            key={isValidElement(slide) && slide.key != null ? slide.key : i}
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${count}`}
            aria-current={i === index ? "true" : undefined}
            data-active={i === index ? "true" : undefined}
            className={cn("flex min-w-0 shrink-0 snap-start snap-always flex-col *:flex-1", slideClassName)}
          >
            {slide}
          </div>
        ))}
      </div>
      {count > 1 ? (
        dots ? (
          <div className="flex justify-center">
            {slides.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => goTo(i)}
                aria-label={`Go to slide ${i + 1} of ${count}`}
                aria-current={i === index ? "true" : undefined}
                aria-controls={`${id}-track`}
                className="group grid size-11 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
              >
                <span
                  aria-hidden="true"
                  className={cn("block h-1.5 rounded-full transition-[width,background-color] duration-200", i === index ? "w-5 bg-ink" : "w-1.5 bg-line-strong group-hover:bg-ink-muted")}
                />
              </button>
            ))}
          </div>
        ) : (
          <p className="num m-0 text-center text-[13px] text-ink-muted" aria-hidden="true">
            {index + 1} / {count}
          </p>
        )
      ) : null}
      <span id={hintId} className="sr-only">
        Swipe, or use the left and right arrow keys, to move between {count} slides.
      </span>
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {announced}
      </span>
    </section>
  );
}
