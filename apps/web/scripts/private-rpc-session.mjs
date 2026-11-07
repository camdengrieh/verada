// Headless-Chrome session with an injected EIP-6963 wallet (fresh random key, never funded) against
// the running app (BASE_URL, default http://127.0.0.1:3000/). It connects the wallet, walks the main
// pages and records every network request, then greps URLs, bodies and headers for the viewer's
// address in every encoding that matters (checksummed, lower case, bare hex, 32-byte padded).
//   MODE=normal   the anon worker boots; expects the pill to reach "Private RPC on"
//   MODE=blocked  the bootstrap (Sepolia specifier) RPCs are blocked; expects the pill to fail closed, no direct
//                 chain request before the opt-in, and the opt-in to load public data only
// Exit code 0 when no request carries the address and the mode's expectations hold.
// Needs playwright-core and Chrome (CHROME_PATH), as private-rpc-check.mjs. Not part of the default run.
import { chromium } from "playwright-core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const base = process.env.BASE_URL ?? process.argv[2] ?? "http://127.0.0.1:3000/";
const mode = process.env.MODE ?? "normal";
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const waitMs = Number(process.env.WAIT_MS ?? 90_000);
const origin = new URL(base).origin;
const account = privateKeyToAccount(generatePrivateKey());
const addr = account.address;
const needles = [addr, addr.toLowerCase(), addr.slice(2), addr.slice(2).toLowerCase(), addr.slice(2).toLowerCase().padStart(64, "0")];
const t0 = Date.now();
const at = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const log = (...a) => console.log(at(), ...a);

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const ctx = await browser.newContext();
await ctx.addInitScript((address) => {
  const provider = {
    request: async ({ method }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
      if (method === "eth_chainId") return "0x1";
      if (method === "net_version") return "1";
      if (method === "wallet_switchEthereumChain") return null;
      throw Object.assign(new Error("not supported by the headless test wallet"), { code: 4200 });
    },
    on() {},
    removeListener() {},
  };
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: Object.freeze({ info: { uuid: "00000000-0000-4000-8000-0000000000aa", name: "Headless Test Wallet", icon: "data:image/svg+xml;base64,PHN2Zy8+", rdns: "test.varada.session" }, provider }),
      }),
    );
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}, addr);

const page = await ctx.newPage();
const requests = [];
page.on("request", (r) => requests.push({ at: Date.now() - t0, method: r.method(), url: r.url(), body: r.postData() ?? "", headers: JSON.stringify(r.headers()) }));
page.on("pageerror", (e) => log("pageerror:", e.message.slice(0, 200), (e.stack ?? "").split("\n")[1] ?? ""));
if (process.env.DEBUG_CONSOLE) page.on("console", (m) => log("console." + m.type() + ":", m.text().slice(0, 200)));
if (mode === "blocked") await ctx.route(/sepolia/, (route) => route.abort());

const pill = async () => {
  const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  return body.match(/(Connecting privately|Private RPC on(?: · [^.]+)?|Private RPC failed|Not anonymised|Direct)/)?.[0] ?? "";
};
const dismissIntro = async () => {
  const intro = page.getByRole("dialog").filter({ hasText: /Private by default/ });
  if (await intro.count()) await intro.getByRole("button").last().click().catch(() => {});
};

await page.goto(base, { waitUntil: "domcontentloaded", timeout: 240_000 });
await page.getByRole("dialog").or(page.getByRole("button", { name: /Connect wallet/i })).first().waitFor({ timeout: 60_000 }).catch(async () => {
  log("page never showed a dialog or the connect button; body:", (await page.locator("body").innerText().catch(() => "")).slice(0, 300));
  process.exit(2);
});
await dismissIntro();
await page.waitForTimeout(500);
// The injected wallet is usually reconnected on load; otherwise press the header button.
await page.getByRole("button", { name: new RegExp(addr.slice(0, 6)) }).or(page.getByRole("button", { name: /Connect wallet/i })).first().waitFor({ timeout: 30_000 });
if (await page.getByRole("button", { name: /Connect wallet/i }).count()) await page.getByRole("button", { name: /Connect wallet/i }).first().click();
await page.waitForTimeout(1500);
const connected = (await page.locator("body").innerText()).includes(addr.slice(0, 6));
log("wallet connected:", connected);

let state = "";
const deadline = Date.now() + waitMs;
while (Date.now() < deadline) {
  state = await pill();
  if (/Private RPC on|Private RPC failed|Not anonymised/.test(state)) break;
  await page.waitForTimeout(1000);
}
log("pill:", JSON.stringify(state));

let optInSeen = false;
if (mode === "blocked") {
  const before = requests.length;
  await page.getByText(/Private RPC failed|Connecting privately/).first().click().catch(() => {});
  await page.waitForTimeout(800);
  const optIn = page.getByRole("button", { name: /Load public data directly/i });
  optInSeen = (await optIn.count()) > 0;
  log("direct-read opt-in button shown:", optInSeen);
  const chainHost = /publicnode|reth\.rs|llamarpc|cloudflare-eth|infura|alchemy/;
  const direct = requests.slice(0, requests.length).filter((r) => chainHost.test(r.url) && !/sepolia/.test(r.url));
  log("direct mainnet RPC requests before opt-in:", direct.length);
  if (optInSeen) {
    await optIn.first().click();
    await page.waitForTimeout(500);
    log("note shown:", (await page.getByRole("note").allInnerTexts()).join(" | ").slice(0, 160));
    const mark = requests.length;
    await page.keyboard.press("Escape");
    await page.goto(base + "causes/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(8000);
    log("pill after opt-in:", JSON.stringify(await pill()), "new requests:", requests.length - mark, "before:", before);
  }
}

for (const path of ["causes/", "governance/", "launch/", "agent/", ""]) {
  await page.goto(base + path, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(4000);
  log("visited", path || "/", "pill:", JSON.stringify(await pill()));
}

const hosts = new Map();
for (const r of requests) {
  const u = new URL(r.url);
  if (u.protocol === "data:" || u.protocol === "blob:") continue;
  const h = u.origin === origin ? "(app)" : u.host;
  hosts.set(h, (hosts.get(h) ?? 0) + 1);
}
log("hosts contacted:", JSON.stringify([...hosts.entries()]));
const leaks = requests.filter((r) => needles.some((n) => (r.url + r.body + r.headers).toLowerCase().includes(n.toLowerCase())));
log(`requests total ${requests.length}; carrying the viewer address: ${leaks.length}`);
for (const l of leaks.slice(0, 5)) log("LEAK", l.method, l.url.slice(0, 160));
await browser.close();

const stateOk = mode === "blocked" ? /Private RPC failed|Not anonymised|Connecting/.test(state) && optInSeen : /Private RPC on/.test(state);
const ok = leaks.length === 0 && connected && stateOk;
log(ok ? "OK" : "FAILED");
process.exit(ok ? 0 : 1);
