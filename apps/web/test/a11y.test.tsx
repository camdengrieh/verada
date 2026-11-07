import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TokenHeroSkeleton } from "@/components/token/token-hero";

describe("token page while loading", () => {
  it("still has exactly one h1 and a named status", () => {
    render(<TokenHeroSkeleton />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("status", { name: "Loading token" })).toBeInTheDocument();
  });

  it("names the label being resolved", () => {
    render(<TokenHeroSkeleton title="Resolving moon-cat.varada.eth" />);
    expect(screen.getByRole("heading", { level: 1, name: "Resolving moon-cat.varada.eth" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Resolving moon-cat.varada.eth" })).toBeInTheDocument();
  });
});
