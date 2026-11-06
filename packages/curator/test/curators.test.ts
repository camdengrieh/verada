import { readFileSync } from "node:fs";
import { AGENT_CATEGORIES } from "@varada/sdk";
import { describe, expect, it } from "vitest";
import { CURATORS, checkCurators, cronOf, curatorByName, curatorOfCause, dueOn, upcomingRuns } from "../src/curators.js";

const DAY = 86_400_000;
const at = (iso: string) => new Date(iso);

describe("curator agents", () => {
  it("covers every cause exactly once with ten pairs", () => {
    expect(CURATORS).toHaveLength(10);
    expect(() => checkCurators()).not.toThrow();
    expect(CURATORS.flatMap((c) => c.causes).sort()).toEqual(AGENT_CATEGORIES.map((a) => a.ensLabel).sort());
    expect(() => checkCurators([...CURATORS, { name: "x", causes: ["hunger", "water"], offset: 0, time: "11:00" }])).toThrow(/both/);
    expect(() => checkCurators(CURATORS.slice(1))).toThrow(/without a curator/);
  });

  it("finds agents by name and by cause label or slug", () => {
    expect(curatorByName("Relief")?.causes).toEqual(["disaster", "hunger"]);
    expect(curatorOfCause("refugees")?.name).toBe("justice");
    expect(curatorOfCause("clean-water")?.name).toBe("planet");
    expect(curatorOfCause("nope")).toBeUndefined();
  });

  it("runs every 3 days, alternating the two causes", () => {
    const relief = curatorByName("relief")!;
    const runs = upcomingRuns(relief, at("2026-11-07T12:00:00Z"), 4);
    expect(runs.map((r) => r.day - runs[0]!.day)).toEqual([0, 3, 6, 9]);
    expect(runs.map((r) => r.cause)).toEqual([runs[0]!.cause, runs[1]!.cause, runs[0]!.cause, runs[1]!.cause]);
    expect(new Set(runs.map((r) => r.cause))).toEqual(new Set(["disaster", "hunger"]));
    // Off days have no run; the whole UTC day counts.
    const d = runs[0]!.date;
    expect(dueOn(relief, at(`${d}T00:00:00Z`))?.cause).toBe(runs[0]!.cause);
    expect(dueOn(relief, at(`${d}T23:59:59Z`))?.cause).toBe(runs[0]!.cause);
    expect(dueOn(relief, new Date(at(`${d}T12:00:00Z`).getTime() + DAY))).toBeNull();
  });

  it("evaluates every cause in every 7-day epoch, before Thursday 00:00 UTC", () => {
    // Epochs start on Thursdays 00:00 UTC; check a year of epochs from 2026-11-05.
    const first = at("2026-11-05T00:00:00Z").getTime();
    for (let e = 0; e < 52; e++) {
      const start = first + e * 7 * DAY;
      for (const c of CURATORS) {
        const runs = upcomingRuns(c, new Date(start), 6).filter((r) => r.day * DAY < start + 7 * DAY);
        expect(new Set(runs.map((r) => r.cause)), `${c.name} in epoch from ${new Date(start).toISOString()}`).toEqual(new Set(c.causes));
      }
    }
    for (const c of CURATORS) expect(Number(c.time.slice(0, 2))).toBeLessThan(12);
  });

  it("spreads the agents over the days and gives each its own time", () => {
    const perOffset = [0, 1, 2].map((o) => CURATORS.filter((c) => c.offset === o).length);
    expect(Math.max(...perOffset) - Math.min(...perOffset)).toBeLessThanOrEqual(1);
    expect(new Set(CURATORS.map((c) => c.time)).size).toBe(CURATORS.length);
    expect(cronOf(curatorByName("health")!)).toBe("30 7 * * *");
  });

  it("matches the 1Claw deployment record", () => {
    const rec = JSON.parse(readFileSync(new URL("../../../agents/curators.json", import.meta.url), "utf8")) as {
      agents: { agent: string; oneClawName: string; signer: string; causes: string[] }[];
    };
    expect(rec.agents.map((a) => a.agent).sort()).toEqual(CURATORS.map((c) => c.name).sort());
    for (const a of rec.agents) {
      expect(a.causes).toEqual([...curatorByName(a.agent)!.causes]);
      expect(a.oneClawName).toBe(`varada-${a.agent}-curator`);
      expect(a.signer).toMatch(/^0x[0-9a-f]{40}$/);
    }
    expect(new Set(rec.agents.map((a) => a.signer)).size).toBe(rec.agents.length);
  });
});
