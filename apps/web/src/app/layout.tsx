import type { ReactNode } from "react";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { Providers } from "@/components/providers";

export const metadata = { title: { default: "Varada", template: "%s · Varada" }, description: "Meme coins that fund causes. Every trade gives." };

const FONTS = ["fraunces", "instrument-sans", "jetbrains-mono"];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Root-absolute here; scripts/postexport.mjs makes /assets/ links depth-relative in the export.
            A plain stylesheet (not next/font) so the font URLs stay relative to fonts.css under any prefix. */}
        {/* eslint-disable-next-line @next/next/no-css-tags */}
        <link rel="stylesheet" href="/assets/fonts/fonts.css" precedence="default" />
        {/* Tab icon from the bundled logo; /assets/ is made depth-relative by postexport. Without it
            browsers request /favicon.ico, which a Swarm manifest answers with a 404. */}
        <link rel="icon" type="image/svg+xml" href="/assets/logo/varada-logo.svg" />
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
