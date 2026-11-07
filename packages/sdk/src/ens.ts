import {
  decodeAbiParameters,
  encodeFunctionData,
  getAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { getEnsAddress, getEnsText, labelhash, namehash, normalize, packetToBytes } from "viem/ens";
import { ENS_V2_ADDRESSES } from "./addresses.js";

/** Parent ENS name every token gets a subname under. */
export const ENS_PARENT_NAME = "varada.eth" as const;

/** Shortest label the on-chain registry accepts (`LabelLib.MIN_LENGTH`). */
export const LABEL_MIN_LENGTH = 3;
/** Longest label the on-chain registry accepts (`LabelLib.MAX_LENGTH`, the DNS wire limit). */
export const LABEL_MAX_LENGTH = 63;

/** Text record key the resolver synthesizes from the on-chain logo reference. */
export const LOGO_TEXT_KEY = "varada.logo" as const;

/** Standard ENS text record keys the token page reads and the controller may set. */
export const TOKEN_TEXT_KEYS = {
  url: "url",
  description: "description",
  avatar: "avatar",
  twitter: "com.twitter",
  telegram: "org.telegram",
  discord: "com.discord",
  github: "com.github",
} as const;

/**
 * Mirrors `LabelLib.isValid` exactly: 3–63 bytes of `[a-z0-9-]`, no leading or trailing hyphen,
 * and not hyphens at both positions 3 and 4 (the `xn--` slot).
 */
export function isValidLabel(label: string): boolean {
  if (label.length < LABEL_MIN_LENGTH || label.length > LABEL_MAX_LENGTH) return false;
  if (!/^[a-z0-9-]+$/.test(label)) return false;
  if (label.startsWith("-") || label.endsWith("-")) return false;
  if (label.length >= 4 && label[2] === "-" && label[3] === "-") return false;
  return true;
}

/** Throws unless `label` is valid; returns it unchanged. */
export function validateLabel(label: string): string {
  if (!isValidLabel(label)) throw new Error(`invalid label "${label}"`);
  return label;
}

/**
 * Derives a default label from a token symbol: lowercase, non `[a-z0-9]` runs become single
 * hyphens, edges trimmed, the `xn--` slot and the length bounds fixed up. Returns null when
 * nothing usable remains (the creator must type a label).
 */
export function labelFromSymbol(symbol: string): string | null {
  let label = symbol
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (label.length === 0) return null;
  if (label.length >= 4 && label[2] === "-" && label[3] === "-") {
    label = `${label.slice(0, 2)}-${label.slice(4)}`.replace(/^-+|-+$/g, "");
  }
  if (label.length < LABEL_MIN_LENGTH) label = `${label}-token`;
  if (label.length > LABEL_MAX_LENGTH) label = label.slice(0, LABEL_MAX_LENGTH).replace(/-+$/g, "");
  return isValidLabel(label) ? label : null;
}

/**
 * The coin's label, derived from its token name. This is the only label the launch wizard offers,
 * so a name can't be launched twice (the registry rejects a taken label) and copycats can't pick a
 * look-alike. Rules mirror `LabelLib.isValid`:
 * - NFKD with accents stripped, lowercase, and `&` becomes `and`;
 * - runs of anything outside `[a-z0-9]` become one hyphen, with the edges trimmed;
 * - the `xn--` slot is fixed up;
 * - over 63 bytes is cut at a hyphen boundary.
 * Returns null when fewer than 3 characters remain (the creator must change the name). There is
 * no padding, so the label is always recognisably the name.
 */
export function labelFromName(name: string): string | null {
  let label = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (label.length >= 4 && label[2] === "-" && label[3] === "-") {
    label = `${label.slice(0, 2)}-${label.slice(4)}`.replace(/^-+|-+$/g, "");
  }
  if (label.length > LABEL_MAX_LENGTH) {
    const cut = label.slice(0, LABEL_MAX_LENGTH + 1);
    const at = cut.lastIndexOf("-");
    label = (at >= LABEL_MIN_LENGTH ? cut.slice(0, at) : label.slice(0, LABEL_MAX_LENGTH)).replace(/-+$/g, "");
  }
  return isValidLabel(label) ? label : null;
}

/**
 * Labels no coin may take: the namespaces under the parent (`org.`, `coin.`, `donor.`, `agent.`,
 * `names.`) and the brand names. The registry reserves the on-chain ones, and the wizard also blocks
 * them client-side in case the registry read fails.
 */
export const RESERVED_LABELS = ["org", "coin", "donor", "agent", "names", "endaoment", "varada"] as const;

export const isReservedLabel = (label: string): boolean => (RESERVED_LABELS as readonly string[]).includes(label);

/** Namespace coins are shown under: `<label>.coin.<parent>`. */
export const COIN_NAMESPACE = "coin" as const;

/** `coin.<parent>` */
export const coinParentName = (parent: string = ENS_PARENT_NAME): string => `${COIN_NAMESPACE}.${parent}`;

/** `<label>.coin.<parent>`, the name a coin is shown and resolved under. */
export function coinEnsName(label: string, parent: string = ENS_PARENT_NAME): string {
  return `${validateLabel(label)}.${coinParentName(parent)}`;
}

/** `<label>.<parent>` */
export function tokenEnsName(label: string, parent: string = ENS_PARENT_NAME): string {
  return `${validateLabel(label)}.${parent}`;
}

/** `keccak256(label)` as used by the registry (`tokenByLabelhash`). */
export function tokenLabelhash(label: string): Hex {
  return labelhash(validateLabel(label));
}

/** ENS node of `<label>.<parent>` as used by the registry (`tokenByNode`). */
export function tokenNode(label: string, parent: string = ENS_PARENT_NAME): Hex {
  return namehash(tokenEnsName(label, parent));
}

/** ENS node of the parent name. */
export function parentNode(parent: string = ENS_PARENT_NAME): Hex {
  return namehash(normalize(parent));
}

/** DNS wire-format encoding of a name, as passed to ENSIP-10 `resolve(bytes,bytes)`. */
export function dnsEncode(name: string): Hex {
  const bytes = packetToBytes(normalize(name));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Known gateways that serve ENS names over HTTPS, as hostname suffixes. */
export const ENS_GATEWAY_SUFFIXES = [".eth.limo", ".eth.link", ".bzz.link"] as const;

export interface GatewayHostname {
  /** Gateway suffix that was matched (e.g. `.eth.limo`). */
  gateway: (typeof ENS_GATEWAY_SUFFIXES)[number];
  /** Full ENS name the hostname represents (e.g. `pepe.varada.eth`). */
  ensName: string;
  /** Token label when the hostname is a subname of the parent, else null. */
  label: string | null;
  /**
   * Curator agent label for `<cause>.agent.<parent>` (null when malformed), `""` for the agents
   * index `agent.<parent>`; absent otherwise.
   */
  agent?: string | null;
}

/**
 * Parses a gateway hostname into the ENS name it serves and, if it is a direct subname of
 * `parent`, the token label. `pepe.varada.eth.limo` → `{ ensName: "pepe.varada.eth",
 * label: "pepe" }`; `varada.eth.limo` → label null; unrelated hosts → null. Labels that fail the
 * on-chain rules return null for `label` so callers fall back to the main page.
 */
export function parseGatewayHostname(
  hostname: string,
  parent: string = ENS_PARENT_NAME,
): GatewayHostname | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  const parentLabels = parent.toLowerCase().split(".");
  const parentWithoutTld = parentLabels.slice(0, -1).join(".");
  for (const gateway of ENS_GATEWAY_SUFFIXES) {
    if (!host.endsWith(gateway)) continue;
    const head = host.slice(0, -gateway.length);
    if (head.length === 0) return null;
    // `.eth.limo` / `.eth.link` already carry the TLD; `.bzz.link` serves `<name-without-.eth>`.
    const ensName = gateway === ".bzz.link" ? `${head}.eth` : `${head}.eth`;
    const expectedParent = gateway === ".bzz.link" ? parentWithoutTld : parentWithoutTld;
    if (head === expectedParent) return { gateway, ensName, label: null };
    const suffix = `.${expectedParent}`;
    if (!head.endsWith(suffix)) return { gateway, ensName, label: null };
    const label = head.slice(0, -suffix.length);
    // `<cause>.agent.<parent>`: a curator agent's page; `agent.<parent>`: the agents index.
    if (label === "agent") return { gateway, ensName, label: null, agent: "" };
    if (label.endsWith(".agent") && !label.slice(0, -".agent".length).includes(".")) {
      const agent = label.slice(0, -".agent".length);
      return { gateway, ensName, label: null, agent: isValidLabel(agent) ? agent : null };
    }
    if (label.includes(".")) return { gateway, ensName, label: null };
    return { gateway, ensName, label: isValidLabel(label) ? label : null };
  }
  return null;
}

const universalResolverAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes result, address resolver)",
]);
const contenthashAbi = parseAbi(["function contenthash(bytes32 node) view returns (bytes)"]);

/** Resolves `<label>.<parent>` to the token address through the Universal Resolver (ENSIP-10). */
export async function getTokenAddressByLabel(
  client: PublicClient,
  label: string,
  parent: string = ENS_PARENT_NAME,
): Promise<Address | null> {
  const address = await getEnsAddress(client, {
    name: normalize(tokenEnsName(label, parent)),
    universalResolverAddress: ENS_V2_ADDRESSES.universalResolver,
  });
  return address && address !== zeroAddress ? getAddress(address) : null;
}

/** Reads a text record of `<label>.<parent>` through the Universal Resolver. */
export async function getTokenTextRecord(
  client: PublicClient,
  label: string,
  key: string,
  parent: string = ENS_PARENT_NAME,
): Promise<string | null> {
  return getEnsText(client, {
    name: normalize(tokenEnsName(label, parent)),
    key,
    universalResolverAddress: ENS_V2_ADDRESSES.universalResolver,
  });
}

/** Reads the contenthash of any name through the Universal Resolver (`0x` when unset). */
export async function getEnsContenthash(client: PublicClient, name: string): Promise<Hex> {
  const normalized = normalize(name);
  const call = encodeFunctionData({
    abi: contenthashAbi,
    functionName: "contenthash",
    args: [namehash(normalized)],
  });
  const [result] = await client.readContract({
    address: ENS_V2_ADDRESSES.universalResolver,
    abi: universalResolverAbi,
    functionName: "resolve",
    args: [dnsEncode(normalized), call],
  });
  const [hash] = decodeAbiParameters([{ type: "bytes" }], result);
  return hash;
}
