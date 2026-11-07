import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Serves the built export (out/) like a Swarm manifest (exact paths and directory indexes, 404.html
// as the error document) at a root and under /bzz/<ref>/, then crawls every internal link, script,
// stylesheet and preload from every page. Needs `pnpm --filter @varada/web build` first; skipped
// when out/ does not exist so a plain `vitest run` stays hermetic.
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
const built = existsSync(join(out, "index.html")) && existsSync(join(out, "404.html"));
const REF = "cd".repeat(32);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};

function serve(prefix: string): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      const send = (status: number, file: string) => {
        res.writeHead(status, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
        res.end(readFileSync(file));
      };
      const notFound = () => send(404, join(out, "404.html"));
      if (!path.startsWith(`${prefix}/`)) return notFound();
      const rel = normalize(path.slice(prefix.length)).replace(/^(\.\.[/\\])+/, "");
      let file = join(out, rel);
      if (existsSync(file) && statSync(file).isDirectory()) {
        if (!path.endsWith("/")) {
          res.writeHead(301, { location: `${path}/` });
          return res.end();
        }
        file = join(file, "index.html");
      }
      if (existsSync(file) && statSync(file).isFile()) return send(200, file);
      notFound();
    }).listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

/** href/src values of every tag that loads or links to something (srcset and inline url() excluded). */
function references(html: string): string[] {
  const found: string[] = [];
  for (const m of html.matchAll(/<(a|link|script|img|source|iframe)\b[^>]*>/gi)) {
    for (const a of m[0].matchAll(/\s(?:href|src)=("([^"]*)"|'([^']*)')/gi)) found.push(a[2] ?? a[3] ?? "");
  }
  return found;
}

/** Every directory in out/ holding an index.html, as a site-relative URL path ("" for the root). */
function pagePaths(dir = out, rel = ""): string[] {
  const found = existsSync(join(dir, "index.html")) ? [rel] : [];
  for (const name of readdirSync(dir)) {
    if (name === "_next" || name === "assets") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) found.push(...pagePaths(p, `${rel}${name}/`));
  }
  return found;
}

async function crawl(origin: string, prefix: string) {
  const start = `${origin}${prefix}/`;
  const seen = new Set<string>();
  // The prerendered HTML carries no anchors (navigation is rendered client-side), so seed every page
  // directly; this still checks each page's own scripts, styles, preloads and assets.
  const queue = [start, ...pagePaths().map((p) => `${start}${p}`)];
  const failures: string[] = [];
  const escaped: string[] = [];
  while (queue.length) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const res = await fetch(url, { redirect: "follow" });
    if (res.status !== 200) {
      failures.push(`${res.status} ${url}`);
      continue;
    }
    if (!(res.headers.get("content-type") ?? "").includes("text/html")) continue;
    const html = await res.text();
    for (const ref of references(html)) {
      if (/^(mailto:|tel:|data:|javascript:|#)/i.test(ref) || ref === "") continue;
      const target = new URL(ref, url);
      if (target.origin !== origin) continue; // external links are not served from the export
      if (!target.pathname.startsWith(`${prefix}/`)) {
        escaped.push(`${url} -> ${ref}`);
        continue;
      }
      target.hash = "";
      // Query strings (?label=, ?agent=) are client-side; the file served is the same.
      queue.push(target.href);
    }
  }
  return { pages: seen.size, failures, escaped };
}

describe.skipIf(!built)("static export crawl", () => {
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  describe.each([
    ["site root", ""],
    ["a /bzz/<ref> path gateway", `/bzz/${REF}`],
  ])("served at %s", (_name, prefix) => {
    let origin = "";
    beforeAll(async () => {
      const s = await serve(prefix);
      servers.push(s.server);
      origin = s.origin;
    });

    it("every internal link, script, stylesheet and asset resolves and stays under the prefix", async () => {
      const { pages, failures, escaped } = await crawl(origin, prefix);
      expect(pages).toBeGreaterThan(150);
      expect(failures).toEqual([]);
      expect(escaped).toEqual([]);
    }, 120_000);

    it("serves the token page and agent pages that client-side routing reads ?label= and ?agent= from", async () => {
      for (const path of ["/token/?label=pepe", "/agent/?agent=homeless", "/agent/homeless/"]) {
        const res = await fetch(`${origin}${prefix}${path}`);
        expect(res.status, path).toBe(200);
        expect(await res.text(), path).toContain("<html");
      }
    });

    it("answers unknown paths with the self-contained 404 document", async () => {
      const res = await fetch(`${origin}${prefix}/no-such-page/deeper/`);
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain("Page not found");
      expect(html).not.toMatch(/\s(?:src|href)="(?!\.\/|data:|#)[^"]*\.(js|css)"/);
    });

    it("loads lazy chunks relative to the runtime script, not from /_next/", async () => {
      const chunks = (await (await fetch(`${origin}${prefix}/`)).text()).match(/_next\/static\/chunks\/webpack-[^"']+\.js/);
      expect(chunks).not.toBeNull();
      const runtime = await (await fetch(`${origin}${prefix}/${chunks![0]}`)).text();
      expect(runtime).not.toContain('.p="/_next/"');
      expect(runtime).toContain("document.currentScript");
    });
  });
});
