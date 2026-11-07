import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { AnimatedList } from "@varada/ui/components/motion/animated-list";
import { ScrollArea } from "@varada/ui/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableRow } from "@varada/ui/components/ui/table";
import { HeroStats } from "@varada/ui/components/varada/hero-shared";

describe("accessibility structure", () => {
  it("keeps list items inside a real list under the live log region", () => {
    render(<AnimatedList label="Live donations" items={[{ id: "a", node: "first" }, { id: "b", node: "second" }] as never} />);
    const log = screen.getByRole("log", { name: "Live donations" });
    expect(log.tagName).toBe("DIV");
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(log.querySelector("ul")).not.toBeNull();
  });

  it("builds the hero stat strip as a <dl> whose groups hold only dt and dd", () => {
    const { container } = render(<HeroStats stats={[{ label: "Raised", value: "$1" }, { label: "Coins", value: "3" }]} />);
    const dl = container.querySelector("dl")!;
    for (const group of dl.children) {
      expect([...group.children].map((c) => c.tagName)).toEqual(["DT", "DD"]);
    }
  });

  it("makes a scrolling table wrapper keyboard-focusable, and a region when the table is named", () => {
    const { container, rerender } = render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const wrap = container.querySelector("[data-slot=table-container]")!;
    expect(wrap).toHaveAttribute("tabindex", "0");
    expect(wrap).not.toHaveAttribute("role");
    rerender(
      <Table aria-label="Holders">
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole("region", { name: "Holders" })).toBe(container.querySelector("[data-slot=table-container]"));
  });

  it("lets a keyboard user focus a scroll area", () => {
    const { container } = render(<ScrollArea className="h-10">content</ScrollArea>);
    expect(container.querySelector("[data-slot=scroll-area-viewport]")).toHaveAttribute("tabindex", "0");
  });

  it("allows an empty state to be the page's h1", () => {
    render(<EmptyState headingLevel={1} title="Which token?" />);
    expect(screen.getByRole("heading", { level: 1, name: "Which token?" })).toBeInTheDocument();
  });
});
