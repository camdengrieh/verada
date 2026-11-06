import { describe, expect, it } from "vitest";
import { formatCount, formatDuration, formatEth, formatGwei, formatQuoteAmount } from "@/lib/launch-format";
import { launchErrorHelp } from "@/lib/launch-errors";

describe("formatQuoteAmount", () => {
  it("scales to the size", () => {
    expect(formatQuoteAmount(10)).toBe("10");
    expect(formatQuoteAmount(1234.5)).toBe("1,235");
    expect(formatQuoteAmount(0.0125)).toBe("0.0125");
    expect(formatQuoteAmount(1e-10)).toBe("1.00e-10");
    expect(formatQuoteAmount(NaN)).toBe("n/a");
  });
});

describe("gas and time formats", () => {
  it("formats ETH, gwei, durations and counts", () => {
    expect(formatEth(12_300_000_000_000_000n)).toBe("0.0123 ETH");
    expect(formatEth(1n)).toBe("< 0.0001 ETH");
    expect(formatGwei(12_340_000_000n)).toBe("12.3 gwei");
    expect(formatGwei(1_500_000_000n)).toBe("1.50 gwei");
    expect(formatDuration(300)).toBe("5m");
    expect(formatDuration(86_400)).toBe("1d");
    expect(formatCount(251_000)).toBe("251K");
  });
});

describe("launchErrorHelp", () => {
  it("offers a new salt for an existing pool or token", () => {
    expect(launchErrorHelp("reverted with 0x7983c051").rerollSalt).toBe(true);
    expect(launchErrorHelp("TokenAlreadyDeployed(0x1)").rerollSalt).toBe(true);
  });
  it("explains common reverts and passes unknown text through", () => {
    expect(launchErrorHelp("User rejected the request.").text).toMatch(/declined/);
    expect(launchErrorHelp("LabelTaken(0x1, 0x2)").text).toMatch(/ENS label/);
    expect(launchErrorHelp("something odd").text).toBe("something odd");
  });
});
