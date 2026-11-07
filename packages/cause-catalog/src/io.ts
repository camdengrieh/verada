import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { namesFromOrgs, type BuiltCatalog, type CatalogMeta, type CatalogNames, type CatalogOrg, type Leaf } from "./build.js";
import type { Overrides } from "./classify.js";
import type { LabelLedger } from "./labels.js";

/** File names of a published catalogue directory (uploaded to Swarm as one collection). */
export const CATALOG_FILES = {
  meta: "catalog.json",
  orgs: "orgs.jsonl",
  tree: "tree.json",
  labels: "labels.json",
} as const;

export async function writeCatalog(dir: string, c: BuiltCatalog): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, CATALOG_FILES.meta), JSON.stringify(c.meta, null, 2));
  await writeFile(join(dir, CATALOG_FILES.orgs), c.orgs.map((o) => JSON.stringify(o)).join("\n") + "\n");
  await writeFile(join(dir, CATALOG_FILES.tree), JSON.stringify(c.tree.dump()));
  if (c.names) {
    // The shards are rebuilt from orgs.jsonl on read and checked against meta.namesRoot.
    await writeFile(join(dir, CATALOG_FILES.labels), JSON.stringify(sortedLedger(c.names.ledger), null, 0));
  }
}

const sortedLedger = (l: LabelLedger): LabelLedger =>
  Object.fromEntries(Object.entries(l).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) as LabelLedger;

/** Reads a label ledger (`labels.json`), or null when the file does not exist. */
export async function readLabels(path: string): Promise<LabelLedger | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LabelLedger;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function parseNames(meta: CatalogMeta, orgs: CatalogOrg[], labelsText: string | null): CatalogNames | undefined {
  if (labelsText === null || !meta.namesRoot || !meta.namesShardBits) return undefined;
  const shards = namesFromOrgs(orgs, meta.namesShardBits);
  if (shards.tree.root !== meta.namesRoot) {
    throw new Error(`names root rebuilt from orgs.jsonl ${shards.tree.root} does not match catalog.json ${meta.namesRoot}`);
  }
  return { ledger: JSON.parse(labelsText) as LabelLedger, shards };
}

const readOptional = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
};

export async function readCatalog(dir: string): Promise<BuiltCatalog> {
  const meta = JSON.parse(await readFile(join(dir, CATALOG_FILES.meta), "utf8")) as CatalogMeta;
  const orgs = (await readFile(join(dir, CATALOG_FILES.orgs), "utf8"))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CatalogOrg);
  const tree = StandardMerkleTree.load<Leaf>(JSON.parse(await readFile(join(dir, CATALOG_FILES.tree), "utf8")));
  if (tree.root !== meta.root) throw new Error(`tree root ${tree.root} does not match catalog.json ${meta.root}`);
  const names = parseNames(meta, orgs, await readOptional(join(dir, CATALOG_FILES.labels)));
  return names ? { meta, orgs, tree, names } : { meta, orgs, tree };
}

/**
 * Loads a published catalogue from a directory or an http(s) base URL (for example
 * `https://<gateway>/bzz/<swarmRef>`), checking the tree against `catalog.json`'s root.
 */
export async function loadCatalog(source: string, fetchFn: typeof fetch = (...a) => globalThis.fetch(...a)): Promise<BuiltCatalog> {
  if (!/^https?:\/\//.test(source)) return readCatalog(source);
  const base = source.replace(/\/+$/, "");
  const get = async (name: string) => {
    const res = await fetchFn(`${base}/${name}`);
    if (!res.ok) throw new Error(`catalogue ${name}: HTTP ${res.status}`);
    return res.text();
  };
  const getOptional = async (name: string) => {
    const res = await fetchFn(`${base}/${name}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`catalogue ${name}: HTTP ${res.status}`);
    return res.text();
  };
  const [metaText, orgsText, treeText, labelsText] = await Promise.all([
    get(CATALOG_FILES.meta),
    get(CATALOG_FILES.orgs),
    get(CATALOG_FILES.tree),
    getOptional(CATALOG_FILES.labels),
  ]);
  const meta = JSON.parse(metaText) as CatalogMeta;
  const orgs = orgsText.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as CatalogOrg);
  const tree = StandardMerkleTree.load<Leaf>(JSON.parse(treeText));
  if (tree.root !== meta.root) throw new Error(`tree root ${tree.root} does not match catalog.json ${meta.root}`);
  const names = parseNames(meta, orgs, labelsText);
  return names ? { meta, orgs, tree, names } : { meta, orgs, tree };
}

export async function readOverrides(path: string): Promise<Overrides> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Overrides;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { orgs: {} };
    throw e;
  }
}
