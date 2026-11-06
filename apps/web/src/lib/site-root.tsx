"use client";

import { createContext, useContext } from "react";

/**
 * Relative path from the current page to the site root ("./", "../", "../../"), derived from the
 * route's layout segments so it is the same in the prerendered HTML and after hydration. Provided
 * by the app shell; page components cannot read the segments themselves.
 */
export const SiteRootContext = createContext<string | null>(null);

export function useSiteRoot(): string | null {
  return useContext(SiteRootContext);
}
