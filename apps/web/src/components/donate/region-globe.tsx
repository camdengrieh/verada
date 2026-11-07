"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { cn } from "@varada/ui/lib/utils";
import { useMediaQuery } from "@/components/governance/use-media";
import {
  MAP_REGIONS,
  REGION_CENTRES,
  landDots,
  lonDelta,
  projectFlat,
  projectGlobe,
  regionPaths,
  type MapRegion,
} from "@/lib/world-dots";
import { placeList } from "@/lib/just-donate";

const DISC = { r: 236, cx: 260, cy: 260 } as const;
const MAP_W = 720;
const MAP_H = 284;
/** Pointer travel (px) after which a press is a drag, not a click on a continent. */
const DRAG_SLOP = 4;

/**
 * The region picker's world: a dot globe (drag to turn it, click a continent to pick it; it turns
 * to each new pick and spins slowly while nothing is picked) or the same dots as a flat map. The
 * drawing is for pointers: the region buttons beside it are the accessible control, so the SVG is
 * one labelled image. Under reduced motion it neither spins nor animates turns.
 */
export function RegionGlobe({
  picked,
  onToggle,
  view,
  className,
}: {
  picked: readonly MapRegion[];
  onToggle(region: MapRegion): void;
  view: "globe" | "map";
  className?: string;
}) {
  const dots = useMemo(() => landDots(), []);
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [rot, setRot] = useState<{ lon: number; lat: number }>({ lon: 20, lat: 12 });
  const rotRef = useRef(rot);
  rotRef.current = rot;
  const turn = useRef(0);
  const drag = useRef<{ id: number; x: number; y: number; lon: number; lat: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  const turnTo = useCallback(
    (lon: number, lat: number) => {
      cancelAnimationFrame(turn.current);
      const from = rotRef.current;
      const dl = lonDelta(from.lon, lon);
      if (reduced) return setRot({ lon: from.lon + dl, lat });
      const t0 = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / 750);
        const e = 1 - (1 - k) ** 3;
        setRot({ lon: from.lon + dl * e, lat: from.lat + (lat - from.lat) * e });
        if (k < 1) turn.current = requestAnimationFrame(step);
      };
      turn.current = requestAnimationFrame(step);
    },
    [reduced],
  );
  useEffect(() => () => cancelAnimationFrame(turn.current), []);

  // Turn to the region just added (not on removal, and not for the initial picks from the URL).
  const before = useRef<readonly MapRegion[] | null>(null);
  useEffect(() => {
    const prev = before.current;
    before.current = picked;
    const added = prev ? picked.find((r) => !prev.includes(r)) : picked[0];
    if (added) turnTo(REGION_CENTRES[added][0], REGION_CENTRES[added][1]);
  }, [picked, turnTo]);

  // A slow idle spin while nothing is picked, so the globe reads as a globe.
  const spin = view === "globe" && !reduced && picked.length === 0 && !dragging;
  useEffect(() => {
    if (!spin) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      setRot((r) => ({ lon: ((r.lon + dt * 0.006 + 540) % 360) - 180, lat: r.lat }));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [spin]);

  const paths = useMemo(
    () =>
      view === "globe"
        ? regionPaths(dots, (lon, lat) => projectGlobe(lon, lat, { ...DISC, lon: rot.lon, lat: rot.lat }))
        : regionPaths(dots, (lon, lat) => projectFlat(lon, lat, MAP_W, MAP_H)),
    [dots, view, view === "globe" ? rot.lon : 0, view === "globe" ? rot.lat : 0], // eslint-disable-line react-hooks/exhaustive-deps
  );

  function onPointerDown(e: PointerEvent<SVGSVGElement>) {
    if (view !== "globe" || (e.pointerType === "mouse" && e.button !== 0)) return;
    cancelAnimationFrame(turn.current);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, lon: rotRef.current.lon, lat: rotRef.current.lat, moved: false };
  }
  function onPointerMove(e: PointerEvent<SVGSVGElement>) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    // Degrees per pixel scale with the rendered size, so a drag tracks the finger at any width.
    const scale = 180 / Math.max(1, e.currentTarget.getBoundingClientRect().width);
    setRot({ lon: d.lon - dx * scale, lat: Math.max(-60, Math.min(70, d.lat + dy * scale)) });
  }
  function onPointerEnd(e: PointerEvent<SVGSVGElement>) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = d.moved ? { ...d, id: -1 } : null;
    setDragging(false);
  }
  function pick(region: MapRegion) {
    // The click that ends a drag is not a pick.
    if (drag.current?.moved) {
      drag.current = null;
      return;
    }
    drag.current = null;
    onToggle(region);
  }

  const none = picked.length === 0;
  const tone = (r: MapRegion) => (none ? "stroke-sage/70" : picked.includes(r) ? "stroke-sage" : "stroke-line-strong");
  const label = `World ${view === "globe" ? "globe" : "map"}. Picked: ${placeList(picked)}.`;
  const regionPath = (r: MapRegion, width: number) => (
    <path
      key={r}
      d={paths[r]}
      fill="none"
      strokeWidth={width}
      strokeLinecap="round"
      className={cn("cursor-pointer transition-[stroke] duration-200 hover:stroke-sage-ink", tone(r))}
      onClick={() => pick(r)}
    />
  );

  return view === "globe" ? (
    <svg
      viewBox="0 0 520 520"
      role="img"
      aria-label={label}
      className={cn("block aspect-square w-full touch-none select-none", dragging ? "cursor-grabbing" : "cursor-grab", className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <circle cx={DISC.cx} cy={DISC.cy} r={DISC.r + 10} fill="none" className="stroke-line" strokeDasharray="2 6" />
      <circle cx={DISC.cx} cy={DISC.cy} r={DISC.r} className="fill-sand stroke-line-strong" strokeWidth={1.5} />
      {MAP_REGIONS.map((r) => regionPath(r, 5.2))}
    </svg>
  ) : (
    <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} role="img" aria-label={label} className={cn("block w-full select-none", className)}>
      {MAP_REGIONS.map((r) => regionPath(r, 3.6))}
    </svg>
  );
}
