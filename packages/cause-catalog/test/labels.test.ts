import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { assignLabels, baseLabel, isValidLabel, slugify, truncateSlug, MAX_LABEL_BYTES } from "../src/labels.js";

const oid = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const subj = (n: number, name: string, ein: string | null = String(100000000 + n)) => ({
  id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
  ein,
  name,
  orgId: oid(n),
});

describe("slugify", () => {
  it("transliterates, maps & to and, drops apostrophes and collapses separators", () => {
    expect(slugify("Ärzte ohne Grenzen e.V.")).toBe("arzte-ohne-grenzen-e-v");
    expect(slugify("Boys & Girls Club")).toBe("boys-and-girls-club");
    expect(slugify("St. Mary's  --  Church")).toBe("st-marys-church");
    expect(slugify("Straße Æsir Øresund Łódź")).toBe("strasse-aesir-oresund-lodz");
    expect(slugify("  -- !!! -- ")).toBe("");
    expect(slugify("中国红十字会")).toBe("");
  });
});

describe("baseLabel", () => {
  it("truncates at a hyphen boundary within 63 bytes", () => {
    const long = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const l = baseLabel({ id: "x", ein: null, name: long });
    expect(l.length).toBeLessThanOrEqual(MAX_LABEL_BYTES);
    expect(l.endsWith("-")).toBe(false);
    expect(long.toLowerCase().replace(/ /g, "-").startsWith(l)).toBe(true);
    expect(truncateSlug("abcdefghij", 5)).toBe("abcde");
  });

  it("falls back to org-<ein> or org-<id prefix> for short, empty or non-latin names", () => {
    expect(baseLabel({ id: "abcdef12-3456", ein: "53-0196605", name: "AB" })).toBe("org-530196605");
    expect(baseLabel({ id: "abcdef12-3456", ein: null, name: "红十字会" })).toBe("org-abcdef12");
  });

  it("never yields a purely numeric or xn- label", () => {
    expect(baseLabel({ id: "x", ein: null, name: "1199" })).toBe("org-1199");
    expect(baseLabel({ id: "x", ein: "123456789", name: "xn--abc" })).toBe("org-123456789");
  });
});

describe("assignLabels", () => {
  it("suffixes collisions in Endaoment id order and skips reserved labels", () => {
    const { labelOf, ledger, stats } = assignLabels([subj(3, "Red Cross"), subj(1, "Red Cross"), subj(2, "Red-Cross!"), subj(4, "Admin")]);
    expect(labelOf.get(oid(1))).toBe("red-cross");
    expect(labelOf.get(oid(2))).toBe("red-cross-2");
    expect(labelOf.get(oid(3))).toBe("red-cross-3");
    expect(labelOf.get(oid(4))).toBe("admin-2");
    expect(Object.keys(ledger).sort()).toEqual(["admin-2", "red-cross", "red-cross-2", "red-cross-3"]);
    expect(stats).toMatchObject({ labels: 4, added: 4, carried: 0, suffixed: 3 });
  });

  it("is append-only: existing labels never move, even when an earlier id appears later", () => {
    const first = assignLabels([subj(5, "Food Bank")]);
    const second = assignLabels([subj(1, "Food Bank"), subj(5, "Food Bank")], first.ledger);
    expect(second.labelOf.get(oid(5))).toBe("food-bank");
    expect(second.labelOf.get(oid(1))).toBe("food-bank-2");
    expect(second.stats).toMatchObject({ carried: 1, added: 1 });
    // An org that left the catalogue keeps its label reserved.
    const third = assignLabels([subj(9, "Food Bank")], second.ledger);
    expect(third.ledger["food-bank"]).toBe(oid(5));
    expect(third.labelOf.get(oid(9))).toBe("food-bank-3");
  });

  it("keeps suffixed labels within 63 bytes and valid", () => {
    const name = "a".repeat(70);
    const { labelOf } = assignLabels([subj(1, name), subj(2, name)]);
    for (const l of labelOf.values()) {
      expect(l.length).toBeLessThanOrEqual(MAX_LABEL_BYTES);
      expect(isValidLabel(l)).toBe(true);
    }
    expect(labelOf.get(oid(2))!.endsWith("-2")).toBe(true);
  });

  it("is deterministic regardless of input order", () => {
    const xs = [subj(2, "Hope"), subj(1, "Hope"), subj(3, "Hope")];
    const a = assignLabels(xs).ledger;
    const b = assignLabels([...xs].reverse()).ledger;
    expect(a).toEqual(b);
  });
});
