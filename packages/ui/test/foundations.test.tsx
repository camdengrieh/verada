import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AssetProvider } from "@verada/ui/lib/assets";
import { Badge } from "@verada/ui/components/ui/badge";
import { Button } from "@verada/ui/components/ui/button";
import { PaintedImage } from "@verada/ui/components/varada/painted-image";

describe("Button", () => {
  it("defaults to type=button and the primary variant", () => {
    render(<Button>Buy</Button>);
    const b = screen.getByRole("button", { name: "Buy" });
    expect(b).toHaveAttribute("type", "button");
    expect(b.className).toContain("bg-primary");
  });

  it("renders its child when asChild is set", () => {
    render(<Button asChild variant="outline"><a href="#x">Launch</a></Button>);
    const a = screen.getByRole("link", { name: "Launch" });
    expect(a).not.toHaveAttribute("type");
    expect(a.className).toContain("border-ink");
  });
});

describe("Badge", () => {
  it("adds a status dot", () => {
    const { container } = render(<Badge tone="live" dot>Live</Badge>);
    expect(container.querySelector("[aria-hidden='true']")).not.toBeNull();
  });
});

describe("PaintedImage", () => {
  const asset = { width: 1920, height: 1433, avif: [640, 1280], webp: [960], blur: "data:image/webp;base64,AAAA" };

  it("builds AVIF and WebP srcsets through the asset resolver", () => {
    const { container } = render(
      <AssetProvider resolve={(p) => `../${p}`}>
        <PaintedImage name="scenes/x" asset={asset} alt="A scene" />
      </AssetProvider>,
    );
    const sources = container.querySelectorAll("source");
    expect(sources[0]).toHaveAttribute("type", "image/avif");
    expect(sources[0]).toHaveAttribute("srcset", "../assets/scenes/x-640.avif 640w, ../assets/scenes/x-1280.avif 1280w");
    expect(sources[1]).toHaveAttribute("srcset", "../assets/scenes/x-960.webp 960w");
    const img = screen.getByAltText("A scene");
    expect(img).toHaveAttribute("src", "../assets/scenes/x-960.webp");
    expect(img).toHaveAttribute("width", "1920");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img.style.backgroundImage).toContain("data:image/webp");
  });
});
