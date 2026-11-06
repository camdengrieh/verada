import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ballotSizeFixture, CASES } from "./ballot-fixture.js";

const path = fileURLToPath(new URL("../../../contracts/test/fixtures/ballot-sizes.json", import.meta.url));

describe("ballot size fixture (contracts/test/fixtures/ballot-sizes.json)", () => {
  it("matches the SDK's plans; UPDATE_FIXTURES=1 rewrites it", async () => {
    const fixture = await ballotSizeFixture();
    const text = `${JSON.stringify(fixture, null, 2)}\n`;
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(path, text);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("covers sizes 2, 3, 8, 16, 30 and 32, pins past the size and zero free curated slots", async () => {
    const { cases } = await ballotSizeFixture();
    expect([...new Set(cases.map((c) => c.size))].sort((a, b) => a - b)).toEqual([2, 3, 8, 16, 30, 32]);
    expect(cases.length).toBe(CASES.length);
    const pinsPast = cases.find((c) => c.nPins > c.size)!;
    expect(pinsPast.action).toBe("openEpoch");
    expect(pinsPast.nOptions).toBe(pinsPast.size);
    const zeroSlots = cases.find((c) => c.size === 3 && c.nPins === 3 && c.nBlocked === 0)!;
    expect(zeroSlots.nCurations).toBeGreaterThan(0);
    expect(zeroSlots.nCurated).toBe(0);
    expect(zeroSlots.action).toBe("openEpoch");
    // Every ballot is distinct options, no larger than its size.
    for (const c of cases) {
      expect(new Set(c.options).size).toBe(c.nOptions);
      expect(c.nOptions).toBeLessThanOrEqual(c.size);
    }
    // The sequential walk and the curated picks at small sizes are exercised.
    expect(cases.some((c) => c.size === 3 && c.nCurated === 1)).toBe(true);
    expect(cases.some((c) => c.curated.some((d) => d.entry === -1))).toBe(true);
  });
});
