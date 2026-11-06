import { describe, expect, it } from "vitest";
import { EXTERNAL_ADDRESSES, ONDO_TOKENS } from "@varada/sdk";
import { describeQuoteAsset, findQuote, quoteAssetsFromRows } from "@/lib/quote-assets";
import { ondoName, underlyingTicker } from "@/lib/ondo-names";

describe("describeQuoteAsset", () => {
  it("names WETH as crypto", () => {
    expect(describeQuoteAsset(EXTERNAL_ADDRESSES.weth)).toEqual({ symbol: "WETH", name: "Wrapped Ether", kind: "crypto" });
  });
  it("maps Ondo stocks and ETFs with the issuer's name", () => {
    expect(describeQuoteAsset(ONDO_TOKENS.NVDAon.address)).toEqual({ symbol: "NVDAon", name: "NVIDIA", kind: "stock" });
    expect(describeQuoteAsset(ONDO_TOKENS.SPYon.address)).toMatchObject({ symbol: "SPYon", kind: "etf", name: "SPDR S&P 500 ETF Trust" });
  });
  it("treats Ondo currencies and portfolios as tokenized assets", () => {
    expect(describeQuoteAsset(ONDO_TOKENS.USDon.address).kind).toBe("rwa");
    expect(describeQuoteAsset(ONDO_TOKENS.MAG7Xon.address).kind).toBe("rwa");
  });
  it("shows an unknown address by its short form", () => {
    const d = describeQuoteAsset("0x1234567890123456789012345678901234567890");
    expect(d.symbol).toBe("0x1234…7890");
  });
});

describe("ondoName", () => {
  it("falls back to the underlying ticker rather than guessing", () => {
    expect(ondoName("BBAIon")).toBe("BBAI");
    expect(underlyingTicker("Con")).toBe("C");
    expect(ondoName("Con")).toBe("Citigroup");
  });
});

describe("quoteAssetsFromRows", () => {
  const rows = [
    { asset: EXTERNAL_ADDRESSES.weth.toLowerCase(), kind: 0, active: true, decimals: 18 },
    { asset: ONDO_TOKENS.TSLAon.address, kind: 1, active: true, decimals: 18 },
    { asset: ONDO_TOKENS.AAPLon.address, kind: 1, active: false, decimals: 18 },
    { asset: ONDO_TOKENS.TSLAon.address, kind: 1, active: true, decimals: 18 },
    { asset: "not-an-address", active: true },
  ];
  it("keeps active, unique, valid rows and marks them launchable", () => {
    const out = quoteAssetsFromRows(rows, (s) => (s === "WETH" ? { src: "weth.svg" } : undefined));
    expect(out.map((a) => a.symbol)).toEqual(["WETH", "TSLAon"]);
    expect(out[0]).toMatchObject({ address: EXTERNAL_ADDRESSES.weth, decimals: 18, logo: { src: "weth.svg" }, launchable: { ok: true } });
    expect(findQuote(out, ONDO_TOKENS.TSLAon.address.toUpperCase().replace("0X", "0x"))?.name).toBe("Tesla");
  });
});
