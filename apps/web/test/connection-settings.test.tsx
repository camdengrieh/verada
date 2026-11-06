import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { envDefaults, type AppConfig } from "@/lib/config";
import type { PrivacyPrefs } from "@/lib/privacy-prefs";

const config: AppConfig = { ...envDefaults(), privateRpc: { network: "nox", rpcUrls: ["https://configured.example"] } };
let prefs: PrivacyPrefs = { routeIndexer: false, introSeen: true };
const setPrefs = vi.fn();

vi.mock("@/components/providers", async () => {
  const { useState } = await import("react");
  return {
    useAppConfig: () => config,
    // Stateful like the real provider: a write re-renders the settings.
    usePrivacyPrefs: () => {
      const [p, set] = useState(prefs);
      return [
        p,
        (next: PrivacyPrefs) => {
          prefs = next;
          setPrefs(next);
          set(next);
        },
      ];
    },
  };
});

const { ConnectionSettings } = await import("@/components/connection-settings");

function endpoints() {
  return screen.getByRole("textbox", { name: "Your RPC endpoints" });
}

function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save endpoints" }));
}

describe("ConnectionSettings", () => {
  beforeEach(() => {
    prefs = { routeIndexer: false, introSeen: true };
    setPrefs.mockClear();
  });

  it("rejects an invalid URL with a message and saves nothing", () => {
    render(<ConnectionSettings />);
    fireEvent.change(endpoints(), { target: { value: "http://plain.example\nhttps://ok.example" } });
    save();
    expect(screen.getByText(/http:\/\/plain\.example must use https/)).toBeInTheDocument();
    expect(endpoints()).toHaveAttribute("aria-invalid", "true");
    expect(setPrefs).not.toHaveBeenCalled();
  });

  it("saves valid URLs to the prefs in canonical form", () => {
    render(<ConnectionSettings />);
    fireEvent.change(endpoints(), { target: { value: " https://mine.example/ \n\nhttps://second.example" } });
    save();
    expect(setPrefs).toHaveBeenLastCalledWith({ routeIndexer: false, introSeen: true, rpcUrls: ["https://mine.example", "https://second.example"] });
    expect(screen.getByRole("status")).toHaveTextContent("Saved 2 endpoints.");
  });

  it("keeps Direct to my RPC disabled until an endpoint is saved, and warns when it is on", () => {
    render(<ConnectionSettings />);
    const direct = screen.getByRole("switch", { name: "Direct to my RPC" });
    expect(direct).toBeDisabled();
    expect(screen.getByText(/Save an endpoint first/)).toBeInTheDocument();

    fireEvent.change(endpoints(), { target: { value: "https://mine.example" } });
    save();
    expect(direct).toBeEnabled();
    fireEvent.click(direct);
    expect(setPrefs).toHaveBeenLastCalledWith(expect.objectContaining({ rpcUrls: ["https://mine.example"], directMode: true }));
    expect(direct).toBeChecked();
    expect(screen.getByRole("note")).toHaveTextContent(/your RPC provider sees your IP address/);

    // Removing the endpoints turns direct mode off again.
    fireEvent.click(screen.getByRole("button", { name: "Remove all" }));
    expect(setPrefs).toHaveBeenLastCalledWith({ routeIndexer: false, introSeen: true });
    expect(direct).toBeDisabled();
    expect(direct).not.toBeChecked();
  });

  it("writes the chosen network, and Default clears it", () => {
    render(<ConnectionSettings />);
    expect(screen.getByRole("radio", { name: /Default.*Nox mixnet, run by Hisoka/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Passthrough.*Does not hide your IP/ })).toBeInTheDocument();
    act(() => fireEvent.click(screen.getByRole("radio", { name: /^Nym mixnet/ })));
    expect(setPrefs).toHaveBeenLastCalledWith({ routeIndexer: false, introSeen: true, network: "nym" });
    act(() => fireEvent.click(screen.getByRole("radio", { name: /^Default/ })));
    expect(setPrefs).toHaveBeenLastCalledWith({ routeIndexer: false, introSeen: true });
  });

  it("resets every connection setting but keeps the other privacy prefs", () => {
    prefs = { routeIndexer: true, introSeen: true, rpcUrls: ["https://mine.example"], network: "tor-js", directMode: true };
    render(<ConnectionSettings />);
    expect(endpoints()).toHaveValue("https://mine.example");
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(setPrefs).toHaveBeenLastCalledWith({ routeIndexer: true, introSeen: true });
    expect(endpoints()).toHaveValue("");
  });
});
