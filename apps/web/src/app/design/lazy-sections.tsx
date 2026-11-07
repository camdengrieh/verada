"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type ComponentType } from "react";

/**
 * Below-the-fold gallery sections. Each one's code (and the libraries only it needs: motion,
 * charts, drawers, tables) downloads when its placeholder nears the viewport or its anchor is
 * opened, not with the first paint. The placeholder keeps the section's `id` so table-of-contents
 * links work before it loads, and reserves height so the page below does not jump.
 */
function Deferred({ id, minHeight, Section }: { id: string; minHeight: number; Section: ComponentType }) {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (show) return;
    if (window.location.hash === `#${id}`) {
      setShow(true);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setShow(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShow(true);
      },
      { rootMargin: "1500px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [id, show]);

  // A TOC click on a still-unloaded section: load it, then land on it once it has its real height.
  useEffect(() => {
    const open = () => {
      if (window.location.hash === `#${id}`) setShow(true);
    };
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, [id]);

  // Opened by anchor: once the real section has replaced the placeholder, land on it.
  useEffect(() => {
    if (!show || window.location.hash !== `#${id}`) return;
    const t = window.setTimeout(() => document.getElementById(id)?.scrollIntoView(), 600);
    return () => window.clearTimeout(t);
  }, [id, show]);

  if (show) return <Section />;
  return <div ref={ref} id={id} style={{ minHeight }} aria-hidden="true" />;
}

const section = (loader: () => Promise<ComponentType>) => dynamic(loader, { ssr: false });

const Motion = section(() => import("./sections/motion").then((m) => m.MotionSection));
const Effects = section(() => import("./sections/effects").then((m) => m.EffectsSection));
const Primitives = section(() => import("./sections/primitives").then((m) => m.PrimitivesSection));
const Navigation = section(() => import("./sections/navigation").then((m) => m.NavigationSection));
const Data = section(() => import("./sections/data").then((m) => m.DataSection));
const Markets = section(() => import("./sections/markets").then((m) => m.MarketsSection));
const Metrics = section(() => import("./sections/metrics").then((m) => m.MetricsSection));
const Activity = section(() => import("./sections/activity").then((m) => m.ActivitySection));
const Ens = section(() => import("./sections/ens").then((m) => m.EnsSection));
const Impact = section(() => import("./sections/impact").then((m) => m.ImpactSection));
const Varada = section(() => import("./sections/varada").then((m) => m.VaradaSection));
const Mobile = section(() => import("./sections/mobile").then((m) => m.MobileSection));

export const LazySections = () => (
  <>
    <Deferred id="motion" minHeight={900} Section={Motion} />
    <Deferred id="effects" minHeight={900} Section={Effects} />
    <Deferred id="primitives" minHeight={1200} Section={Primitives} />
    <Deferred id="navigation" minHeight={800} Section={Navigation} />
    <Deferred id="data" minHeight={1200} Section={Data} />
    <Deferred id="markets" minHeight={1200} Section={Markets} />
    <Deferred id="metrics" minHeight={900} Section={Metrics} />
    <Deferred id="activity" minHeight={900} Section={Activity} />
    <Deferred id="ens" minHeight={700} Section={Ens} />
    <Deferred id="impact" minHeight={700} Section={Impact} />
    <Deferred id="varada" minHeight={1200} Section={Varada} />
    <Deferred id="mobile" minHeight={1200} Section={Mobile} />
  </>
);
