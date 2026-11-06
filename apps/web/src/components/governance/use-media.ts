"use client";

import { useEffect, useState } from "react";

/** `matchMedia(query)`, false on the server and until mounted (the export is static). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, [query]);
  return matches;
}

/** Phones, where the ballot opens as a bottom sheet instead of sitting in the page. */
export const useIsPhone = () => useMediaQuery("(max-width: 767px)");
