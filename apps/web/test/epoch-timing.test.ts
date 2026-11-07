import { describe, expect, it } from "vitest";
import { cycleText, durationText, timingOf, timingPhase } from "@/lib/epoch-timing";

describe("epoch timing", () => {
  it("formats durations without assuming a week", () => {
    expect(durationText(2700)).toBe("45 minutes");
    expect(durationText(900)).toBe("15 minutes");
    expect(durationText(300)).toBe("5 minutes");
    expect(durationText(60)).toBe("1 minute");
    expect(durationText(5400)).toBe("1 hour 30 minutes");
    expect(durationText(86_400)).toBe("1 day");
    expect(durationText(604_800)).toBe("7 days");
    expect(durationText(90_000)).toBe("1 day 1 hour");
    expect(durationText(0)).toBe("0 seconds");
  });

  it("describes the cycle", () => {
    const t = { start: 1000, end: 1000 + 2700, votingOpensAt: 1000 + 1800 };
    expect(cycleText(t)).toBe("45 minutes: 30 minutes of trading, then 15 minutes of voting");
    expect(cycleText({ start: 0, end: 604_800, votingOpensAt: 0 })).toBe("7 days, with ballots accepted throughout");
  });

  it("walks trading, voting and tally on the second", () => {
    const t = { start: 1000, end: 3700, votingOpensAt: 2800 };
    expect(timingPhase(t, 1000)).toBe("trading");
    expect(timingPhase(t, 2799)).toBe("trading");
    expect(timingPhase(t, 2800)).toBe("voting");
    expect(timingPhase(t, 3699)).toBe("voting");
    expect(timingPhase(t, 3700)).toBe("ended");
  });

  it("falls back to voting from the start when a source has no votingOpensAt, and to null without boundaries", () => {
    expect(timingOf({ start: 10, end: 20 })).toEqual({ start: 10, end: 20, votingOpensAt: 10 });
    expect(timingOf({ start: 10, end: 20, votingOpensAt: 15 })).toEqual({ start: 10, end: 20, votingOpensAt: 15 });
    expect(timingOf({ start: 10 })).toBeNull();
    expect(timingOf(null)).toBeNull();
  });
});
