import { describe, expect, it } from "vitest";
import { activeRoute } from "@/components/app-shell";

describe("activeRoute", () => {
  it("names the top-level route under any prefix", () => {
    expect(activeRoute("/")).toBe("");
    expect(activeRoute("/causes/")).toBe("causes/");
    expect(activeRoute("/bzz/ab12/governance/")).toBe("governance/");
    expect(activeRoute("/agent/hunger/africa/")).toBe("agent/");
  });

  it("marks Agents active at the root of an agent host, and leaves other roots on Tokens", () => {
    expect(activeRoute("/", true)).toBe("agent/");
    expect(activeRoute("/", false)).toBe("");
    // A real route on an agent host keeps its own tab.
    expect(activeRoute("/launch/", true)).toBe("launch/");
  });
});
