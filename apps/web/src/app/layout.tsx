import type { ReactNode } from "react";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { Providers } from "@/components/providers";

export const metadata = { title: "Varada", description: "Meme coins that fund causes. Every trade gives." };

const FONTS = ["fraunces", "instrument-sans", "jetbrains-mono"];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Root-absolute here; scripts/postexport.mjs makes /assets/ links depth-relative in the export.
            A plain stylesheet (not next/font) so the font URLs stay relative to fonts.css under any prefix. */}
        {/* eslint-disable-next-line @next/next/no-css-tags */}
        <link rel="stylesheet" href="/assets/fonts/fonts.css" precedence="default" />
        {FONTS.map((f) => (
          <link key={f} rel="preload" as="font" type="font/woff2" href={`/assets/fonts/${f}.woff2`} crossOrigin="" />
        ))}
      </head>
      <body className="min-h-dvh bg-paper text-ink antialiased">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
