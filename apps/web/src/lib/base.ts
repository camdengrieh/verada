/**
 * Locate the directory the site is served from, so relative URLs work under
 * /bzz/<hash>/, on a bzz subdomain and at the root of an ENS gateway alike.
 * Top-level routes are exactly one directory deep, so strip a known route.
 */
export const ROUTES = ["launch", "causes", "governance", "token", "design", "dev-wallet", "404"] as const;

/** `agent/`, `agent/<label>/` and `agent/<label>/<region>/` are one to three directories deep. */
const AGENT_PATH = /^(.*\/)agent(?:\/[^/]+){0,2}\/?(?:index\.html)?$/;

export function siteBaseFromPath(pathname: string): string {
  const m = pathname.match(new RegExp(`^(.*/)(?:${ROUTES.join("|")})/?(?:index\\.html)?$`)) ?? pathname.match(AGENT_PATH);
  if (m) return m[1] ?? "/";
  if (/\/bzz\/[^/]+$/.test(pathname)) return `${pathname}/`;
  return pathname.replace(/[^/]*$/, "") || "/";
}

export function siteBase(): string {
  if (typeof window === "undefined") return "./";
  return siteBaseFromPath(window.location.pathname);
}
