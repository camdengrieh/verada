import { describe, expect, it } from "vitest";
import { readPrivacyPrefs, writePrivacyPrefs } from "@/lib/privacy-prefs";
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

describe("privacy routes", () => {
  it("covers what stays off the mixnet", () => {
    const direct = PRIVACY_ROUTES.filter((r) => r.kind === "direct").map((r) => r.id);
    expect(direct).toEqual(expect.arrayContaining(["indexer", "zama-relayer"]));
    expect(PRIVACY_ROUTES.find((r) => r.id === "zama-relayer")!.sees).toMatch(/never your choice/);
    expect(PRIVACY_ROUTES.find((r) => r.id === "transactions")!.kind).toBe("wallet");
  });
});
