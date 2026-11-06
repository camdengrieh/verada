import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EnsAddress } from "@verada/ui/components/varada/ens-address";
import { EnsClaim, availabilityMessage, type EnsLookupResult } from "@verada/ui/components/varada/ens-claim";
import { EnsName } from "@verada/ui/components/varada/ens-name";
import { EnsProfileCard } from "@verada/ui/components/varada/ens-profile-card";
import { EnsRecordList, recordState, type EditableRecord } from "@verada/ui/components/varada/ens-record-list";
import {
  ensLimoUrl,
  ensNameFor,
  labelProblem,
  normalizeLabel,
  shortenAddress,
  splitEnsName,
  toneFor,
} from "@verada/ui/components/varada/ens-shared";
import { SubnameTree } from "@verada/ui/components/varada/subname-tree";

const ADDRESS = "0x7f3a9c2b44e0d1f5a6b7c8d9e0f1a2b3c4d5c21e";

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // whileInView reveals; jsdom has no IntersectionObserver.
  globalThis.IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockClipboard() {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("ENS helpers", () => {
  it("splits names into label and parent", () => {
    expect(splitEnsName("harambe.varada.eth")).toEqual({ label: "harambe", parent: "varada.eth" });
    expect(splitEnsName("wildlife.agent.varada.eth")).toEqual({ label: "wildlife", parent: "agent.varada.eth" });
    expect(splitEnsName("Harambe")).toEqual({ label: "harambe", parent: "varada.eth" });
    expect(ensNameFor("gigachad")).toBe("gigachad.varada.eth");
    expect(ensLimoUrl("harambe.varada.eth")).toBe("https://harambe.varada.eth.limo");
  });

  it("shortens addresses and keeps short strings", () => {
    expect(shortenAddress(ADDRESS)).toBe("0x7f3a…c21e");
    expect(shortenAddress("0x1234")).toBe("0x1234");
  });

  it("normalises and validates labels", () => {
    expect(normalizeLabel("  HaRambe ")).toBe("harambe");
    expect(normalizeLabel("harambe.varada.eth")).toBe("harambe");
    expect(labelProblem("")).toBe("empty");
    expect(labelProblem("ab")).toBe("too-short");
    expect(labelProblem("a".repeat(64))).toBe("too-long");
    expect(labelProblem("ha rambe")).toBe("characters");
    expect(labelProblem("-harambe")).toBe("hyphen-edge");
    expect(labelProblem("ab--cd")).toBe("double-hyphen");
    expect(labelProblem("harambe-2")).toBeNull();
  });

  it("picks a stable tone per seed", () => {
    expect(toneFor(ADDRESS)).toBe(toneFor(ADDRESS));
  });
});

describe("EnsName", () => {
  it("dims the parent, marks verified and primary, and copies the full name", async () => {
    const writeText = mockClipboard();
    render(<EnsName name="harambe.varada.eth" verified primary siteHref="https://harambe.varada.eth.limo" />);
    expect(screen.getByText(".varada.eth")).toHaveClass("text-ink-muted");
    expect(screen.getByText(", verified")).toHaveClass("sr-only");
    expect(screen.getByText("Primary")).toBeInTheDocument();
    const site = screen.getByRole("link", { name: /Open site: harambe\.varada\.eth/ });
    expect(site).toHaveAttribute("href", "https://harambe.varada.eth.limo");
    expect(site).toHaveAttribute("rel", "noopener noreferrer");
    const button = screen.getByRole("button", { name: "Copy harambe.varada.eth" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith("harambe.varada.eth");
    expect(await screen.findByRole("status")).toHaveTextContent("Copied");
  });
});

describe("EnsClaim", () => {
  function Harness({ check, status }: { check?: (l: string, s: AbortSignal) => Promise<EnsLookupResult>; status?: "available" }) {
    const [value, setValue] = useState("");
    return <EnsClaim value={value} onValueChange={setValue} check={check} status={status} debounce={5} onClaim={() => {}} suggestions={["harambe-coin"]} />;
  }

  it("goes checking → available and stamps the name", async () => {
    const check = vi.fn((label: string) => Promise.resolve<EnsLookupResult>(label === "harambe" ? "available" : "taken"));
    const { container } = render(<Harness check={check} />);
    const input = screen.getByLabelText("Coin name");
    fireEvent.change(input, { target: { value: "Harambe" } });
    expect(container.querySelector("form")).toHaveAttribute("data-status", "checking");
    expect(screen.getByText("Checking harambe.varada.eth…")).toBeInTheDocument();
    await waitFor(() => expect(container.querySelector("form")).toHaveAttribute("data-status", "available"));
    expect(check).toHaveBeenCalledWith("harambe", expect.any(AbortSignal));
    expect(screen.getByRole("status")).toHaveTextContent("harambe.varada.eth is available");
    expect(container.querySelector("[data-slot='ens-stamp']")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claim name" })).toBeEnabled();
  });

  it("shows taken with suggestions, and picking one checks again", async () => {
    const check = vi.fn((label: string) => Promise.resolve<EnsLookupResult>(label === "harambe" ? "taken" : "reserved"));
    const { container } = render(<Harness check={check} />);
    fireEvent.change(screen.getByLabelText("Coin name"), { target: { value: "harambe" } });
    await waitFor(() => expect(container.querySelector("form")).toHaveAttribute("data-status", "taken"));
    expect(screen.getByRole("button", { name: "Claim name" })).toBeDisabled();
    expect(container.querySelector("[data-slot='ens-stamp']")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /harambe-coin/ }));
    await waitFor(() => expect(container.querySelector("form")).toHaveAttribute("data-status", "reserved"));
    expect(screen.getByRole("status")).toHaveTextContent("harambe-coin.varada.eth is reserved for you");
    expect(container.querySelector("[data-slot='ens-stamp']")).toHaveTextContent("Reserved for you");
  });

  it("flags invalid labels without calling the lookup", async () => {
    const check = vi.fn(() => Promise.resolve<EnsLookupResult>("available"));
    const { container } = render(<Harness check={check} />);
    const input = screen.getByLabelText("Coin name");
    fireEvent.change(input, { target: { value: "ha rambe" } });
    await waitFor(() => expect(container.querySelector("form")).toHaveAttribute("data-status", "invalid"));
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Use lowercase letters a–z, digits and hyphens only");
    expect(screen.getByRole("status")).toHaveTextContent("Use lowercase letters");
    expect(check).not.toHaveBeenCalled();
  });

  it("shows a status passed in by the app and submits the label", () => {
    const onClaim = vi.fn();
    render(<EnsClaim defaultValue="gigachad" status="available" onClaim={onClaim} />);
    expect(screen.getByLabelText("Coin name")).toHaveAccessibleDescription("gigachad.varada.eth is available");
    fireEvent.click(screen.getByRole("button", { name: "Claim name" }));
    expect(onClaim).toHaveBeenCalledWith("gigachad");
  });

  it("words every state", () => {
    expect(availabilityMessage("taken", "a.varada.eth")).toBe("a.varada.eth is taken");
    expect(availabilityMessage("idle", "a.varada.eth", undefined, "Hint")).toBe("Hint");
  });
});

describe("EnsAddress", () => {
  it("reads as name resolves to address and copies the address", async () => {
    const writeText = mockClipboard();
    render(<EnsAddress address={ADDRESS} name="harambe.varada.eth" />);
    expect(screen.getByText("0x7f3a…c21e")).toHaveAttribute("title", ADDRESS);
    expect(screen.getByText("resolves to")).toHaveClass("sr-only");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    });
    expect(writeText).toHaveBeenCalledWith(ADDRESS);
  });

  it("shows resolving without a name", () => {
    render(<EnsAddress address={ADDRESS} resolving />);
    expect(screen.getByText("Resolving…")).toBeInTheDocument();
  });
});

describe("EnsProfileCard", () => {
  it("lists text records with icons and an Open site link", () => {
    render(
      <EnsProfileCard
        name="harambe.varada.eth"
        description="For the gorillas."
        records={[
          { key: "com.twitter", value: "harambecoin", href: "https://x.com/harambecoin" },
          { key: "url", value: "harambe.wtf" },
          { key: "description", value: "For the gorillas." },
        ]}
        contenthash={{ protocol: "swarm", hash: "3f9a1b2c3d4e5f60718293a4b5c6d7e8f9012345" }}
        siteHref="https://harambe.varada.eth.limo"
      />,
    );
    expect(screen.getByRole("article", { name: /harambe/ })).toBeInTheDocument();
    const terms = screen.getAllByRole("term").map((t) => t.textContent);
    expect(terms).toEqual(["Website", "X (Twitter)"]);
    expect(screen.getByRole("link", { name: /@harambecoin/ })).toHaveAttribute("href", "https://x.com/harambecoin");
    expect(screen.getByText("Swarm")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open site/ })).toHaveAttribute("href", "https://harambe.varada.eth.limo");
  });
});

describe("EnsRecordList", () => {
  const records: EditableRecord[] = [
    { key: "url", value: "harambe.wtf", savedValue: "harambe.wtf" },
    { key: "com.twitter", value: "harambe2", savedValue: "harambecoin" },
    { key: "org.telegram", value: "harambe", state: "pending" },
  ];

  it("works out saved and edited states", () => {
    expect(records.map(recordState)).toEqual(["saved", "edited", "pending"]);
  });

  it("shows states per row, resets and saves", () => {
    const onReset = vi.fn();
    const onSave = vi.fn();
    const onChange = vi.fn();
    render(<EnsRecordList name="harambe.varada.eth" records={records} onRecordChange={onChange} onRecordReset={onReset} onSave={onSave} />);
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).getByText("Saved")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Edited")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Pending")).toBeInTheDocument();
    expect(screen.getByLabelText(/Telegram/)).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Website/), { target: { value: "harambe.xyz" } });
    expect(onChange).toHaveBeenCalledWith("url", "harambe.xyz");
    fireEvent.click(screen.getByRole("button", { name: "Reset X (Twitter)" }));
    expect(onReset).toHaveBeenCalledWith("com.twitter");
    fireEvent.click(screen.getByRole("button", { name: "Save 1 change" }));
    expect(onSave).toHaveBeenCalled();
  });
});

describe("SubnameTree", () => {
  it("draws both branches and marks the active name", () => {
    render(
      <SubnameTree
        coins={[{ label: "harambe", href: "/token/harambe" }, { label: "gigachad" }]}
        agents={[{ cause: "wildlife" }, { cause: "water" }]}
        moreCoins={128}
        active="harambe.varada.eth"
      />,
    );
    expect(screen.getByRole("figure", { name: /under varada\.eth/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "harambe.varada.eth" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("wildlife")).toBeInTheDocument();
    expect(screen.getByText("+ 128 more coins")).toBeInTheDocument();
  });
});
