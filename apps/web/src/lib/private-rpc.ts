/**
 * Private RPC: every chain read leaves the browser through an anon-rpc worker
 * (Nox, Nym or Tor, running sandboxed in a null-origin iframe), so the RPC provider
 * never sees the user's IP address and cannot link one account's queries to another's.
 *
 * Two scopes:
 *  - "public": data that is the same for everyone (token lists, epochs). If the
 *    anon network is down the user may explicitly allow a direct connection for these.
 *  - "account": anything keyed by the user's address (portfolio, donations made,
 *    votes made, simulations with `from`). These NEVER fall back to a direct
 *    connection. They fail closed.
 *
 * Every account gets its own random isolation key, so the anon network is asked
 * to keep different accounts' traffic unlinkable. Keys live in memory only and
 * are regenerated on every page load.
 *
 * Direct mode ("Direct to my RPC", a user setting) is the way to keep going when the anon
 * network is unavailable: every read, account reads included, goes straight to the user's own
 * RPC and no worker is ever started. It is not private, and it is only entered through that setting.
 */
import { fallback, http, type Address, type Transport } from "viem";
import type { AnonFetch, AnonRpcWorker, RpcProvider, WorkerInit } from "@anon-rpc/browser-harness";
import { ANON_NETWORKS, type AnonNetwork } from "./anon-networks";
import type { PrivateRpcConfig } from "./config";

export type PrivateRpcStatus =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "ready" }
  | { state: "failed"; code?: string; message: string }
  /** Direct mode: reads go straight to the user's own RPC, with no anon worker. */
  | { state: "direct" };

export type Scope = { kind: "public" } | { kind: "account"; address: Address };

export class PrivateRpcUnavailableError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "PrivateRpcUnavailableError";
  }
}

/** The bootstrap RPC serves a different chain than the one the specifier contract lives on. */
export class BootstrapChainError extends Error {
  readonly code = "bootstrap-chain";
  constructor(message: string) {
    super(message);
    this.name = "BootstrapChainError";
  }
}

export type WorkerLike = Pick<AnonRpcWorker, "ready" | "fetch" | "close">;
export type WorkerFactory = (init: WorkerInit) => Promise<WorkerLike>;

const defaultFactory: WorkerFactory = async (init) => {
  // Browser-only: the harness builds an iframe and a Web Worker. Loaded on first use.
  const { AnonRpcWorker } = await import("@anon-rpc/browser-harness");
  return new AnonRpcWorker(init);
};

/**
 * Measured on Nym (2026-11-05): ~8s to bootstrap, ~6s per request. Allow well over
 * viem's 10s default, and batch JSON-RPC calls so one mixnet round trip carries many.
 */
export const PRIVATE_RPC_TIMEOUT_MS = 45_000;

function randomKey(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Plain JSON-RPC provider for the direct bootstrap reads (the specifier's workerHash and
 * resolvers). Tries `urls` in order and answers from the first that returns a result.
 */
export function jsonRpcProvider(urls: string | readonly string[], fetchImpl: typeof fetch): RpcProvider {
  const list = typeof urls === "string" ? [urls] : [...urls];
  if (list.length === 0) throw new Error("bootstrap RPC list is empty");
  let id = 0;
  return {
    async request({ method, params }) {
      let lastError: unknown;
      for (const url of list) {
        try {
          const res = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
            // Keep the direct requests free of cookies and referrer.
            credentials: "omit",
            referrerPolicy: "no-referrer",
          });
          const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
          if (body.error) throw new Error(body.error.message ?? "bootstrap RPC error");
          return body.result;
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
  };
}

export interface PrivateRpcOptions {
  factory?: WorkerFactory;
  /**
   * Used only for the bootstrap read, for public-scope requests the user explicitly allowed, and
   * for every request in direct mode.
   */
  directFetch?: typeof fetch;
  /** Start in direct mode (the user's "Direct to my RPC" setting). Off unless passed. */
  directMode?: boolean;
}

export class PrivateRpc {
  private worker?: Promise<WorkerLike>;
  private status: PrivateRpcStatus = { state: "idle" };
  private readonly listeners = new Set<() => void>();
  private readonly accountKeys = new Map<string, string>();
  private readonly publicKey = randomKey();
  private directForPublic = false;
  private direct = false;
  private account?: Address;
  private readonly factory: WorkerFactory;
  private readonly directFetch: typeof fetch;

  constructor(
    readonly cfg: PrivateRpcConfig,
    opts: PrivateRpcOptions = {},
  ) {
    this.factory = opts.factory ?? defaultFactory;
    this.directFetch = opts.directFetch ?? ((...a) => fetch(...a));
    if (opts.directMode) this.setDirectMode(true);
  }

  get network(): AnonNetwork {
    return ANON_NETWORKS[this.cfg.network];
  }

  get specifier(): string {
    return this.cfg.specifier ?? this.network.specifier;
  }

  getStatus(): PrivateRpcStatus {
    return this.status;
  }

  /** True when the user has opted to send public (non-account) reads directly. */
  get directPublicAllowed(): boolean {
    return this.directForPublic;
  }

  /** True in direct mode: every read goes straight to `cfg.rpcUrls`, nothing through the anon network. */
  get directMode(): boolean {
    return this.direct;
  }

  /**
   * Turn direct mode on or off. On stops any running worker; off returns to the private default,
   * where account reads fail closed while the anon network is unavailable.
   */
  setDirectMode(on: boolean) {
    if (on === this.direct) return;
    this.direct = on;
    this.close();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(s: PrivateRpcStatus) {
    this.status = s;
    for (const l of this.listeners) l();
  }

  /** The connected wallet. Requests made without an explicit scope are isolated under it. */
  setAccount(address: Address | undefined) {
    this.account = address;
  }

  isolationKey(scope: Scope): string {
    if (scope.kind === "public") return this.publicKey;
    const k = scope.address.toLowerCase();
    let key = this.accountKeys.get(k);
    if (!key) this.accountKeys.set(k, (key = randomKey()));
    return key;
  }

  /** Scope for requests that may carry the connected account (wagmi reads, simulations). */
  currentScope(): Scope {
    return this.account ? { kind: "account", address: this.account } : { kind: "public" };
  }

  /**
   * RPCs for the direct bootstrap read of the specifier contract: the configured override, else
   * the network's own list when its specifier is not on the app's chain (Nox: Sepolia), else the
   * first anonymized RPC (mainnet specifiers).
   */
  bootstrapRpcUrls(): readonly string[] {
    if (this.cfg.bootstrapRpcUrl) return [this.cfg.bootstrapRpcUrl];
    const own = this.network.bootstrapRpcUrls;
    if (own && own.length > 0) return own;
    return this.cfg.rpcUrls.slice(0, 1);
  }

  /**
   * The specifier is read from the chain it lives on. A bootstrap RPC of another chain would make
   * the harness fail on an empty contract, so name the mismatch first. An RPC that cannot answer
   * `eth_chainId` is left to the harness, which reports its own error.
   */
  private async checkSpecifierChain(provider: RpcProvider): Promise<void> {
    let answer: unknown;
    try {
      answer = await provider.request({ method: "eth_chainId", params: [] });
    } catch {
      return;
    }
    if (typeof answer !== "string" || !/^0x[0-9a-fA-F]+$/.test(answer)) return;
    const got = Number.parseInt(answer, 16);
    const want = this.network.specifierChainId;
    if (got !== want) {
      throw new BootstrapChainError(
        `bootstrap RPC serves chain ${got}, but the ${this.network.label} specifier lives on chain ${want}`,
      );
    }
  }

  /** Start the worker if it isn't running. Safe to call repeatedly. */
  start(): Promise<WorkerLike> {
    if (this.direct) return Promise.reject(new PrivateRpcUnavailableError("Direct mode is on: no private network is used", "direct-mode"));
    if (this.worker) return this.worker;
    this.setStatus({ state: "connecting" });
    const boot = this.bootstrapRpcUrls();
    const rpcProvider = boot.length > 0 ? jsonRpcProvider(boot, this.directFetch) : undefined;
    const init: WorkerInit = {
      address: this.specifier,
      config: this.cfg.workerConfig as WorkerInit["config"],
      preExisting: rpcProvider ? { rpcProvider } : undefined,
    };
    const p = (rpcProvider ? this.checkSpecifierChain(rpcProvider) : Promise.resolve())
      .then(() => this.factory(init))
      .then(async (w) => {
        await w.ready;
        return w;
      });
    this.worker = p;
    p.then(
      () => this.worker === p && this.setStatus({ state: "ready" }),
      (e: unknown) => {
        if (this.worker !== p) return;
        const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : undefined;
        this.setStatus({ state: "failed", code, message: e instanceof Error ? e.message : String(e) });
      },
    );
    return p;
  }

  /** Tear down and reconnect, e.g. after a failure. */
  retry(): Promise<WorkerLike> {
    this.close();
    return this.start();
  }

  /**
   * Opt in (for this page load only) to direct connections for public reads while
   * the anon network is unavailable. Account-scoped requests are never affected.
   */
  allowDirectForPublic(on: boolean) {
    this.directForPublic = on;
    for (const l of this.listeners) l();
  }

  close() {
    const w = this.worker;
    this.worker = undefined;
    void w?.then((x) => x.close()).catch(() => {});
    this.setStatus(this.direct ? { state: "direct" } : { state: "idle" });
  }

  /**
   * fetch through the anon network. Account scope fails closed; public scope honours the direct
   * opt-in. In direct mode every scope goes straight to the RPC, without cookies or referrer.
   */
  async fetch(input: string | URL | Request, init: RequestInit = {}, scope: Scope = { kind: "public" }): Promise<Response> {
    if (this.direct) return this.directFetch(input, { ...init, credentials: "omit", referrerPolicy: "no-referrer" });
    if (scope.kind === "public" && this.directForPublic && this.status.state !== "ready") {
      return this.directFetch(input, init);
    }
    let w: WorkerLike;
    try {
      w = await this.start();
    } catch (e) {
      throw new PrivateRpcUnavailableError(
        `Private RPC (${this.network.label}) is unavailable: ${e instanceof Error ? e.message : String(e)}`,
        this.status.state === "failed" ? this.status.code : undefined,
      );
    }
    return (w.fetch as AnonFetch)(input, { ...init, anonOptions: { isolationKey: this.isolationKey(scope) } });
  }

  /** A fetch bound to a scope, or to the connected account when `scope` is omitted. */
  fetchFor(scope?: Scope): typeof fetch {
    return (input, init) => {
      // viem adds its own `url` key to init; don't forward it to the worker.
      const rest: RequestInit & { url?: string } = { ...init };
      delete rest.url;
      return this.fetch(input as string | URL | Request, rest, scope ?? this.currentScope());
    };
  }

  /** viem transport over the private fetch, failing over across `rpcUrls` (anonymized unless in direct mode). */
  transport(scope?: Scope): Transport {
    const fetchFn = this.fetchFor(scope);
    const transports = this.cfg.rpcUrls.map((url) => http(url, { fetchFn, timeout: PRIVATE_RPC_TIMEOUT_MS, batch: { wait: 20 } }));
    if (transports.length === 0) throw new Error("privateRpc.rpcUrls is empty");
    return transports.length === 1 ? transports[0]! : fallback(transports);
  }
}
