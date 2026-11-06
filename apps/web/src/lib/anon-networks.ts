/**
 * Anonymizing networks reachable through anon-rpc (https://github.com/ethereum/anon-rpc).
 *
 * Each entry is an on-chain IWorkerSpecifier contract that pins the anon-client
 * bundle by keccak256 hash. Addresses come from the project's adopters.json5.
 * `specifierChainId` is the chain the specifier lives on: the harness's one
 * direct bootstrap read must go to an RPC of that chain. It is not a limit on
 * which RPCs the anonymized fetch can reach (those are the app's mainnet RPCs).
 */
export interface AnonNetwork {
  label: string;
  /** Who runs the network and controls the specifier (the trust anchor). */
  operator: string;
  specifier: string;
  specifierChainId: number;
  /**
   * Public RPCs of `specifierChainId` for the bootstrap read when it is not the app's
   * chain. Mainnet specifiers use the app's own RPC list instead.
   */
  bootstrapRpcUrls?: readonly string[];
  anonymizes: boolean;
}

export const SEPOLIA_CHAIN_ID = 11155111;

export const ANON_NETWORKS = {
  nox: {
    label: "Nox mixnet",
    operator: "Hisoka",
    // Stable address, owner-updatable to follow the current Nox release (anon-rpc adopters.json5;
    // per-release immutable pins are listed in @hisoka-io/anon-rpc-worker). Nox has no mainnet
    // specifier yet, so the bootstrap read goes to Sepolia.
    specifier: "0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A",
    specifierChainId: SEPOLIA_CHAIN_ID,
    // Keyless public Sepolia RPCs that served the specifier's code when checked (2026-11-07).
    bootstrapRpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.gateway.tenderly.co"],
    anonymizes: true,
  },
  nym: {
    label: "Nym mixnet",
    operator: "Nym",
    specifier: "0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0",
    specifierChainId: 1,
    anonymizes: true,
  },
  "tor-js": {
    label: "Tor",
    operator: "anon-rpc (tor-js)",
    specifier: "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e",
    specifierChainId: 1,
    anonymizes: true,
  },
  passthrough: {
    // Reference worker: exercises the sandbox and hash pinning only. Never use in production.
    label: "Passthrough (not anonymized)",
    operator: "anon-rpc (reference)",
    specifier: "0x4fd77be300f31c5fe6ab266d35d27750a3478d27",
    specifierChainId: 1,
    anonymizes: false,
  },
} as const satisfies Record<string, AnonNetwork>;

export type AnonNetworkId = keyof typeof ANON_NETWORKS;

export const ANON_NETWORK_IDS = Object.keys(ANON_NETWORKS) as AnonNetworkId[];

export function isAnonNetworkId(v: unknown): v is AnonNetworkId {
  return typeof v === "string" && Object.hasOwn(ANON_NETWORKS, v);
}
