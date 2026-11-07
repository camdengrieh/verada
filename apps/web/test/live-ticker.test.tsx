import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityTicker } from "@varada/ui/components/varada/activity-ticker";
import { splitTicker } from "@/components/discover/live-giving";

describe("two-way live ticker", () => {
  it("puts trades and launches in one strip, gifts and votes in the other", () => {
    const rows = [
      { id: "1", kind: "BUY" },
      { id: "2", kind: "GIVE" },
      { id: "3", kind: "NEW" },
      { id: "4", kind: "VOTE" },
    ];
    const { market, giving } = splitTicker(rows);
    expect(market.map((r) => r.id)).toEqual(["1", "3"]);
    expect(giving.map((r) => r.id)).toEqual(["2", "4"]);
  });

  it("runs a strip the other way and names its badge", () => {
    render(<ActivityTicker items={[{ id: "a", kind: "GIVE", symbol: "SOUP", text: "gave 5 USDC" }]} tag="Giving" direction="right" label="Live gifts" />);
    expect(screen.getByText("Giving")).toBeInTheDocument();
    const track = screen.getByRole("region", { name: "Live gifts, scroll to read" }).firstElementChild as HTMLElement;
    expect(track.style.animationDirection).toBe("reverse");
  });
});
