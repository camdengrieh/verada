"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LoadingScreen } from "@varada/ui/components/motion/loading-screen";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAccount, WagmiProvider } from "wagmi";
import { loadRuntimeConfig, type AppConfig } from "@/lib/config";
import { createDeps, type DataDeps } from "@/lib/data";
import { effectivePrivateRpcConfig } from "@/lib/effective-rpc-config";
import { PrivateRpc } from "@/lib/private-rpc";
import { directModeActive, normalizePrivacyPrefs, readPrivacyPrefs, writePrivacyPrefs, type PrivacyPrefs } from "@/lib/privacy-prefs";
import { createWagmiConfig } from "@/lib/wagmi";

interface Runtime {
  config: AppConfig;
  deps: DataDeps;
  rpc: PrivateRpc;
  prefs: PrivacyPrefs;
  setPrefs(p: PrivacyPrefs): void;
}

const RuntimeContext = createContext<Runtime | null>(null);

function useRuntime(hook: string): Runtime {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error(`${hook} must be used inside <Providers>`);
  return ctx;
}

export function useAppConfig(): AppConfig {
  return useRuntime("useAppConfig").config;
}

export function useDeps(): DataDeps {
  return useRuntime("useDeps").deps;
}

export function usePrivateRpc(): PrivateRpc {
  return useRuntime("usePrivateRpc").rpc;
}

export function usePrivacyPrefs(): [PrivacyPrefs, (p: PrivacyPrefs) => void] {
  const { prefs, setPrefs } = useRuntime("usePrivacyPrefs");
  return [prefs, setPrefs];
}

/** Keeps the private RPC's isolation key in step with the connected wallet. */
function AccountIsolation({ rpc }: { rpc: PrivateRpc }) {
  const { address } = useAccount();
  useEffect(() => rpc.setAccount(address), [rpc, address]);
  return null;
}

/** The settings that shape the chain-read path. A change to any of them rebuilds the PrivateRpc. */
type ConnectionPrefs = Pick<PrivacyPrefs, "rpcUrls" | "network" | "directMode">;

function connectionKey(p: PrivacyPrefs): string {
  const c: ConnectionPrefs = { rpcUrls: p.rpcUrls ?? [], network: p.network, directMode: directModeActive(p) };
  return JSON.stringify(c);
}

/** Loads /config.json once at startup, then mounts wagmi and react-query with it. */
export function Providers({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [queryClient] = useState(() => new QueryClient());
  const [prefs, setPrefsState] = useState<PrivacyPrefs>(() => readPrivacyPrefs());
  // Read by the indexer client on every request, so a toggle applies without rebuilding deps.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    let live = true;
    void loadRuntimeConfig().then((c) => live && setConfig(c));
    return () => {
      live = false;
    };
  }, []);

  // `pnpm dev:up` only: DEV_WALLET_KEY is inlined as undefined in any other build, so this branch and
  // the module behind it are dropped.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    // The condition must test the variable directly: the bundler replaces it with undefined and drops the branch.
    if (process.env.NEXT_PUBLIC_DEV_WALLET_KEY && config?.rpcUrl) {
      const rpcUrl = config.rpcUrl;
      void import("@/lib/dev-wallet").then((m) => {
        dispose = m.installDevWallet(rpcUrl, process.env.NEXT_PUBLIC_DEV_WALLET_KEY as string, config.chainId).dispose;
      });
    }
    return () => dispose?.();
  }, [config]);

  // The user's RPCs, network and direct mode apply live: a change builds a new PrivateRpc (the old
  // worker closes) and a new wagmi config, which reconnects the wallet from wagmi's own storage.
  const connKey = connectionKey(prefs);
  const rpc = useMemo(() => {
    if (!config) return null;
    const conn = JSON.parse(connKey) as ConnectionPrefs;
    const prefsForRpc: PrivacyPrefs = { routeIndexer: false, introSeen: false, ...conn };
    return new PrivateRpc(effectivePrivateRpcConfig(config.privateRpc, prefsForRpc), { directMode: conn.directMode === true });
  }, [config, connKey]);
  useEffect(() => () => rpc?.close(), [rpc]);

  const base = useMemo(
    () => (config && rpc ? { config, rpc, deps: createDeps(config, rpc, () => prefsRef.current.routeIndexer) } : null),
    [config, rpc],
  );
  const wagmiConfig = useMemo(() => (rpc && config ? createWagmiConfig(rpc, config.chainId) : null), [rpc, config]);
  const runtime = useMemo<Runtime | null>(
    () =>
      base && {
        ...base,
        prefs,
        setPrefs: (p) => {
          const next = normalizePrivacyPrefs(p);
          writePrivacyPrefs(next);
          setPrefsState(next);
        },
      },
    [base, prefs],
  );

  const ready = Boolean(runtime && wagmiConfig);
  return (
    <>
      <LoadingScreen ready={ready} minVisibleMs={400} />
      {runtime && wagmiConfig && (
        <RuntimeContext.Provider value={runtime}>
          <WagmiProvider config={wagmiConfig}>
            <QueryClientProvider client={queryClient}>
              <AccountIsolation rpc={runtime.rpc} />
              {children}
            </QueryClientProvider>
          </WagmiProvider>
        </RuntimeContext.Provider>
      )}
    </>
  );
}
