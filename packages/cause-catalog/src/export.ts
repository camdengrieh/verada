import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hex } from "viem";
import type { BuiltCatalog } from "./build.js";
import { encodeCcipRequest, encodeCcipResponse } from "./ccip.js";
import { NamesIndex } from "./names.js";

/** Swarm chunk payload size. */
export const SWARM_CHUNK_BYTES = 4096;
/** Rough manifest overhead per file (mantaray fork + metadata). */
export const MANIFEST_CHUNKS_PER_FILE = 2;

export interface CcipExportStats {
  files: number;
  shards: number;
  totalBytes: number;
  largest: { shard: number; file: string; bytes: number; entries: number };
  emptyShards: number;
  /** Per file `ceil(bytes / 4096) + 2`, summed. */
  swarmChunks: { data: number; manifest: number; total: number };
  namesRoot: Hex;
}

/**
 * Writes the CCIP-Read fallback as static files: `ccip/<abi.encode(uint256 shard)>.json` holding
 * `{"data": abi.encode(root, shard, entries, proof)}` for every shard (empty ones too, so absence is
 * answered), and `l2-fallback.json` = `{"data":"0x"}`. Upload `out` as one Swarm collection and use
 * `https://<gateway>/bzz/<ref>/ccip/{data}.json` as the resolver URL.
 */
export async function exportCcip(catalog: BuiltCatalog, outDir: string): Promise<CcipExportStats> {
  if (!catalog.names || !catalog.meta.namesRoot) throw new Error("catalogue has no names; rebuild it");
  const idx = new NamesIndex(catalog.names.shards);
  if (idx.root !== catalog.meta.namesRoot) throw new Error("names root mismatch");
  const dir = join(outDir, "ccip");
  await mkdir(dir, { recursive: true });

  const chunks = (bytes: number) => Math.ceil(bytes / SWARM_CHUNK_BYTES);
  let totalBytes = 0;
  let dataChunks = 0;
  let emptyShards = 0;
  let largest = { shard: -1, file: "", bytes: -1, entries: 0 };
  const writes: Promise<void>[] = [];
  const flush = async () => {
    await Promise.all(writes);
    writes.length = 0;
  };
  for (let shard = 0; shard < idx.shardCount; shard++) {
    const p = idx.shardProof(shard)!;
    const file = `${encodeCcipRequest(shard)}.json`;
    const body = JSON.stringify({ data: encodeCcipResponse(idx.root, p) });
    const bytes = Buffer.byteLength(body);
    totalBytes += bytes;
    dataChunks += chunks(bytes);
    if (p.entries.length === 0) emptyShards++;
    if (bytes > largest.bytes) largest = { shard, file: `ccip/${file}`, bytes, entries: p.entries.length };
    writes.push(writeFile(join(dir, file), body));
    if (writes.length >= 64) await flush();
  }
  const fallback = JSON.stringify({ data: "0x" });
  writes.push(writeFile(join(outDir, "l2-fallback.json"), fallback));
  await flush();
  totalBytes += Buffer.byteLength(fallback);
  dataChunks += chunks(Buffer.byteLength(fallback));
  const files = idx.shardCount + 1;
  const manifest = files * MANIFEST_CHUNKS_PER_FILE;
  return {
    files,
    shards: idx.shardCount,
    totalBytes,
    largest,
    emptyShards,
    swarmChunks: { data: dataChunks, manifest, total: dataChunks + manifest },
    namesRoot: idx.root,
  };
}
