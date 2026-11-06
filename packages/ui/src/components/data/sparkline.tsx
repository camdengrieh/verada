// Adapted from 21st.dev @kuratlielia/sparkline (id 35038): monotone curve, draw-in stroke, area under the line.
"use client";

import { motion, useReducedMotion } from "motion/react";
import { useId, useMemo, type ComponentProps } from "react";
import { cn } from "@verada/ui/lib/utils";

export type SparklineTone = "auto" | "gain" | "loss" | "cause" | "primary" | "muted" | "stock";

const TONE: Record<Exclude<SparklineTone, "auto">, string> = {
  gain: "text-gain",
  loss: "text-loss",
  cause: "text-sage",
  primary: "text-primary",
  muted: "text-ink-muted",
  stock: "text-stock-ink",
};

export interface SparklineProps extends Omit<ComponentProps<"svg">, "children"> {
  data: number[];
  width?: number;
  height?: number;
  /** Fill a soft wash under the line. */
  area?: boolean;
  /** `auto` uses gain when the last point is at or above the first, loss otherwise. */
  tone?: SparklineTone;
  strokeWidth?: number;
  /** Accessible summary, e.g. "7 day price, up 12%". Without it the chart is decorative. */
  label?: string;
  /** Draw the line in once when it mounts (skipped with reduced motion). */
  animate?: boolean;
  /** Dot on the latest point. */
  endDot?: boolean;
}

type Point = [number, number];

/** Monotone cubic (Fritsch–Carlson) path through the points, so the curve never overshoots the data. */
export function sparklinePath(points: Point[]): string {
  const n = points.length;
  if (n === 0) return "";
  const first = points[0]!;
  if (n === 1) return `M${first[0]},${first[1]}`;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    dx.push(b[0] - a[0]);
    slope.push(dx[i]! === 0 ? 0 : (b[1] - a[1]) / dx[i]!);
  }
  const tangent: number[] = [slope[0]!];
  for (let i = 1; i < n - 1; i++) {
    const s0 = slope[i - 1]!;
    const s1 = slope[i]!;
    tangent.push(s0 * s1 <= 0 ? 0 : (3 * (dx[i - 1]! + dx[i]!)) / ((2 * dx[i]! + dx[i - 1]!) / s0 + (dx[i]! + 2 * dx[i - 1]!) / s1));
  }
  tangent.push(slope[n - 2]!);
  let d = `M${first[0].toFixed(2)},${first[1].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    const h = dx[i]! / 3;
    d += `C${(x0 + h).toFixed(2)},${(y0 + h * tangent[i]!).toFixed(2)} ${(x1 - h).toFixed(2)},${(y1 - h * tangent[i + 1]!).toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`;
  }
  return d;
}

/** Tiny SVG trend line for stat cards and table rows. Colour comes from the tone's text token. */
export function Sparkline({
  data,
  width = 120,
  height = 36,
  area = true,
  tone = "auto",
  strokeWidth = 1.75,
  label,
  animate = true,
  endDot = true,
  className,
  ...props
}: SparklineProps) {
  const reduced = useReducedMotion();
  const gradientId = `spark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const values = data.length > 1 ? data : [data[0] ?? 0, data[0] ?? 0];
  const resolved: Exclude<SparklineTone, "auto"> =
    tone === "auto" ? ((values.at(-1) ?? 0) >= (values[0] ?? 0) ? "gain" : "loss") : tone;

  const { line, fill, end } = useMemo(() => {
    const pad = strokeWidth + 2;
    const min = Math.min(...values);
    const span = Math.max(...values) - min;
    const points: Point[] = values.map((v, i) => [
      (i / (values.length - 1)) * width,
      pad + (span ? 1 - (v - min) / span : 0.5) * (height - pad * 2),
    ]);
    const path = sparklinePath(points);
    const last = points.at(-1)!;
    return { line: path, fill: `${path}L${width},${height}L0,${height}Z`, end: last };
  }, [values, width, height, strokeWidth]);

  const draw = animate && !reduced;

  return (
    <svg
      data-slot="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      className={cn("overflow-visible", TONE[resolved], className)}
      {...props}
    >
      {area ? (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <motion.path
            d={fill}
            fill={`url(#${gradientId})`}
            initial={draw ? { opacity: 0 } : false}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.3 }}
          />
        </>
      ) : null}
      <motion.path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        initial={draw ? { pathLength: 0 } : false}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.9, ease: [0.65, 0, 0.35, 1] }}
      />
      {endDot ? <circle cx={end[0]} cy={end[1]} r={strokeWidth + 1} fill="currentColor" /> : null}
    </svg>
  );
}
