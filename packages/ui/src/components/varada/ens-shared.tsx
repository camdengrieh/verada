// Written for Varada
import { AtSign, CodeXml, FileText, Globe, Hexagon, Image as ImageIcon, MessageCircle, Send, type LucideIcon } from "lucide-react";
import type { WashTone } from "./shared";

/**
 * Helpers shared by the ENS components. Coins live at `<label>.varada.eth` (ENSv2, wildcard
 * resolver); curator agents at `<cause>.agent.varada.eth`. Nothing here talks to a resolver: the app
 * resolves names and passes the results in.
 */

export const ENS_PARENT = "varada.eth";
export const AGENT_PARENT = "agent.varada.eth";

/** "harambe.varada.eth" → { label: "harambe", parent: "varada.eth" }. A bare label gets the Varada parent. */
export function splitEnsName(name: string, defaultParent = ENS_PARENT): { label: string; parent: string } {
  const clean = name.trim().toLowerCase();
  const dot = clean.indexOf(".");
  if (dot < 0) return { label: clean, parent: defaultParent };
  return { label: clean.slice(0, dot), parent: clean.slice(dot + 1) };
}

/** Full name for a label: `harambe` → `harambe.varada.eth`. */
export function ensNameFor(label: string, parent = ENS_PARENT): string {
  return `${label}.${parent}`;
}

/**
 * The eth.limo gateway address for a name (the site is on Swarm and every name carries its
 * contenthash). Only a link target: components never fetch it.
 */
export function ensLimoUrl(name: string): string {
  return `https://${name}.limo`;
}

/** 0x7f3a9c…c21e → "0x7f3a…c21e". Short inputs come back unchanged. */
export function shortenAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** Reasons a label can't be a Varada subname, checked before any availability lookup. */
export type LabelProblem = "empty" | "too-short" | "too-long" | "characters" | "hyphen-edge" | "double-hyphen";

export const LABEL_PROBLEM_TEXT: Record<LabelProblem, string> = {
  empty: "Type a name to check it",
  "too-short": "Names need at least 3 characters",
  "too-long": "Names can be at most 63 characters",
  characters: "Use lowercase letters a–z, digits and hyphens only",
  "hyphen-edge": "Names can't start or end with a hyphen",
  "double-hyphen": "Names can't have two hyphens in the third and fourth places",
};

/** Lowercases and trims what was typed; a pasted full name keeps only its label. */
export function normalizeLabel(input: string): string {
  const trimmed = input.trim().toLowerCase();
  return trimmed.endsWith(`.${ENS_PARENT}`) ? trimmed.slice(0, -(ENS_PARENT.length + 1)) : trimmed;
}

/**
 * The launchpad's label rules (a strict ASCII subset of ENS normalisation, so every claimed label
 * is also a valid DNS label for `<label>.varada.eth.limo`). Returns null when the label is fine.
 */
export function labelProblem(label: string): LabelProblem | null {
  if (label.length === 0) return "empty";
  if (!/^[a-z0-9-]+$/.test(label)) return "characters";
  if (label.length < 3) return "too-short";
  if (label.length > 63) return "too-long";
  if (label.startsWith("-") || label.endsWith("-")) return "hyphen-edge";
  if (label.slice(2, 4) === "--") return "double-hyphen";
  return null;
}

/** Text record keys Varada writes, in display order, with their icons and labels. */
export const TEXT_RECORDS: Record<string, { label: string; icon: LucideIcon; prefix?: string }> = {
  description: { label: "Description", icon: FileText },
  url: { label: "Website", icon: Globe },
  avatar: { label: "Avatar", icon: ImageIcon },
  "com.twitter": { label: "X (Twitter)", icon: AtSign, prefix: "@" },
  "org.telegram": { label: "Telegram", icon: Send, prefix: "@" },
  "com.discord": { label: "Discord", icon: MessageCircle },
  "com.github": { label: "GitHub", icon: CodeXml },
  "varada.logo": { label: "Coin logo", icon: Hexagon },
};

export const TEXT_RECORD_ORDER = Object.keys(TEXT_RECORDS);

export function textRecordMeta(key: string): { label: string; icon: LucideIcon; prefix?: string } {
  return TEXT_RECORDS[key] ?? { label: key, icon: FileText };
}

/** A stable pigment for an address or name, so avatar fallbacks don't jump between renders. */
export function toneFor(seed: string): WashTone {
  const tones: WashTone[] = ["sage", "ochre", "sky", "terracotta", "etf"];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return tones[h % tones.length] ?? "sage";
}
