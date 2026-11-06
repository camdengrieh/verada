// Headless check of the private read path: opens the running app in Chrome, starts the anon-rpc
// worker without a wallet (the "Also route Varada API requests" switch in the header pill) and
// reports the worker's boot log and the pill's state. Expects:
//   - the app at BASE_URL (default http://127.0.0.1:3000/): `pnpm dev`, or a served static export
//   - playwright-core on the module path and a Chrome binary (CHROME_PATH), as scripts/e2e.mjs
// WAIT_MS caps the wait for the worker (default 120000). Exit code 0 once the pill says
// "Private RPC on", 1 otherwise. Not part of the default test run.
import { chromium } from "playwright-core";

const base = process.env.BASE_URL ?? process.argv[2] ?? "http://127.0.0.1:3000/";
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const waitMs = Number(process.env.WAIT_MS ?? 120_000);
const t0 = Date.now();
const at = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage();
const seen = new Set();
page.on("console", (m) => {
  const text = m.text();
  if (/\[worker\]|anon-rpc|specifier|bootstrap/i.test(text) && !seen.has(text)) {
    seen.add(text);
    console.log(`${at()} console.${m.type()}: ${text.slice(0, 240)}`);
  }
});
page.on("pageerror", (e) => console.log(`${at()} pageerror: ${e.message.slice(0, 240)}`));
page.on("request", (r) => {
  const u = r.url();
  if (!u.startsWith(base) && !/^blob:|\/_next\//.test(u) && !/localhost|127\.0\.0\.1/.test(u)) {
    console.log(`${at()} request: ${r.method()} ${u.slice(0, 140)}`);
  }
});

console.log(`${at()} opening ${base}`);
await page.goto(base, { waitUntil: "domcontentloaded", timeout: 240_000 });
await page.waitForTimeout(3000);

const pillState = async () => {
  const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  return body.match(/(Connecting privately|Private RPC on(?: · [^.]+)?|Private RPC failed|Not anonymised)/)?.[0] ?? "";
};

// First visit: the "Private by default" intro dialog.
const intro = page.getByRole("dialog").filter({ hasText: /Private by default/ });
if (await intro.count()) {
  await intro.getByRole("button").last().click();
  await page.waitForTimeout(400);
}
// The header pill opens the privacy controls; the routing switch calls rpc.start().
await page.getByText(/Connecting privately|Private RPC on|Private RPC failed|Not anonymised/).first().click();
await page.waitForTimeout(600);
const panel = (await page.getByRole("status").allInnerTexts().catch(() => [])).find((t) => /Private RPC|Connecting to/.test(t));
console.log(`${at()} panel: "${panel ?? "(not found)"}"`);
const sw = page.getByRole("switch", { name: /Also route Varada API requests/i });
if (await sw.count()) {
  if ((await sw.first().getAttribute("aria-checked")) !== "true") await sw.first().click();
  console.log(`${at()} private routing on: the worker starts now`);
} else {
  console.log(`${at()} routing switch not found; waiting for a chain read to start the worker`);
}
await page.keyboard.press("Escape");

let last = "";
const deadline = Date.now() + waitMs;
while (Date.now() < deadline) {
  const s = await pillState();
  if (s !== last) {
    console.log(`${at()} pill: "${s}"`);
    last = s;
  }
  if (/Private RPC on|Private RPC failed|Not anonymised/.test(s)) break;
  await page.waitForTimeout(1000);
}
const failure = last.startsWith("Private RPC failed")
  ? (await page.getByRole("status").allInnerTexts().catch(() => [])).find((t) => /unavailable/.test(t))
  : undefined;
if (failure) console.log(`${at()} ${failure}`);
await browser.close();
const ok = last.startsWith("Private RPC on");
console.log(`${at()} ${ok ? "OK" : "NOT READY"}: ${last || "no pill state"}`);
process.exit(ok ? 0 : 1);
