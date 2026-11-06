import { describe, expect, it } from "vitest";
import { checkRpcUrl, directModeActive, parseRpcUrlList, readPrivacyPrefs, writePrivacyPrefs } from "@/lib/privacy-prefs";
import { PRIVACY_ROUTES } from "@/lib/privacy-routes";

describe("privacy prefs", () => {
  it("defaults to routing off and the intro unseen", () => {
    expect(readPrivacyPrefs({ getItem: () => null })).toEqual({ routeIndexer: false, introSeen: false });
    expect(readPrivacyPrefs({ getItem: () => "not json" })).toEqual({ routeIndexer: false, introSeen: false });
  });

  it("reads older saved prefs without the intro flag", () => {
    expect(readPrivacyPrefs({ getItem: () => JSON.stringify({ routeIndexer: true }) })).toEqual({ routeIndexer: true, introSeen: false });
  });

  it("round-trips, and survives blocked storage", () => {
    let saved = "";
    writePrivacyPrefs({ routeIndexer: true, introSeen: true }, { setItem: (_k, v) => void (saved = v) });
    expect(readPrivacyPrefs({ getItem: () => saved })).toEqual({ routeIndexer: true, introSeen: true });
    expect(() =>
      writePrivacyPrefs({ routeIndexer: false, introSeen: true }, {
        setItem: () => {
          throw new Error("blocked");
        },
      }),
    ).not.toThrow();
  });
});

describe("connection settings in privacy prefs", () => {
  const stored = (v: unknown) => ({ getItem: () => JSON.stringify(v) });

  it("accepts https, and http only for this machine", () => {
    expect(checkRpcUrl(" https://rpc.example/v3/key/ ")).toEqual({ url: "https://rpc.example/v3/key" });
    expect(checkRpcUrl("http://localhost:8545")).toEqual({ url: "http://localhost:8545" });
    expect(checkRpcUrl("http://127.0.0.1:8545/")).toEqual({ url: "http://127.0.0.1:8545" });
    expect(checkRpcUrl("http://[::1]:8545")).toEqual({ url: "http://[::1]:8545" });
    expect(checkRpcUrl("http://rpc.example")).toHaveProperty("error");
    expect(checkRpcUrl("wss://rpc.example")).toHaveProperty("error");
    expect(checkRpcUrl("rpc.example")).toHaveProperty("error");
    expect(checkRpcUrl("https://user:pw@rpc.example")).toHaveProperty("error");
    expect(checkRpcUrl("https://rpc.example/?key=1")).toHaveProperty("error");
    expect(checkRpcUrl("https://rpc.example/?")).toHaveProperty("error");
  });

  it("parses one URL per line, reporting each bad line and more than five", () => {
    expect(parseRpcUrlList("https://a.example\n\n https://a.example/ \nhttps://b.example")).toEqual({
      urls: ["https://a.example", "https://b.example"],
      errors: [],
    });
    const bad = parseRpcUrlList("http://a.example\nhttps://ok.example");
    expect(bad.urls).toEqual(["https://ok.example"]);
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0]).toMatch(/^http:\/\/a\.example must use https/);
    const many = parseRpcUrlList([1, 2, 3, 4, 5, 6].map((n) => `https://r${n}.example`).join("\n"));
    expect(many.errors).toEqual(["Use at most 5 endpoints."]);
  });

  it("drops invalid stored values silently and keeps at most five endpoints", () => {
    const prefs = readPrivacyPrefs(
      stored({
        routeIndexer: true,
        rpcUrls: ["https://a.example/", "nonsense", 7, "https://a.example", "https://b.example", "https://c.example", "https://d.example", "https://e.example", "https://f.example"],
        network: "carrier-pigeon",
        directMode: true,
      }),
    );
    expect(prefs).toEqual({
      routeIndexer: true,
      introSeen: false,
      rpcUrls: ["https://a.example", "https://b.example", "https://c.example", "https://d.example", "https://e.example"],
      directMode: true,
    });
    expect(readPrivacyPrefs(stored({ network: "nym" })).network).toBe("nym");
  });

  it("never reads direct mode as on without an endpoint", () => {
    const prefs = readPrivacyPrefs(stored({ directMode: true, rpcUrls: ["http://not-local.example"] }));
    expect(prefs).toEqual({ routeIndexer: false, introSeen: false });
    expect(directModeActive(prefs)).toBe(false);
    expect(directModeActive({ ...prefs, rpcUrls: ["https://a.example"], directMode: true })).toBe(true);
  });

  it("writes only well-formed values", () => {
    let saved = "";
    writePrivacyPrefs(
      { routeIndexer: false, introSeen: true, rpcUrls: ["https://a.example/", "ftp://x"], network: "tor-js", directMode: true },
      { setItem: (_k, v) => void (saved = v) },
    );
    expect(JSON.parse(saved)).toEqual({ routeIndexer: false, introSeen: true, rpcUrls: ["https://a.example"], network: "tor-js", directMode: true });
  });
});

describe("privacy routes", () => {
  it("covers what stays off the mixnet", () => {
    const direct = PRIVACY_ROUTES.filter((r) => r.kind === "direct").map((r) => r.id);
    expect(direct).toEqual(expect.arrayContaining(["indexer", "zama-relayer"]));
    expect(PRIVACY_ROUTES.find((r) => r.id === "zama-relayer")!.sees).toMatch(/never your choice/);
    expect(PRIVACY_ROUTES.find((r) => r.id === "transactions")!.kind).toBe("wallet");
  });
});
