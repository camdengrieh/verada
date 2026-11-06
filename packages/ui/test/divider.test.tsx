import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Divider } from "@varada/ui/components/ui/divider";

describe("Divider", () => {
  it("is decorative by default and a separator when asked", () => {
    const { container, rerender } = render(<Divider />);
    expect(container.firstElementChild).toHaveAttribute("role", "none");
    rerender(<Divider decorative={false} orientation="vertical" />);
    expect(screen.getByRole("separator")).toHaveAttribute("aria-orientation", "vertical");
  });

  it("renders a label between two rules and every variant", () => {
    render(<Divider label="Fees" variant="dashed" />);
    expect(screen.getByText("Fees")).toBeInTheDocument();
    for (const v of ["line", "dashed", "brush", "ornament"] as const) {
      const { container } = render(<Divider variant={v} />);
      expect(container.querySelector("[data-slot='divider']")).toHaveAttribute("data-variant", v);
    }
  });
});
