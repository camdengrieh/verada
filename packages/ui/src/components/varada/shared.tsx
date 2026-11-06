// Written for Varada
import type { ComponentType, MouseEventHandler, ReactNode } from "react";

/**
 * Pieces shared by the Varada components: the link contract (so the app can hand in its
 * relative-link component, which knows the page depth under Swarm/ENS prefixes), image sources and
 * the painted wash tones used behind coin art.
 */

export interface VaradaLinkProps {
  href: string;
  className?: string;
  children: ReactNode;
  "aria-current"?: "page" | undefined;
  "aria-label"?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}

/** Any component that renders an anchor for `href` (Next Link, the app's relative link, …). */
export type LinkComponent = ComponentType<VaradaLinkProps>;

/** Plain anchor, used when the app doesn't supply a link component. */
export function DefaultLink({ href, children, ...props }: VaradaLinkProps) {
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}

/** A ready image URL (already resolved through useAssetUrl or the Swarm gateway). */
export interface ImageSource {
  src: string;
  srcSet?: string;
  sizes?: string;
}

/** Pigment behind coin art: a tint fill plus a matching watercolour bloom. */
export type WashTone = "sage" | "ochre" | "sky" | "etf" | "terracotta" | "sand";

export const WASH_FILL: Record<WashTone, string> = {
  sage: "bg-sage-tint",
  ochre: "bg-ochre-tint",
  sky: "bg-stock-tint",
  etf: "bg-etf-tint",
  terracotta: "bg-terracotta-tint",
  sand: "bg-sand",
};

export const WASH_PIGMENT: Record<WashTone, string> = {
  sage: "var(--sage)",
  ochre: "var(--ochre)",
  sky: "var(--sky)",
  etf: "var(--etf-ink)",
  terracotta: "var(--terracotta)",
  sand: "var(--ochre)",
};

/** Classes that grow a small control's hit area to 44px without changing how it looks. */
export const HIT_AREA = "relative after:absolute after:-inset-1 after:content-['']";
