import { describe, expect, it } from "vitest";
import { compact, formatQuote, formatSmallNumber, formatUsd, formatUsdc, timeAgo, unitsToNumber } from "@/lib/format";

describe("format", () => {
  it("compacts numbers", () => {
    expect(compact(0)).toBe("0");
    expect(compact(7.456)).toBe("7.46");
    expect(compact(42.34)).toBe("42.3");
    expect(compact(950)).toBe("950");
    expect(compact(1234)).toBe("1.2K");
    expect(compact(3_400_000)).toBe("3.4M");
  });
  it("reads base units", () => {
    expect(unitsToNumber(1_500_000n, 6)).toBe(1.5);
    expect(unitsToNumber(10n ** 18n * 3n, 18)).toBe(3);
  });
  it("formats USDC", () => {
    expect(formatUsdc(0n)).toBe("$0");
    expect(formatUsdc(450_000n)).toBe("$0.45");
    expect(formatUsdc(12_400_000n)).toBe("$12.4");
    expect(formatUsdc(1_234_000_000n)).toBe("$1.2K");
  });
  it("formats USD floats", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(129.484)).toBe("$129.48");
    expect(formatUsd(0.0412)).toBe("$0.0412");
    expect(formatUsd(64_210)).toBe("$64.2K");
  });
  it("writes tiny prices with a subscript", () => {
    expect(formatSmallNumber(0.00000412)).toBe("0.0₅412");
    expect(formatSmallNumber(0.0123)).toBe("0.0123");
    expect(formatSmallNumber(12.5)).toBe("12.5");
    expect(formatSmallNumber(0)).toBe("0");
  });
  it("labels quote amounts", () => {
    expect(formatQuote(12_400, "WETH")).toBe("12.4K WETH");
    expect(formatQuote(0.00000412, "WETH")).toBe("0.0₅412 WETH");
  });
  it("says how long ago", () => {
    expect(timeAgo(1000, 1010)).toBe("just now");
    expect(timeAgo(1000, 1000 + 4 * 60)).toBe("4 min ago");
    expect(timeAgo(1000, 1000 + 3 * 3600)).toBe("3 h ago");
    expect(timeAgo(1000, 1000 + 2 * 86400)).toBe("2 d ago");
    expect(timeAgo(undefined, 5)).toBe("");
  });
});
