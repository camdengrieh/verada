import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useRel as useDiscoverRel } from "@/components/discover/hooks";
import { useSiteRel } from "@/components/governance/use-rel";
import { SiteRootContext } from "@/lib/site-root";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "out");

function Links() {
  const siteRel = useSiteRel();
  const discoverRel = useDiscoverRel();
  return (
    <>
      <a href={siteRel("token/")}>a</a>
      <a href={discoverRel("/causes/")}>b</a>
    </>
  );
}

describe("server-rendered links carry the route depth", () => {
  it.each([
    ["./", "./token/", "./causes/"],
    ["../", "../token/", "../causes/"],
    ["../../", "../../token/", "../../causes/"],
    ["../../../", "../../../token/", "../../../causes/"],
  ])("under root %s", (root, token, causes) => {
    // renderToString runs no effects, so this is exactly what the prerender emits.
    const html = renderToString(
      <SiteRootContext.Provider value={root}>
        <Links />
      </SiteRootContext.Provider>,
    );
    expect(html).toContain(`href="${token}"`);
    expect(html).toContain(`href="${causes}"`);
  });
});

/** Internal href/src targets in an HTML page: no scheme, fragment-only or protocol-relative URLs. */
function internalRefs(html: string): string[] {
  const refs = [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1] ?? "");
  return refs.filter((h) => h !== "" && !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(h));
}

function resolves(pageFile: string, ref: string): boolean {
  const path = ref.split(/[?#]/)[0] ?? "";
  if (path === "") return true;
  const target = resolve(dirname(pageFile), decodeURIComponent(path));
  if (!target.startsWith(out)) return false;
  if (existsSync(target) && statSync(target).isFile()) return true;
  return existsSync(join(target, "index.html")) || existsSync(`${target}.html`);
}

const PAGES = ["causes/index.html", "governance/index.html", "agent/index.html", "token/index.html", "agent/children/index.html"];

describe.skipIf(!existsSync(join(out, "index.html")))("built export (run pnpm build first)", () => {
  it.each(PAGES)("every internal href and src in %s resolves relative to the page", (page) => {
    const file = join(out, page);
    expect(existsSync(file)).toBe(true);
    const missing = internalRefs(readFileSync(file, "utf8")).filter((h) => !resolves(file, h));
    expect(missing).toEqual([]);
  });
});
