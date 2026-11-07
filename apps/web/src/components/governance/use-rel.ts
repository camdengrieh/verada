"use client";

import { useEffect, useState } from "react";
import { siteBase } from "@/lib/base";
import { useSiteRoot } from "@/lib/site-root";

/**
 * Link builder from the site base. Inside the app shell the base comes from the route depth, so the
 * prerendered HTML already carries working hrefs at any depth. Without a shell (tests, isolated
 * renders) it starts at "./" and is read from the real location once mounted. Works under
 * /bzz/<hash>/, bzz subdomains and ENS gateways.
 */
export function useSiteRel(): (path: string) => string {
  const root = useSiteRoot();
  const [base, setBase] = useState("./");
  useEffect(() => {
    if (root === null) setBase(siteBase());
  }, [root]);
  const prefix = root ?? base;
  return (path) => `${prefix}${path.replace(/^\//, "")}`;
}
