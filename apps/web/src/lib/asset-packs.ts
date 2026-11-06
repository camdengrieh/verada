import { swarmGatewayUrl } from "@verada/sdk";
import { ASSETS, PACKS, type AssetEntry, type PackName } from "./assets.generated";
import type { AppConfig } from "./config";

/**
 * Art kept out of the site bundle (stock logos and other large or growing sets) is published as its
 * own Swarm collection and read through the configured gateway, the same way token logos are.
 */
export interface PackImage {
  src: string;
  /** Width descriptors for the raster variants; absent for vectors. */
  srcSet?: string;
  width?: number;
  height?: number;
}

/** Gateway URL of a file in a published pack, or undefined when the pack or gateway isn't configured. */
export function packFileUrl(cfg: Pick<AppConfig, "assetPacks" | "swarmGatewayUrl">, pack: PackName, file: string): string | undefined {
  const ref = cfg.assetPacks[pack];
  if (!ref || !cfg.swarmGatewayUrl) return undefined;
  try {
    return swarmGatewayUrl(cfg.swarmGatewayUrl, ref, file);
  } catch {
    return undefined;
  }
}

/**
 * The image for one pack entry, sized for `displayWidth` CSS px (the srcSet lets the browser pick a
 * sharper variant on dense screens). Undefined when the entry doesn't exist or the pack isn't
 * published yet, so callers render their fallback (e.g. a lettered badge).
 */
export function packImage(
  cfg: Pick<AppConfig, "assetPacks" | "swarmGatewayUrl">,
  pack: PackName,
  name: string,
  displayWidth = 64,
): PackImage | undefined {
  const entries: Record<string, AssetEntry> = PACKS[pack];
  const entry = Object.prototype.hasOwnProperty.call(entries, name) ? entries[name] : undefined;
  if (!entry) return undefined;
  if ("vector" in entry) {
    const src = packFileUrl(cfg, pack, `${name}.svg`);
    return src ? { src } : undefined;
  }
  const widths = entry.webp ?? [];
  if (widths.length === 0) return undefined;
  const pick = widths.find((w) => w >= displayWidth) ?? widths[widths.length - 1];
  const src = packFileUrl(cfg, pack, `${name}-${pick}.webp`);
  if (!src) return undefined;
  const srcSet = widths.map((w) => `${packFileUrl(cfg, pack, `${name}-${w}.webp`)} ${w}w`).join(", ");
  return { src, srcSet, width: entry.width, height: entry.height };
}

/** A stock or ETF logo by Ondo symbol (e.g. `NVDAon`), from the published stocks pack. */
export function stockLogo(cfg: Pick<AppConfig, "assetPacks" | "swarmGatewayUrl">, symbol: string, displayWidth = 32): PackImage | undefined {
  return packImage(cfg, "stocks", symbol, displayWidth);
}

/**
 * A logo shipped inside the site bundle (assets/<group>/<symbol>…), resolved with the page's
 * relative-path resolver (siteBase()/useRel()). Undefined when the bundle has no mark for it.
 */
export function bundledLogo(
  group: "stocks" | "tokens",
  symbol: string,
  resolve: (path: string) => string,
  displayWidth = 32,
): PackImage | undefined {
  const assets: Record<string, AssetEntry> = ASSETS;
  const key = `${group}/${symbol}`;
  const entry = Object.prototype.hasOwnProperty.call(assets, key) ? assets[key] : undefined;
  if (!entry) return undefined;
  if ("vector" in entry) return { src: resolve(`assets/${key}.svg`) };
  const widths = entry.webp ?? [];
  if (widths.length === 0) return undefined;
  const pick = widths.find((w) => w >= displayWidth) ?? widths[widths.length - 1];
  return {
    src: resolve(`assets/${key}-${pick}.webp`),
    srcSet: widths.map((w) => `${resolve(`assets/${key}-${w}.webp`)} ${w}w`).join(", "),
    width: entry.width,
    height: entry.height,
  };
}

/**
 * The logo for any quote asset: crypto pairs (WETH, WBTC, USDC…) and Ondo stocks/ETFs. Prefers the
 * published stocks pack when it is configured, then the copies shipped in the bundle. Undefined means
 * the UI shows its lettered fallback.
 */
export function quoteAssetLogo(
  cfg: Pick<AppConfig, "assetPacks" | "swarmGatewayUrl">,
  symbol: string,
  resolve: (path: string) => string,
  displayWidth = 32,
): PackImage | undefined {
  return stockLogo(cfg, symbol, displayWidth) ?? bundledLogo("stocks", symbol, resolve, displayWidth) ?? bundledLogo("tokens", symbol, resolve, displayWidth);
}
