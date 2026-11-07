import type { Hex } from "viem";

/**
 * ENS labels for `<label>.org.varada.eth`. A label is an ASCII slug of the org name, so it is
 * already ENSIP-15 normalized. Labels are append-only: once a label is in the ledger it keeps
 * pointing at the same orgId forever (an org that leaves the catalogue keeps its label reserved).
 */

/** Maximum label length in bytes (labels are ASCII, so bytes = characters). */
export const MAX_LABEL_BYTES = 63;
/** Shorter slugs fall back to `org-<ein or id prefix>`. */
export const MIN_LABEL_CHARS = 3;

/** Labels never assigned to an org. */
export const RESERVED_LABELS: ReadonlySet<string> = new Set([
  "www",
  "app",
  "api",
  "admin",
  "varada",
  "endaoment",
  "agent",
  "org",
  "gateway",
  "docs",
  "mail",
  "root",
]);

/** `label -> orgId`. The published ledger of every label ever assigned. */
export type LabelLedger = Record<string, Hex>;

/** Letters NFKD does not decompose into ASCII. */
const TRANSLIT: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
};

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Whether `label` has the shape this module produces (does not check the reserved list). */
export function isValidLabel(label: string): boolean {
  return (
    label.length >= MIN_LABEL_CHARS &&
    label.length <= MAX_LABEL_BYTES &&
    LABEL_RE.test(label) &&
    !label.includes("--") &&
    !/^\d+$/.test(label)
  );
}

/** Cuts `s` to at most `max` characters, at the last hyphen when that keeps it long enough. */
export function truncateSlug(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const hyphen = cut.lastIndexOf("-");
  const out = hyphen >= MIN_LABEL_CHARS ? cut.slice(0, hyphen) : cut;
  return out.replace(/-+$/, "");
}

/** Lowercase ASCII slug of a name: `[a-z0-9-]`, hyphens collapsed and trimmed (may be empty). */
export function slugify(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (c) => TRANSLIT[c] ?? c)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/&/g, " and ")
    .replace(/['’‘`´]/g, "");
  return ascii
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface LabelSubject {
  /** Endaoment id (uuid). */
  id: string;
  ein: string | null;
  name: string;
  orgId: Hex;
}

/** The preferred label of an org before collisions: its slug, or `org-<ein or id prefix>`. */
export function baseLabel(o: Pick<LabelSubject, "id" | "ein" | "name">): string {
  let s = truncateSlug(slugify(o.name), MAX_LABEL_BYTES);
  if (/^\d+$/.test(s)) s = truncateSlug(`org-${s}`, MAX_LABEL_BYTES);
  if (s.length < MIN_LABEL_CHARS || s.startsWith("xn-")) {
    const ein = o.ein?.replace(/\D/g, "");
    s = `org-${ein || o.id.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase()}`;
  }
  return s;
}

export interface LabelAssignment {
  /** Previous ledger plus every newly assigned label. */
  ledger: LabelLedger;
  /** Label of every org in `orgs` (each gets exactly one). */
  labelOf: Map<Hex, string>;
  stats: { labels: number; carried: number; added: number; suffixed: number; fallback: number };
}

/**
 * Gives every org a label. Orgs already in `previous` keep their label; new orgs are processed in
 * Endaoment id order and take their base label, or `<base>-2`, `<base>-3`... when it is taken or
 * reserved. Nothing in `previous` is ever reassigned or removed.
 */
export function assignLabels(orgs: readonly LabelSubject[], previous: LabelLedger = {}): LabelAssignment {
  const ledger: LabelLedger = { ...previous };
  const existing = new Map<string, string>();
  for (const [label, orgId] of Object.entries(previous)) {
    const k = orgId.toLowerCase();
    // An org with several ledger labels (should not happen) keeps the first in sorted order.
    const cur = existing.get(k);
    if (cur === undefined || label < cur) existing.set(k, label);
  }

  const labelOf = new Map<Hex, string>();
  const stats = { labels: 0, carried: 0, added: 0, suffixed: 0, fallback: 0 };
  const fresh: LabelSubject[] = [];
  for (const o of orgs) {
    const carried = existing.get(o.orgId.toLowerCase());
    if (carried !== undefined) {
      labelOf.set(o.orgId, carried);
      stats.carried++;
    } else {
      fresh.push(o);
    }
  }

  const taken = (l: string) => RESERVED_LABELS.has(l) || Object.prototype.hasOwnProperty.call(ledger, l);
  for (const o of [...fresh].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (labelOf.has(o.orgId)) continue; // duplicate orgId in the input
    const base = baseLabel(o);
    if (base.startsWith("org-") && !slugify(o.name).startsWith("org-")) stats.fallback++;
    let label = base;
    for (let n = 2; taken(label); n++) {
      const suffix = `-${n}`;
      label = `${truncateSlug(base, MAX_LABEL_BYTES - suffix.length)}${suffix}`;
    }
    if (label !== base) stats.suffixed++;
    ledger[label] = o.orgId;
    labelOf.set(o.orgId, label);
    stats.added++;
  }
  stats.labels = labelOf.size;
  return { ledger, labelOf, stats };
}
