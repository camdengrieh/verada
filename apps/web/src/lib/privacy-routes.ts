/**
 * What leaves the browser, where it goes and who can see it: the web app's side of docs/PRIVACY.md,
 * as data for the privacy dialog. Keep it in step with that document.
 */
export type RouteKind = "mixnet" | "direct" | "wallet" | "chain";

export interface PrivacyRoute {
  id: string;
  /** What the request is for. */
  what: string;
  kind: RouteKind;
  /** Who can see what. */
  sees: string;
  note?: string;
}

export const PRIVACY_SUMMARY =
  "Chain reads go through the {network} mixnet, so the RPC provider never sees your IP. Account reads (your balance, voting weight and allowance) use a separate random key per address and never fall back to a direct connection. A few requests cannot go through the mixnet; they are listed here.";

export const PRIVACY_ROUTES: readonly PrivacyRoute[] = [
  {
    id: "public-reads",
    what: "Public chain data: token lists, epochs, vault balances",
    kind: "mixnet",
    sees: "The RPC provider sees the mixnet's exit node. Nobody learns your IP.",
    note: "If the network is down you can choose to load public data directly for the visit; account data never does.",
  },
  {
    id: "account-reads",
    what: "Your account: balances, voting weight, who you have voted for",
    kind: "mixnet",
    sees: "Read from the chain in your browser under a random per-address key. Varada never receives your address, and your addresses cannot be linked to each other.",
    note: "Fails closed: with no private route this data does not load.",
  },
  {
    id: "indexer",
    what: "Varada API: token pages, epochs, agent reports",
    kind: "direct",
    sees: "The indexer sees your IP and which pages you open while it answers, never a wallet address, and it keeps no access logs.",
    note: "Turn on routing in the privacy menu to send these through the mixnet too.",
  },
  {
    id: "zama-relayer",
    what: "Encrypting a ballot: the FHE key and input proof",
    kind: "direct",
    sees: "Zama's relayer sees your IP, the voting contract and your address, never your choice.",
    note: "The SDK cannot send these through the mixnet. An operator can put a proxy in front of the relayer.",
  },
  {
    id: "transactions",
    what: "Votes, donations and launches you sign",
    kind: "wallet",
    sees: "Your wallet's RPC sees the signed transaction and your IP. This app does not control it.",
    note: "Set a private or Tor-routed RPC in your wallet to hide it.",
  },
  {
    id: "images",
    what: "Token logos and artwork",
    kind: "direct",
    sees: "The Swarm gateway sees which images a page shows, never a wallet address.",
  },
  {
    id: "chain",
    what: "Votes and donations once confirmed",
    kind: "chain",
    sees: "Public: the voter and weight of a ballot, and the donor of any vault donation. Only a ballot's choice is encrypted, and only per-option totals are decrypted.",
    note: "With very few voters the totals can still point to a choice.",
  },
];
