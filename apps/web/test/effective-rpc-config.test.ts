import { describe, expect, it } from "vitest";
import type { PrivateRpcConfig } from "@/lib/config";
import { effectivePrivateRpcConfig } from "@/lib/effective-rpc-config";
import type { PrivacyPrefs } from "@/lib/privacy-prefs";

const base: PrivateRpcConfig = {
  network: "nox",
  specifier: "0x00000000000000000000000000000000000000c5",
  workerConfig: { gateways: ["wss://gw.example"] },
  rpcUrls: ["https://a.example", "https://b.example/"],
  bootstrapRpcUrl: "https://sepolia.example",
};
const none: PrivacyPrefs = { routeIndexer: false, introSeen: false };

describe("effectivePrivateRpcConfig", () => {
  it("is the build's config when nothing is set", () => {
    expect(effectivePrivateRpcConfig(base, none)).toEqual({ ...base, rpcUrls: ["https://a.example", "https://b.example"] });
  });

  it("puts the user's RPCs first and de-duplicates", () => {
    const cfg = effectivePrivateRpcConfig(base, { ...none, rpcUrls: ["https://mine.example", "https://b.example"] });
    expect(cfg.rpcUrls).toEqual(["https://mine.example", "https://b.example", "https://a.example"]);
    expect(cfg.network).toBe("nox");
    expect(cfg.specifier).toBe(base.specifier);
  });

  it("drops invalid user entries", () => {
    const cfg = effectivePrivateRpcConfig(base, { ...none, rpcUrls: ["http://plain.example", "https://ok.example/"] });
    expect(cfg.rpcUrls).toEqual(["https://ok.example", "https://a.example", "https://b.example"]);
  });

  it("uses only the user's RPCs in direct mode", () => {
    const cfg = effectivePrivateRpcConfig(base, { ...none, rpcUrls: ["https://mine.example"], directMode: true });
    expect(cfg.rpcUrls).toEqual(["https://mine.example"]);
    // Direct mode without an endpoint of the user's own is not direct mode.
    expect(effectivePrivateRpcConfig(base, { ...none, directMode: true }).rpcUrls).toEqual(["https://a.example", "https://b.example"]);
  });

  it("applies a chosen network and drops the build network's own settings", () => {
    const cfg = effectivePrivateRpcConfig(base, { ...none, network: "nym" });
    expect(cfg.network).toBe("nym");
    expect(cfg).not.toHaveProperty("specifier");
    expect(cfg).not.toHaveProperty("workerConfig");
    expect(cfg).not.toHaveProperty("bootstrapRpcUrl");
    // Choosing the build's own network changes nothing.
    expect(effectivePrivateRpcConfig(base, { ...none, network: "nox" }).specifier).toBe(base.specifier);
  });

  it("does not modify its inputs", () => {
    const prefs: PrivacyPrefs = { ...none, rpcUrls: ["https://mine.example"], network: "tor-js" };
    const before = JSON.stringify([base, prefs]);
    effectivePrivateRpcConfig(base, prefs);
    expect(JSON.stringify([base, prefs])).toBe(before);
  });
});
