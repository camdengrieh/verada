// @vitest-environment node
// WCAG 2.x contrast of the Paper & Pigment tokens, computed from styles.css so a palette edit that
// drops a text pair under 4.5:1 (or the focus ring under 3:1) fails here instead of in review.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

function tokens(block: RegExp): Record<string, string> {
  const body = css.match(block)?.[1] ?? "";
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1]!, m[2]!]));
}

const light = tokens(/:root \{([\s\S]*?)\n\}/);
const dark = { ...light, ...tokens(/\n\.dark \{([\s\S]*?)\n\}/) };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Text colours the components put on the page surfaces and tints. */
const TEXT = ["ink", "ink-soft", "ink-muted", "terracotta", "terracotta-strong", "sage", "sage-ink", "gain", "loss"];
const SURFACES = ["paper", "paper-card", "sand", "terracotta-tint", "sage-tint", "ochre-tint", "stock-tint", "etf-tint"];
/** Tinted pills pair a dedicated ink with its tint. */
const PILLS: [string, string][] = [
  ["ochre-ink", "ochre-tint"],
  ["sage-ink", "sage-tint"],
  ["terracotta-strong", "terracotta-tint"],
  ["stock-ink", "stock-tint"],
  ["etf-ink", "etf-tint"],
  ["primary-foreground", "terracotta"],
  ["destructive-foreground", "destructive"],
];

describe.each([
  ["light", light],
  ["dark", dark],
] as const)("Paper & Pigment contrast (%s)", (_name, t) => {
  it("keeps body text and semantic text at 4.5:1 on the page surfaces", () => {
    const fails: string[] = [];
    for (const fg of TEXT) {
      for (const bg of ["paper", "paper-card", "sand"]) {
        const r = contrast(t[fg]!, t[bg]!);
        if (r < 4.5) fails.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
      }
    }
    expect(fails).toEqual([]);
  });

  it("keeps ink on every tint at 4.5:1", () => {
    const fails: string[] = [];
    for (const fg of ["ink", "ink-soft", "ink-muted"]) {
      for (const bg of SURFACES) {
        const r = contrast(t[fg]!, t[bg]!);
        if (r < 4.5) fails.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
      }
    }
    expect(fails).toEqual([]);
  });

  it("keeps each tinted pill and filled button at 4.5:1", () => {
    for (const [fg, bg] of PILLS) expect(contrast(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it("draws the focus ring at 3:1 against the surfaces it sits on", () => {
    for (const bg of ["paper", "paper-card", "sand"]) expect(contrast(t.ring ?? t.terracotta!, t[bg]!), `ring on ${bg}`).toBeGreaterThanOrEqual(3);
  });
});

describe("contrast helper", () => {
  it("matches the WCAG reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });
});
