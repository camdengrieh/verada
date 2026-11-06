"use client";

import { usePathname, useSelectedLayoutSegments } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AssetProvider } from "@varada/ui/lib/assets";
import { BottomTabBar, BOTTOM_TAB_BAR_HEIGHT, type BottomTab } from "@varada/ui/components/mobile/bottom-tab-bar";
import { Compass, HandHeart, Vote, User, Coins } from "@varada/ui/components/ui/icons";
import { Toaster } from "@varada/ui/components/ui/toaster";
import { Divider } from "@varada/ui/components/ui/divider";
import { LogoMark } from "@varada/ui/components/varada/logo-mark";
import { SiteHeader, type SiteNavLink } from "@varada/ui/components/varada/site-header";
import type { VaradaLinkProps } from "@varada/ui/components/varada/shared";
import { ConnectButton } from "@/components/connect-button";
import { NAV_ITEMS, relativeRoot } from "@/components/nav";
import { PrivacyMenu } from "@/components/privacy-status";
import { siteBase, siteBaseFromPath } from "@/lib/base";

/** Resolves site-relative asset paths against the site root so they work under any Swarm/ENS prefix. */
const resolveAsset = (path: string) => `${siteBase()}${path.replace(/^\//, "")}`;

const TAB_ICONS = { "": Compass, "launch/": Coins, "causes/": HandHeart, "governance/": Vote, "agent/": User } as const;

/** The route a pathname belongs to ("" for the token list), independent of any Swarm/ENS prefix. */
export function activeRoute(pathname: string): string {
  const base = siteBaseFromPath(pathname);
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : pathname.replace(/^\//, "");
  const first = rest.split("/")[0] ?? "";
  const hit = NAV_ITEMS.find((n) => n.to !== "" && n.to.replace(/\/$/, "") === first);
  return hit ? hit.to : "";
}

export function AppShell({ children }: { children: ReactNode }) {
  const prefix = relativeRoot(useSelectedLayoutSegments());
  const pathname = usePathname();
  const [route, setRoute] = useState("");
  // The static export has no server pathname context before hydration; read it once mounted.
  useEffect(() => setRoute(activeRoute(window.location.pathname)), [pathname]);

  const href = (to: string) => `${prefix}${to}`;
  const links: SiteNavLink[] = useMemo(() => NAV_ITEMS.map((n) => ({ href: href(n.to), label: n.label })), [prefix]); // eslint-disable-line react-hooks/exhaustive-deps
  const tabs: BottomTab[] = useMemo(
    () =>
      NAV_ITEMS.filter((n) => n.to !== "launch/").map((n) => ({ href: href(n.to), label: n.label, icon: TAB_ICONS[n.to] })),
    [prefix], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <AssetProvider resolve={resolveAsset}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-paper">
        Skip to content
      </a>
      <SiteHeader
        links={links}
        activeHref={href(route)}
        homeHref={href("")}
        privacy={<PrivacyMenu />}
        wallet={<ConnectButton />}
      />
      <main id="main" className="mx-auto w-full max-w-[1400px] px-4 pb-[calc(var(--tab-h)+1.5rem)] pt-6 @container md:px-8 md:pb-12" style={{ "--tab-h": `${BOTTOM_TAB_BAR_HEIGHT}px` } as React.CSSProperties}>
        {children}
      </main>
      <footer className="mx-auto w-full max-w-[1400px] px-4 pb-28 md:px-8 md:pb-10">
        <Divider variant="brush" />
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 text-sm text-ink-soft">
          <span className="inline-flex items-center gap-2">
            <LogoMark size={24} decorative />
            Varada · every trade gives
          </span>
          <span>
            Charts by{" "}
            <a className="underline" href="https://www.tradingview.com/" rel="noreferrer noopener">
              TradingView
            </a>{" "}
            · Fonts under the SIL OFL
          </span>
        </div>
      </footer>
      <div className="md:hidden">
        <BottomTabBar
          tabs={tabs}
          activeHref={route === "launch/" ? undefined : href(route)}
          launch={{ href: href("launch/"), active: route === "launch/" }}
          LinkComponent={RelLink}
        />
      </div>
      <Toaster />
    </AssetProvider>
  );
}

function RelLink({ href, children, ...props }: VaradaLinkProps) {
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}
