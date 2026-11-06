import { describe, expect, it } from "vitest";
import { encodeFunctionData } from "viem";
import { ESTIMATE_METADATA_URI, launchCall, shareLinks } from "@/lib/launch-tx";
import { parseLaunchInput } from "@/lib/launch";
import { initialWizardState, toLaunchInput } from "@/lib/launch-steps";

const FACTORY = "0x00000000000000000000000000000000000000f1";
const CAUSE = `0x${"ab".repeat(32)}`;

function parsed(over = {}) {
  const s = initialWizardState(`0x${"11".repeat(32)}`);
  const r = parseLaunchInput({ ...toLaunchInput({ ...s, input: { ...s.input, name: "Test", symbol: "TST", label: "test-coin" } }), ...over });
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe("launchCall", () => {
  it("encodes a weekly launch as deployToken with the metadata URI", () => {
    const r = parsed();
    const call = launchCall(FACTORY, r.params, "bzz://x", r.live);
    expect(call.functionName).toBe("deployToken");
    expect(() => encodeFunctionData({ abi: call.abi, functionName: "deployToken", args: call.args as never })).not.toThrow();
    expect(call.args[0].metadataURI).toBe("bzz://x");
  });

  it("encodes a live launch as deployLiveToken with the rotation enum and threshold", () => {
    const r = parsed({ mode: "live", rotation: "12h", donationThreshold: "25", initialCause: CAUSE });
    const call = launchCall(FACTORY, r.params, ESTIMATE_METADATA_URI, r.live);
    expect(call.functionName).toBe("deployLiveToken");
    if (call.functionName === "deployLiveToken") {
      expect(call.args[1]).toEqual({ initialCause: CAUSE, rotationPeriod: 1, donationThreshold: 25_000_000n });
      expect(() => encodeFunctionData({ abi: call.abi, functionName: "deployLiveToken", args: call.args as never })).not.toThrow();
    }
  });
});

describe("shareLinks", () => {
  it("encodes the page url and text", () => {
    const l = shareLinks({ name: "Test", symbol: "TST", pageUrl: "https://a.varada.eth.limo/" });
    expect(l.x).toContain("intent/tweet");
    expect(l.x).toContain(encodeURIComponent("https://a.varada.eth.limo/"));
    expect(l.telegram).toContain("t.me/share/url");
  });
});
