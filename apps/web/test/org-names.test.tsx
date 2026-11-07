import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CATEGORIES } from "@varada/sdk";
import { OrgNameSearch, OrgNamesStat } from "@/components/names";
import { IndexerClient } from "@/lib/indexer";
import {
  AGENT_NAME_COUNT,
  agentNames,
  fetchNamesCount,
  matchAgentNames,
  namePaths,
  normalizeNameQuery,
  parseNamesCount,
  toNameHits,
} from "@/lib/org-names";

class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", Observer);
vi.stubGlobal("ResizeObserver", Observer);

const fetchMock = vi.fn();
const indexer = () => new IndexerClient(["https://idx.example"], { fetchImpl: fetchMock as unknown as typeof fetch });
vi.mock("@/components/providers", () => ({
  useDeps: () => ({ indexer: indexer(), chain: () => { throw new Error("unused"); } }),
  useAppConfig: () => ({ ensParentName: "varada.eth" }),
}));

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const ROOT = `0x${"5e".repeat(32)}`;
const org = (i: number, over: Record<string, unknown> = {}) => ({
  orgId: `0x${String(i).padStart(64, "0")}`,
  causeId: `0x${String(i).padStart(64, "c")}`,
  ein: `52090762${i}`,
  name: `Red Cross ${i}`,
  country: "USA",
  state: "DC",
  nteeCode: null,
  categories: ["disaster-relief"],
  regions: ["north-america"],
  label: `red-cross-${i}`,
  ...over,
});

const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
const urls = () => fetchMock.mock.calls.map((c) => new URL(c[0] as string));

beforeEach(() => {
  fetchMock.mockReset();
});

describe("org names data", () => {
  it("lists agent.<parent> and one name per curator agent, from the SDK taxonomy", () => {
    const names = agentNames("varada.eth");
    expect(names[0]).toEqual({ name: "agent.varada.eth", title: "Curator agents", slug: null, path: "agent/" });
    expect(names).toHaveLength(1 + CATEGORIES.filter((c) => c.ensLabel).length);
    expect(AGENT_NAME_COUNT).toBe(names.length);
    expect(names).toContainEqual(expect.objectContaining({ name: "hunger.agent.varada.eth", path: "agent/hunger/" }));
    expect(matchAgentNames("hunger", "varada.eth").map((a) => a.name)).toEqual(["hunger.agent.varada.eth"]);
    expect(matchAgentNames("h", "varada.eth")).toEqual([]);
  });

  it("parses the names count and never invents one", () => {
    expect(parseNamesCount({ names: { count: 239881, root: ROOT, shardBits: 12 } })).toEqual({
      orgNames: 239881,
      agentNames: AGENT_NAME_COUNT,
      total: 239881 + AGENT_NAME_COUNT,
      namesRoot: ROOT,
    });
    // An older indexer (no `names`), a build without names, or junk: unknown.
    expect(parseNamesCount({ orgs: 30 })).toBeNull();
    expect(parseNamesCount({ names: null })).toBeNull();
    expect(parseNamesCount({ names: { count: -1 } })).toBeNull();
    expect(parseNamesCount({ names: { count: "12" } })).toBeNull();
  });

  it("answers null when the indexer has no catalogue and throws on other errors", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "catalog_unavailable" }, 503));
    expect(await fetchNamesCount(indexer())).toBeNull();
    fetchMock.mockResolvedValueOnce(json({ names: { count: 3, root: ROOT, shardBits: 12 } }));
    expect((await fetchNamesCount(indexer()))?.orgNames).toBe(3);
    expect(urls().at(-1)?.pathname).toBe("/api/catalog");
    fetchMock.mockResolvedValueOnce(json({}, 400));
    await expect(fetchNamesCount(indexer())).rejects.toThrow();
  });

  it("normalizes queries, keeps only labelled orgs and builds relative paths", () => {
    expect(normalizeNameQuery("  Red   CROSS ")).toBe("red cross");
    expect(normalizeNameQuery("x".repeat(150))).toHaveLength(100);
    const hits = toNameHits([org(1) as never, org(2, { label: null }) as never], "varada.eth");
    expect(hits.map((h) => h.ensName)).toEqual(["red-cross-1.org.varada.eth"]);
    expect(namePaths.donate(`0x${"AB".repeat(32)}`)).toBe(`donate/?org=0x${"ab".repeat(32)}`);
    expect(namePaths.catalogue("red-cross-1")).toBe("causes/?q=red-cross-1");
    expect(namePaths.cause("disaster-relief")).toBe("causes/?category=disaster-relief");
  });
});

describe("OrgNamesStat", () => {
  it("shows the charity names plus the agent names from /api/catalog", async () => {
    fetchMock.mockResolvedValue(json({ names: { count: 239881, root: ROOT, shardBits: 12 } }));
    wrap(<OrgNamesStat animate={false} />);
    const total = new Intl.NumberFormat("en-US").format(239881 + AGENT_NAME_COUNT);
    await waitFor(() => expect(screen.getByText(total)).toBeInTheDocument());
    expect(screen.getByText("Registered ENS names")).toBeInTheDocument();
    expect(screen.getByText(/239,881 charities under org\.varada\.eth/)).toBeInTheDocument();
  });

  it("counts charity names only with includeAgents={false}, inline", async () => {
    fetchMock.mockResolvedValue(json({ names: { count: 1234, root: ROOT, shardBits: 12 } }));
    const { container } = wrap(<OrgNamesStat variant="inline" includeAgents={false} label="charity names" />);
    await waitFor(() => expect(screen.getByText("1,234")).toBeInTheDocument());
    expect(screen.getByText("charity names")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="org-names-stat"]')).not.toBeNull();
  });

  it("shows a dash, not a number, while the count is unknown", async () => {
    fetchMock.mockResolvedValue(json({ error: "catalog_unavailable" }, 503));
    wrap(<OrgNamesStat animate={false} />);
    await waitFor(() => expect(screen.getByText("The count is unavailable right now.")).toBeInTheDocument());
    expect(screen.getByText("–")).toBeInTheDocument();
  });

  it("renders nothing inline while the count is unknown", async () => {
    fetchMock.mockResolvedValue(json({ orgs: 30 }));
    const { container } = wrap(<OrgNamesStat variant="inline" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-slot="org-names-stat"]')).toBeNull());
  });
});

describe("OrgNameSearch", () => {
  function routeSearch(total: number) {
    fetchMock.mockImplementation(async (u: string) => {
      const url = new URL(u);
      if (url.pathname !== "/api/catalog/search") return json({}, 404);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const n = Math.max(0, Math.min(limit, total - offset));
      return json({ items: Array.from({ length: n }, (_, i) => org(offset + i + 1)), total, offset, limit });
    });
  }

  it("searches the indexer, shows names with relative links, and pages", async () => {
    routeSearch(25);
    wrap(<OrgNameSearch root="../" />);
    fireEvent.change(screen.getByLabelText("Search charity names"), { target: { value: "  Red Cross " } });
    await waitFor(() => expect(screen.getByText("25 names match “red cross”")).toBeInTheDocument());
    const first = urls()[0]!;
    expect(first.pathname).toBe("/api/catalog/search");
    expect(first.searchParams.get("q")).toBe("red cross");
    expect(first.searchParams.get("limit")).toBe("20");

    const list = screen.getByRole("list", { name: "Charity names" });
    const items = () => list.querySelectorAll<HTMLElement>(":scope > li");
    expect(items()).toHaveLength(20);
    const card = items()[0]!;
    expect(within(card).getByText("red-cross-1")).toBeInTheDocument();
    expect(within(card).getByRole("heading", { name: "Red Cross 1" })).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Give to Red Cross 1" })).toHaveAttribute("href", `../donate/?org=${org(1).orgId}`);
    expect(within(card).getByRole("link", { name: "Red Cross 1 in the catalogue" })).toHaveAttribute("href", "../causes/?q=red-cross-1");
    expect(within(card).getByRole("link", { name: /All .* charities/ })).toHaveAttribute("href", "../causes/?category=disaster-relief");

    fireEvent.click(screen.getByRole("button", { name: "More names" }));
    await waitFor(() => expect(items()).toHaveLength(25));
    expect(urls().at(-1)?.searchParams.get("offset")).toBe("20");
    expect(screen.queryByRole("button", { name: "More names" })).toBeNull();
  });

  it("does not query below two letters and matches agent names locally", async () => {
    routeSearch(0);
    wrap(<OrgNameSearch />);
    const input = screen.getByLabelText("Search charity names");
    fireEvent.change(input, { target: { value: "h" } });
    expect(screen.getByText(/Type at least 2 letters/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 300));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "hunger" } });
    await waitFor(() => expect(screen.getByRole("link", { name: "Open hunger.agent.varada.eth" })).toBeInTheDocument());
    // Agent names count in the total; the org search had nothing.
    await waitFor(() => expect(screen.getByText("1 name matches “hunger”")).toBeInTheDocument());
    expect(screen.queryByText("No names match")).toBeNull();
  });

  it("says when nothing matches, when the catalogue is unavailable, and when the search fails", async () => {
    routeSearch(0);
    const { unmount } = wrap(<OrgNameSearch includeAgents={false} defaultQuery="zzzz" />);
    await waitFor(() => expect(screen.getByText("No names match")).toBeInTheDocument());
    unmount();

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json({ error: "catalog_unavailable" }, 503));
    const second = wrap(<OrgNameSearch defaultQuery="red" />);
    await waitFor(() => expect(screen.getByText("Name search is unavailable right now")).toBeInTheDocument());
    second.unmount();

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json({ error: "bad" }, 400));
    wrap(<OrgNameSearch defaultQuery="red" />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });
});

describe("Causes page", () => {
  it("shows the name count and the name search next to the catalogue", async () => {
    const { CausesExplorer } = await import("@/components/causes/causes-explorer");
    fetchMock.mockImplementation(async (u: string) => {
      const url = new URL(u);
      if (url.pathname === "/api/catalog") return json({ root: ROOT, orgs: 2, entries: 2, categories: [], regions: [], names: { count: 2, root: ROOT, shardBits: 12 } });
      if (url.pathname === "/api/catalog/search") return json({ items: [], total: 0 });
      return json({}, 404);
    });
    wrap(<CausesExplorer />);
    const section = await screen.findByRole("region", { name: "Find a charity's name" });
    const total = new Intl.NumberFormat("en-US").format(2 + AGENT_NAME_COUNT);
    await waitFor(() => expect(within(section).getByText(total)).toBeInTheDocument());
    expect(within(section).getByLabelText("Search charity names")).toBeInTheDocument();
  });
});
