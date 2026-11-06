// Accessibility audit of a built out/: axe-core in headless Chrome for every exported route at
// 390px and 1440px (light theme for all, dark theme for one page per route pattern), plus
// behaviour checks axe cannot make: skip link, heading order, 44px tap targets, focus
// trap/return/Escape in the command palette, live regions and reduced motion.
//   node scripts/a11y.mjs [--port 21234] [--only causes,launch] [--fast]
// Needs a Chrome binary (CHROME_PATH). Not part of the default test run. Exits 1 on any violation.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "out");
const args = process.argv.slice(2);
const opt = (name, d) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : d);
const port = Number(opt("port", 20000 + Math.floor(Math.random() * 20000)));
const only = opt("only", "")?.split(",").filter(Boolean);
const fast = args.includes("--fast");
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const axeSource = readFileSync(join(here, "..", "node_modules", "axe-core", "axe.min.js"), "utf8");
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1440", width: 1440, height: 900 },
];

function routes(dir = out, acc = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f !== "_next" && f !== "assets") routes(p, acc);
    } else if (f === "index.html") acc.push(`/${relative(out, dir)}/`.replace(/^\/\.\/$/, "/").replace(/\/+/g, "/"));
  }
  return acc;
}
const pattern = (r) => r.replace(/^\/(agent)\/[^/]+\/[^/]+\/$/, "/$1/[label]/[region]/").replace(/^\/(agent)\/[^/]+\/$/, "/$1/[label]/");

const server = spawn(process.execPath, [join(here, "serve-static.mjs"), String(port)], { stdio: "ignore" });
const origin = `http://127.0.0.1:${port}`;
await new Promise((r) => setTimeout(r, 800));

// The token page renders by query string; audit its address and label states too (no indexer here, so error/not-found states).
const TOKEN = "0x00000000000000000000000000000000000000a1";
let all = [...routes().sort(), `/token/?address=${TOKEN}`, "/?label=moon-cat", `/token/?label=moon-cat`];
if (only?.length) all = all.filter((r) => only.some((o) => r.includes(o)));
if (fast) {
  const seen = new Set();
  all = all.filter((r) => !seen.has(pattern(r)) && seen.add(pattern(r)));
}
const darkDone = new Set();

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const problems = [];
const report = (route, vp, theme, what) => problems.push(`${route} [${vp}${theme === "dark" ? " dark" : ""}] ${what}`);

async function audit(route, vp, theme) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, reducedMotion: "reduce", deviceScaleFactor: 1 });
  if (theme === "dark") await ctx.addInitScript(() => document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("dark")));
  // The first-visit privacy explainer is a modal that rightly takes focus; audits run with it dismissed.
  await ctx.addInitScript(() => localStorage.setItem("varada:privacy", JSON.stringify({ routeIndexer: false, introSeen: true })));
  const page = await ctx.newPage();
  // The audit is offline-safe: nothing but the static server is reachable, so data states are empty or errors.
  await page.route((u) => u.origin !== origin, (r) => r.abort());
  await page.goto(origin + route, { waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.evaluate(axeSource);
  const result = await page.evaluate(() =>
    // eslint-disable-next-line no-undef
    axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } }),
  );
  for (const v of result.violations) {
    // The /design gallery mounts dozens of demo copies of the same landmark components on purpose.
    if (route.startsWith("/design") && v.id === "landmark-unique") continue;
    const nodes = v.nodes.slice(0, 4).map((n) => n.target.join(" ") + (n.any[0]?.message ? ` (${n.any[0].message.slice(0, 90)})` : "")).join("; ");
    report(route, vp.name, theme, `axe ${v.id} [${v.impact}] x${v.nodes.length}: ${nodes}`);
  }
  // Heading order: h1 once, no skipped levels.
  const headings = await page.$$eval("h1,h2,h3,h4,h5,h6", (hs) => hs.filter((h) => h.offsetParent !== null).map((h) => Number(h.tagName[1])));
  if (headings.filter((h) => h === 1).length !== 1) report(route, vp.name, theme, `expected one h1, got ${headings.filter((h) => h === 1).length}`);
  for (let i = 1; i < headings.length; i++) if (headings[i] - headings[i - 1] > 1) report(route, vp.name, theme, `heading jumps h${headings[i - 1]} -> h${headings[i]}`);
  // 44px tap targets on touch width (links inside running prose are exempt, per WCAG 2.5.8 inline exception).
  // (The /design gallery deliberately shows small control variants and a 7px-wide stepper demo; it is exempt from the size checks.)
  const gallery = route.startsWith("/design");
  if (vp.width < 600 && theme === "light" && !gallery) {
    const small = await page.$$eval("a[href],button,[role=button],input:not([type=hidden]),select,textarea,[role=tab]", (els) =>
      els
        .filter((e) => {
          const r = e.getBoundingClientRect();
          const cs = getComputedStyle(e);
          if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || e.closest("[inert],[aria-hidden=true]")) return false;
          if (e.matches(".sr-only,[class*=sr-only]") || e.closest("[data-slot=input-group]")) return false;
          if (e.tagName === "A" && cs.display === "inline" && e.closest("p,li,span:not([class*=flex])") && e.parentElement?.childNodes.length > 1) return false;
          // A pseudo-element hit area (HIT_AREA: after:-inset-1) counts toward the target.
          const after = getComputedStyle(e, "::after");
          const grow = after.position === "absolute" && after.content !== "none" ? [after.top, after.left, after.right, after.bottom].map((v) => Math.max(0, -parseFloat(v) || 0)) : [0, 0, 0, 0];
          // A stretched link (after:inset-0) is as big as its card.
          if (after.position === "absolute" && after.content !== "none" && [after.top, after.left, after.right, after.bottom].every((v) => parseFloat(v) === 0)) return false;
          return r.width + grow[1] + grow[2] < 44 || r.height + grow[0] + grow[3] < 44;
        })
        .slice(0, 6)
        .map((e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""} "${(e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 24)}" ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`),
    );
    for (const s of small) report(route, vp.name, theme, `tap target under 44px: ${s}`);
  }
  // Horizontal scroll.
  const overflow = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const over = document.documentElement.scrollWidth - w;
    if (over <= 0) return null;
    const culprit = [...document.body.querySelectorAll("*")].find((e) => e.getBoundingClientRect().right > w + 1 && !e.closest("[data-slot=marquee],[class*=overflow]"));
    return { over, culprit: culprit ? `${culprit.tagName.toLowerCase()}.${String(culprit.className).slice(0, 60)}` : "?" };
  });
  if (overflow && !gallery) report(route, vp.name, theme, `page scrolls sideways by ${overflow.over}px (${overflow.culprit})`);
  await ctx.close();
}

let pool = [];
const jobs = [];
for (const route of all) {
  for (const vp of VIEWPORTS) {
    jobs.push([route, vp, "light"]);
    if (!darkDone.has(`${pattern(route)}${vp.name}`)) (darkDone.add(`${pattern(route)}${vp.name}`), jobs.push([route, vp, "dark"]));
  }
}
const CONCURRENCY = 4;
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) {
      const [route, vp, theme] = jobs[next++];
      try {
        await audit(route, vp, theme);
      } catch (e) {
        report(route, vp.name, theme, `audit crashed: ${e.message.split("\n")[0]}`);
      }
    }
  }),
);

// Behaviour checks on the home page at both widths.
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  // The first-visit privacy explainer is a modal that rightly takes focus; audits run with it dismissed.
  await ctx.addInitScript(() => localStorage.setItem("varada:privacy", JSON.stringify({ routeIndexer: false, introSeen: true })));
  const page = await ctx.newPage();
  await page.route((u) => u.origin !== origin, (r) => r.abort());
  await page.goto(`${origin}/`, { waitUntil: "load" });
  await page.waitForTimeout(1000);
  // Skip link is the first tab stop and lands on <main>.
  await page.keyboard.press("Tab");
  const first = await page.evaluate(() => ({ text: document.activeElement?.textContent?.trim(), href: document.activeElement?.getAttribute("href") }));
  if (!/skip/i.test(first.text ?? "") || first.href !== "#main") report("/", vp.name, "light", `first Tab stop is not the skip link: ${JSON.stringify(first)}`);
  // Visible focus ring on every tab stop of the first 25.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const e = document.activeElement;
      if (!e || e === document.body) return null;
      const shows = (el) => {
        const c = getComputedStyle(el);
        return (c.outlineStyle !== "none" && parseFloat(c.outlineWidth) > 0) || (c.boxShadow && c.boxShadow !== "none");
      };
      // Inputs inside a group show the ring on the group (focus-within).
      let has = shows(e);
      for (let a = e.parentElement, n = 0; !has && a && n < 3; a = a.parentElement, n++) has = a.matches(":focus-within") && shows(a);
      const hidden = e.closest(".sr-only") && !e.matches(":focus-visible");
      return { has, label: `${e.tagName.toLowerCase()} "${(e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 24)}"`, hidden };
    });
    if (ring && !ring.has) report("/", vp.name, "light", `no visible focus indicator on ${ring.label}`);
  }
  // Command palette: Ctrl/Cmd+K opens a dialog, focus moves inside, Tab stays inside, Escape closes and returns focus.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  const opener = page.locator("body");
  await opener.press("Control+k");
  const dialog = page.getByRole("dialog");
  if (!(await dialog.first().isVisible().catch(() => false))) report("/", vp.name, "light", "Ctrl+K did not open the command palette");
  else {
    const inside = async () => page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"));
    if (!(await inside())) report("/", vp.name, "light", "focus did not move into the command palette");
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      if (!(await inside())) {
        report("/", vp.name, "light", `focus escaped the command palette after ${i + 1} Tab presses`);
        break;
      }
    }
    const named = await dialog.first().evaluate((d) => !!(d.getAttribute("aria-label") || d.getAttribute("aria-labelledby")));
    if (!named) report("/", vp.name, "light", "command palette dialog has no accessible name");
    // axe with the palette open (after its fade-in, which would otherwise read as low contrast).
    await page.waitForTimeout(700);
    await page.evaluate(axeSource);
    const open = await page.evaluate(() => axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] } }));
    for (const v of open.violations) report("/", vp.name, "light", `palette open: axe ${v.id} [${v.impact}] ${v.nodes[0]?.target.join(" ")}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    if (await dialog.first().isVisible().catch(() => false)) report("/", vp.name, "light", "Escape did not close the command palette");
  }
  // Toaster live region exists and is polite.
  const live = await page.evaluate(() => [...document.querySelectorAll("[aria-live]")].map((e) => e.getAttribute("aria-live")));
  if (!live.includes("polite") && !live.includes("assertive")) report("/", vp.name, "light", "no aria-live region for toasts");
  // Reduced motion: no running marquee animation.
  const rmCtx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, reducedMotion: "reduce" });
  const rm = await rmCtx.newPage();
  await rm.route((u) => u.origin !== origin, (r) => r.abort());
  await rm.goto(`${origin}/`, { waitUntil: "load" });
  await rm.waitForTimeout(800);
  const running = await rm.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && (a.effect?.getTiming().iterations === Infinity) && a.effect.getComputedTiming().duration > 100).map((a) => a.animationName ?? a.constructor.name));
  if (running.length) report("/", vp.name, "light", `infinite animations still running under reduced motion: ${[...new Set(running)].join(", ")}`);
  await rmCtx.close();
  await ctx.close();
}

// First visit: the privacy explainer is a modal. Focus goes in, Tab cycles inside, axe is clean, Escape closes it.
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  await page.route((u) => u.origin !== origin, (r) => r.abort());
  await page.goto(`${origin}/`, { waitUntil: "load" });
  await page.waitForTimeout(1200);
  const dlg = page.getByRole("dialog");
  if (!(await dlg.first().isVisible().catch(() => false))) report("/", vp.name, "intro", "first-visit privacy dialog did not open");
  else {
    if (!(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]")))) report("/", vp.name, "intro", "focus did not enter the privacy dialog");
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      if (!(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]")))) {
        report("/", vp.name, "intro", "focus escaped the privacy dialog");
        break;
      }
    }
    await page.waitForTimeout(700);
    await page.evaluate(axeSource);
    const r = await page.evaluate(() => axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] } }));
    for (const v of r.violations) report("/", vp.name, "intro", `privacy dialog open: axe ${v.id} [${v.impact}] ${v.nodes[0]?.target.join(" ")}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    if (await dlg.first().isVisible().catch(() => false)) report("/", vp.name, "intro", "Escape did not close the privacy dialog");
  }
  await ctx.close();
}

await browser.close();
server.kill();
const uniq = [...new Set(problems)];
console.log(`${jobs.length} audits over ${all.length} routes (${VIEWPORTS.map((v) => v.name).join("/")}px), ${uniq.length} problem(s)`);
// Collapse repeated agent pages for readability.
const grouped = new Map();
for (const p of uniq) {
  const key = p.replace(/^\/agent\/[^ ]+/, "/agent/*");
  grouped.set(key, (grouped.get(key) ?? 0) + 1);
}
for (const [k, n] of grouped) console.log(`${n > 1 ? `(x${n}) ` : ""}${k}`);
process.exit(uniq.length ? 1 : 0);
