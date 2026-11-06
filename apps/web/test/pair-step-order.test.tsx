import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { PairStep } from "@/components/launch/pair-step";
import { initialWizardState } from "@/lib/launch-steps";
import type { AppQuoteAsset } from "@/lib/quote-assets";

const asset = (symbol: string, n: number, routeDepthUsd?: number): AppQuoteAsset => ({
  symbol,
  name: symbol,
  kind: "stock",
  address: `0x${n.toString(16).padStart(40, "0")}` as Address,
  decimals: 18,
  route: routeDepthUsd ? [symbol, "WETH", "USDC"] : undefined,
  routeDepthUsd,
});

const weth: AppQuoteAsset = { symbol: "WETH", name: "Wrapped Ether", kind: "crypto", address: "0x4200000000000000000000000000000000000006", decimals: 18, route: ["WETH", "USDC"], routeDepthUsd: 5_000_000 };

function renderStep(assets: AppQuoteAsset[], marketsLoading = false) {
  const state = initialWizardState("salt");
  return render(
    <PairStep
      state={state}
      errors={{}}
      err={() => undefined}
      touch={() => undefined}
      patch={() => undefined}
      setInput={() => undefined}
      assets={assets}
      loading={false}
      marketsLoading={marketsLoading}
      failed={false}
      retry={() => undefined}
    />,
  );
}

describe("PairStep Stocks & RWA tab", () => {
  it("lists RWAs deepest first with unrouted last and disabled", () => {
    renderStep([weth, asset("TSLAon", 2, 80_000), asset("BRK.Bon", 3), asset("NVDAon", 4, 600_000), asset("AAPLon", 5, 80_000)]);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Stocks & RWA/ }));
    const radios = screen.getAllByRole("radio").filter((r) => /on,/.test(r.getAttribute("aria-label") ?? ""));
    expect(radios.map((r) => r.getAttribute("aria-label")!.split(",")[0])).toEqual(["NVDAon", "AAPLon", "TSLAon", "BRK.Bon"]);
    expect(radios[3]).toBeDisabled();
  });

  it("shows placeholders instead of unrouted rows while depth is being read", () => {
    renderStep([weth, asset("NVDAon", 4)], true);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Stocks & RWA/ }));
    expect(document.querySelector('[data-slot="quote-asset-list-loading"]')).not.toBeNull();
    expect(screen.queryByText("Can’t fill")).toBeNull();
  });
});
