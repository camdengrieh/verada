import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createIndexerClient } from "../src/indexer-client.js";

const TOKEN = "0x000000000000000000000000000000000000AA01" as Hex;
const A = `0x${"ab".repeat(32)}` as Hex;
const B = `0x${"CD".repeat(32)}` as Hex;

const respond = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("indexer client: epochOrgIds", () => {
  it("reads optionOrgIds from the epoch detail route, lowercased", async () => {
    const fetch = respond(200, { epoch: "4", options: [], optionOrgIds: [A, B] });
    const c = createIndexerClient("https://api.varada.test/", { fetch: fetch as typeof globalThis.fetch });
    expect(await c.epochOrgIds(TOKEN, 4n)).toEqual([A, B.toLowerCase()]);
    expect(fetch).toHaveBeenCalledWith(`https://api.varada.test/api/epochs/${TOKEN.toLowerCase()}/4`, expect.anything());
  });

  it("is null for an unknown epoch, an empty list or an older indexer without the field", async () => {
    for (const [status, body] of [
      [404, { error: "not_found" }],
      [200, { optionOrgIds: [] }],
      [200, { options: [A] }],
    ] as const) {
      const c = createIndexerClient("https://api.varada.test", { fetch: respond(status, body) as typeof globalThis.fetch });
      expect(await c.epochOrgIds(TOKEN, 4n)).toBeNull();
    }
  });

  it("rejects server errors and malformed ids", async () => {
    const down = createIndexerClient("https://api.varada.test", { fetch: respond(503, {}) as typeof globalThis.fetch });
    await expect(down.epochOrgIds(TOKEN, 4n)).rejects.toThrow(/HTTP 503/);
    const bad = createIndexerClient("https://api.varada.test", { fetch: respond(200, { optionOrgIds: ["0x12"] }) as typeof globalThis.fetch });
    await expect(bad.epochOrgIds(TOKEN, 4n)).rejects.toThrow();
  });
});

describe("indexer client: catalogEntries", () => {
  const body = { root: A, items: [{ bucket: 3, index: 1, orgId: B, proof: [A] }] };

  it("asks for the ballot's catalogue root when given, and the main snapshot otherwise", async () => {
    const fetch = respond(200, body);
    const c = createIndexerClient("https://api.varada.test", { fetch: fetch as typeof globalThis.fetch });
    expect((await c.catalogEntries([{ bucket: 3, index: 1 }], A)).items[0]!.orgId).toBe(B.toLowerCase());
    await c.catalogEntries([{ bucket: 3, index: 1 }]);
    const urls = (fetch.mock.calls as unknown as [string][]).map(([u]) => u);
    expect(urls[0]).toBe(`https://api.varada.test/api/catalog/entries?at=3%3A1&root=${A}`);
    expect(urls[1]).toBe("https://api.varada.test/api/catalog/entries?at=3%3A1");
  });

  it("names the missing snapshot when the indexer does not serve the root", async () => {
    const c = createIndexerClient("https://api.varada.test", { fetch: respond(404, { error: "catalog_root_unavailable" }) as typeof globalThis.fetch });
    const err = await c.catalogEntries([{ bucket: 3, index: 1 }], A).catch((e: unknown) => e);
    expect((err as Error).name).toBe("CatalogMismatch");
    expect((err as Error).message).toMatch(/no catalogue snapshot with root/);
    const down = createIndexerClient("https://api.varada.test", { fetch: respond(503, {}) as typeof globalThis.fetch });
    await expect(down.catalogEntries([{ bucket: 3, index: 1 }], A)).rejects.toThrow(/HTTP 503/);
  });
});
