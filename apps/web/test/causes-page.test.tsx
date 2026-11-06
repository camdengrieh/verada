import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CausesExplorer } from "@/components/causes/causes-explorer";
import { leaderboardEntries } from "@/components/causes/causes-leaderboard";
import { CatalogBrowser } from "@/components/catalog-browser";
import { IndexerClient } from "@/lib/indexer";

class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", Observer);
vi.stubGlobal("ResizeObserver", Observer);

const fetchMock = vi.fn();
vi.mock("@/components/providers", () => ({
  useDeps: () => ({ indexer: new IndexerClient(["https://idx.example"], { fetchImpl: fetchMock as unknown as typeof fetch }), chain: () => { throw new Error("unused"); } }),
  useAppConfig: () => ({ ensParentName: "varada.eth" }),
}));

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const org = (i: number, over = {}) => ({ orgId: `0x${i}`, causeId: `0xca${i}`, ein: null, name: `Org ${i}`, country: "KEN", state: null, nteeCode: null, categories: ["hunger"], regions: ["africa"], ...over });

function route(url: string) {
  const u = new URL(url);
  switch (u.pathname) {
    case "/api/catalog":
      return json({ root: "0x1", orgs: 30, entries: 60, categories: [{ slug: "hunger", label: "Hunger", bit: 2, orgs: 30 }], regions: [{ slug: "africa", label: "Africa", bit: 0, orgs: 30 }] });
    case "/api/catalog/search": {
      const offset = Number(u.searchParams.get("offset") ?? 0);
      return json({ items: Array.from({ length: Math.min(24, 30 - offset) }, (_, i) => org(offset + i)), total: 30 });
    }
    case "/api/causes/leaderboard":
      return json({ totals: { causes: 1, donations: 2, donated: "9000000" }, items: [{ rank: 1, causeId: "0xca1", donated: "9000000", donations: 2, tokens: 1, org: { orgId: "0x1", name: "Food Bank", ein: null, country: null, categories: ["hunger"], regions: [] } }], byCategory: [{ slug: "hunger", donated: "9000000", donations: 2, causes: 1 }], nextCursor: null });
    case "/api/stats":
      return json({ donatedUsdc: "9000000" });
    case "/api/agents":
      return json({ items: [] });
    default:
      return json({}, 404);
  }
}

const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => route(url));
  window.history.replaceState(null, "", "/causes/");
});

describe("leaderboardEntries", () => {
  it("names causes from the catalogue and converts USDC to dollars", () => {
    const [a, b] = leaderboardEntries([
      { rank: 1, causeId: "0xca1", donated: 12_500_000n, donatedEth: 0n, donations: 1, tokens: 1, org: { orgId: "0x1", name: "Food Bank", ein: null, country: null, categories: ["homelessness"], regions: [] } },
      { rank: 2, causeId: "0x1234567890abcdef1234", donated: 1n, donatedEth: 0n, donations: 3, tokens: 2, org: null },
    ]);
    expect(a).toMatchObject({ name: "Food Bank", raised: 12.5, cause: "homeless", sub: "1 gift from 1 coin" });
    expect(b!.name).toMatch(/^Cause 0x1234/);
    expect(b!.sub).toBe("3 gifts from 2 coins");
  });
});

describe("CausesExplorer", () => {
  it("shows catalogue totals, the leaderboard and the first page of charities, then loads more", async () => {
    wrap(<CausesExplorer />);
    await waitFor(() => expect(screen.getByText("Food Bank")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("30 organizations, showing 24")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Where the fees go" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getByText("30 organizations")).toBeInTheDocument());
    expect(screen.getByText("Org 29")).toBeInTheDocument();
  });

  it("reads filters from the query string and shows the category hero", async () => {
    window.history.replaceState(null, "", "/causes/?category=hunger&region=africa");
    wrap(<CausesExplorer />);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Hunger & famine" })).toBeInTheDocument());
    const chips = screen.getByRole("list", { name: "Active filters" });
    expect(within(chips).getByText("Hunger & famine")).toBeInTheDocument();
    expect(within(chips).getByText("Africa")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes("categories=hunger") && String(u).includes("regions=africa"))).toBe(true));
  });

  it("toggles a category tile and keeps the filter in the URL", async () => {
    wrap(<CausesExplorer />);
    const grid = await screen.findByRole("list", { name: "Cause categories" });
    fireEvent.click(within(grid).getByRole("button", { name: /Hunger & famine/ }));
    await waitFor(() => expect(window.location.search).toBe("?category=hunger"));
    expect(within(grid).getByRole("button", { name: /Hunger & famine/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("links each category tile to its curator agent from the site root, not the page directory", async () => {
    window.history.replaceState(null, "", "/bzz/abc123/causes/");
    wrap(<CausesExplorer />);
    const grid = await screen.findByRole("list", { name: "Cause categories" });
    const link = within(grid).getAllByRole("link", { name: /Curator agent/ })[0]!;
    expect(link.getAttribute("href")).toMatch(/^\/bzz\/abc123\/agent\/[a-z-]+\/$/);
    expect(link.getAttribute("href")).not.toContain("/causes/");
  });

  it("says so when the catalogue is not loaded (503)", async () => {
    fetchMock.mockImplementation(async (url: string) => (new URL(url).pathname.startsWith("/api/catalog") ? json({ error: "catalog_unavailable" }, 503) : route(url)));
    wrap(<CausesExplorer />);
    await waitFor(() => expect(screen.getByText("The cause catalogue is not available")).toBeInTheDocument());
  });
});

describe("CatalogBrowser", () => {
  it("hands a chosen organization to the caller", async () => {
    const onSelect = vi.fn();
    wrap(<CatalogBrowser onSelect={onSelect} selectLabel="Pin" />);
    fireEvent.click(await screen.findByRole("button", { name: "Pin Org 0" }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: "Org 0" }));
  });

  it("offers the cause and region pickers as keyboard-reachable chips inside the token's focus", async () => {
    wrap(<CatalogBrowser onSelect={() => {}} within={{ categories: ["hunger", "clean-water"], regions: ["africa", "asia"] }} />);
    const causes = screen.getByRole("group", { name: /Causes/ });
    expect(within(causes).getAllByRole("checkbox").map((c) => (c as HTMLInputElement).labels?.[0]?.textContent)).toEqual(["Hunger & famine", "Clean water & sanitation"]);
    expect(causes).toHaveTextContent("none chosen: any");
    // Painted art next to the label, hidden from assistive tech.
    expect(causes.querySelectorAll("img[aria-hidden='true']")).toHaveLength(2);
    fireEvent.click(within(causes).getByRole("checkbox", { name: "Hunger & famine" }));
    expect(within(causes).getByRole("checkbox", { name: "Hunger & famine" })).toBeChecked();
    expect(causes).toHaveTextContent("1 chosen");
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes("categories=hunger&"))).toBe(true));
    expect(within(screen.getByRole("group", { name: /Regions/ })).getAllByRole("checkbox")).toHaveLength(2);
  });

  it("marks chosen organizations and disables the rest once the limit is reached", async () => {
    const onSelect = vi.fn();
    wrap(<CatalogBrowser onSelect={onSelect} selectLabel="Pin" selectedLabel="Pinned" selectedIds={["0xCA0"]} full="All 1 pin slots are used." />);
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("All 1 pin slots are used.");
    await screen.findByText("Org 1");
    const cards = document.querySelectorAll("[data-slot='org-card']");
    expect(cards[0]).toHaveAttribute("data-selected", "true");
    expect(within(cards[0] as HTMLElement).getByText("Pinned")).toBeInTheDocument();
    expect(within(cards[0] as HTMLElement).queryByRole("button")).toBeNull();
    const other = screen.getByRole("button", { name: "Pin Org 1" });
    expect(other).toBeDisabled();
    expect(other).toHaveAccessibleDescription("All 1 pin slots are used.");
    fireEvent.click(other);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps the buttons live while there is room", async () => {
    wrap(<CatalogBrowser onSelect={() => {}} selectLabel="Pin" selectedIds={[]} />);
    expect(await screen.findByRole("button", { name: "Pin Org 2" })).toBeEnabled();
    expect(screen.queryByRole("note")).toBeNull();
  });
});
