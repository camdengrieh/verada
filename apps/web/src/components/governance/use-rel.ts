"use client";

import { useEffect, useState } from "react";
import { siteBase } from "@/lib/base";

/**
 * Link builder from the site base, read from the real location once mounted (a component rendered
 * inside a page cannot see the layout segments `useRel` relies on, so it would build the wrong
 * prefix). Works under /bzz/<hash>/, bzz subdomains and ENS gateways, at any page depth.
 */
export function useSiteRel(): (path: string) => string {
  const [base, setBase] = useState("./");
  useEffect(() => setBase(siteBase()), []);
  return (path) => `${base}${path.replace(/^\//, "")}`;
}
