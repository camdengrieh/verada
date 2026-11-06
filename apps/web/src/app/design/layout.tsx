import type { ReactNode } from "react";
import "./design.css";
import { DesignProviders } from "./providers";

export const metadata = { title: "Varada · Design system" };

const FONTS = ["fraunces", "instrument-sans", "jetbrains-mono"];

export default function DesignLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {/* Root-absolute here; scripts/postexport.mjs makes /assets/ links depth-relative in the export.
          A plain stylesheet (not next/font) so the font URLs stay relative to fonts.css under any prefix. */}
      {/* eslint-disable-next-line @next/next/no-css-tags */}
      <link rel="stylesheet" href="/assets/fonts/fonts.css" precedence="default" />
      {FONTS.map((f) => (
        <link key={f} rel="preload" as="font" type="font/woff2" href={`/assets/fonts/${f}.woff2`} crossOrigin="" />
      ))}
      <DesignProviders>{children}</DesignProviders>
    </>
  );
}
