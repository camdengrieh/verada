// Lab performance check of the static export in headless Chrome with throttling: reports FCP, LCP,
// CLS, request count and bytes (JS and total, as transferred) per route. No dependencies beyond
// Node and a Chrome binary; talks to Chrome over the DevTools protocol.
//
//   node --experimental-websocket scripts/perf-lab.mjs [--runs 3] [--routes /,/launch/,/design/]
//
// Serves out/ itself on a random free port (above 20000) under a Swarm-like /bzz/<ref>/ prefix, so
// it also proves the relative-URL export still resolves. Throttling: 4x CPU slowdown and
// "Fast 3G" (1.6 Mbit/s down, 150 ms RTT) on a 412x823 mobile viewport. Env: CHROME_PATH.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const runs = Number(opt("--runs", "3"));
const verbose = args.includes("--waterfall");
const routes = opt("--routes", "/,/launch/,/causes/,/token/,/design/").split(",");
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PREFIX = "/bzz/" + "ab".repeat(32);

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
async function freePortAbove(min) {
  for (let i = 0; i < 50; i++) {
    const p = await freePort();
    if (p > min) return p;
  }
  throw new Error(`no free port above ${min}`);
}

const sitePort = await freePortAbove(20000);
const cdpPort = await freePortAbove(20000);
const server = spawn(process.execPath, [join(here, "serve-static.mjs"), String(sitePort), PREFIX], { stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "verada-perf-"));
const chrome = spawn(
  chromePath,
  ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--mute-audio", "about:blank"],
  { stdio: "ignore" },
);
const cleanup = () => {
  server.kill();
  chrome.kill();
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  } catch {}
};
process.on("exit", cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: "PUT" });
      return (await res.json()).webSocketDebuggerUrl;
    } catch {
      await sleep(100);
    }
  }
  throw new Error("Chrome did not start");
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method) this.handlers.forEach((h) => h(m));
    };
    this.ready = new Promise((r) => (this.ws.onopen = r));
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const INIT = `
  window.__perf = { lcp: 0, cls: 0, fcp: 0 };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value; }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === "first-contentful-paint") window.__perf.fcp = e.startTime; }).observe({ type: "paint", buffered: true });
`;

async function measure(route) {
  const cdp = new Cdp(await connect());
  await cdp.ready;
  const types = new Map();
  let bytes = 0;
  let jsBytes = 0;
  let requests = 0;
  const urls = new Map();
  const started = new Map();
  let t0;
  cdp.handlers.push((m) => {
    if (m.method === "Network.requestWillBeSent") {
      t0 ??= m.params.timestamp;
      urls.set(m.params.requestId, m.params.request.url.replace(/^.*\/bzz\/[0-9a-f]{64}/, ""));
      started.set(m.params.requestId, m.params.timestamp - t0);
    }
    if (verbose && m.method === "Network.loadingFinished") {
      const id = m.params.requestId;
      console.log(`   ${String(Math.round(started.get(id) * 1000)).padStart(5)} -> ${String(Math.round((m.params.timestamp - t0) * 1000)).padStart(5)} ms  ${String(Math.round(m.params.encodedDataLength / 1024)).padStart(5)} KB  ${urls.get(id)}`);
    }
    if (m.method === "Network.responseReceived") types.set(m.params.requestId, m.params.type);
    if (m.method === "Network.loadingFinished") {
      requests++;
      bytes += m.params.encodedDataLength;
      if (types.get(m.params.requestId) === "Script") jsBytes += m.params.encodedDataLength;
    }
  });
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 823, deviceScaleFactor: 2, mobile: true });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INIT });
  const loaded = new Promise((r) => cdp.handlers.push((m) => m.method === "Page.loadEventFired" && r()));
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${sitePort}${PREFIX}${route}` });
  await loaded;
  await sleep(4000);
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: "JSON.stringify({ ...window.__perf, load: performance.getEntriesByType('navigation')[0].loadEventEnd, text: document.body.innerText.slice(0, 40) })",
    returnByValue: true,
  });
  cdp.ws.close();
  return { ...JSON.parse(result.value), bytes, jsBytes, requests };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log(`throttled: 4x CPU, Fast 3G, 412x823; ${runs} runs, median`);
console.log("route".padEnd(14), "FCP ms".padStart(8), "LCP ms".padStart(8), "load ms".padStart(8), "CLS".padStart(7), "JS".padStart(9), "total".padStart(9), "reqs".padStart(5));
for (const route of routes) {
  const rs = [];
  for (let i = 0; i < runs; i++) rs.push(await measure(route));
  const m = (k) => median(rs.map((r) => r[k]));
  console.log(
    route.padEnd(14),
    String(Math.round(m("fcp"))).padStart(8),
    String(Math.round(m("lcp"))).padStart(8),
    String(Math.round(m("load"))).padStart(8),
    m("cls").toFixed(3).padStart(7),
    kb(m("jsBytes")).padStart(9),
    kb(m("bytes")).padStart(9),
    String(m("requests")).padStart(5),
    "",
    JSON.stringify(rs[0].text),
  );
}
cleanup();
process.exit(0);
