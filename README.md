# Varada

A memecoin launchpad on Ethereum Mainnet. Trading fees fund nonprofits: each week, holders vote
(with hidden ballots) on which cause (sourced from Endaoment) receives the accumulated funds. The
platform keeps a small, fixed share of fees. Every token gets an ENS subname (`<label>.varada.eth`)
with an editable profile and a page on the Swarm-hosted app. A token can instead launch in live
mode, where every swap's fee is converted to USDC and donated in the same swap to the current
cause, and holders rotate that cause by private vote every hour, 12 hours, day, three days or week.

## Quick start

```sh
pnpm install
export FORK_RPC_URL=<a mainnet RPC URL>
pnpm dev:up      # anvil fork + Varada deployed + indexer + web app + a test wallet; prints the URLs
pnpm dev:down
```

Details, ports, readiness and cleanup: [`docs/OVERVIEW.md`](docs/OVERVIEW.md#one-command-pnpm-devup).

## Layout

| Path | What it is |
| --- | --- |
| `contracts/` | Foundry: Uniswap v4 hook-based launch, fee vault, causes, weekly governance, live-donation hook, vault and rotation governor, ENS profile registry and wildcard resolver, Zama FHE voting scheme, community takeover |
| `apps/web/` | Static-export Next.js app, served from Swarm behind ENS ([README](apps/web/README.md)) |
| `packages/ui/` | `@varada/ui`, the component library; gallery at `/design` ([README](packages/ui/README.md)) |
| `packages/sdk/` | `@varada/sdk`: ABIs, addresses, fee and ballot math, ENS and Swarm helpers, the swap engine |
| `packages/publish/` | Validate, upload and point ENS at a release of the static export |
| `packages/cause-catalog/`, `packages/curator/`, `packages/endaoment-client/`, `packages/arkiv-registry/` | Catalogue builder, curator agent CLI, Endaoment client, Arkiv mirror schemas |
| `services/indexer/` | Ponder indexer and the read-only `/api/*` layer (market, trades, holders, discover, causes, governance) |
| `services/publisher/` | Logo and metadata uploads, Arkiv mirror, tally keeper, x402 facilitator |
| `agents/` | Operations for the 20 curator agents |
| `infra/` | AWS CDK (indexer, Bee node and gateway, publisher) |

Where to read next:

- [`docs/OVERVIEW.md`](docs/OVERVIEW.md): how the app shell, `@varada/ui`, the SDK swap engine and the
  indexer API fit together, and how to run all of it locally.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): the contracts and protocol rules.
- [`docs/SWAP.md`](docs/SWAP.md): routing, quotes, fees and execution of a trade.
- [`docs/PRIVACY.md`](docs/PRIVACY.md): what each component can see about a user.
- [`docs/ENV.md`](docs/ENV.md): environment variables and `config.json`, by component.

Security reviews, their coverage, every finding and its status: [`docs/SECURITY.md`](docs/SECURITY.md).
Deploying to Ethereum mainnet (rehearsal, broadcast, owner setup): [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
The contracts have not had an independent human audit.

## Uniswap v4 hooks

Varada's pool logic is built from a library of generic Uniswap v4 hooks in
[`contracts/src/hooks`](contracts/src/hooks), usable by any LP or protocol. Each hook does one
thing, works on its own through a minimal deployable example, and combines with the others into
a single hook by inheritance (a v4 pool has one hook address):

| Hook | Does |
| --- | --- |
| `DecayingFeeHook` | dynamic LP fee that decays from a launch fee to a base fee |
| `SwapFeeHook` | hook fee on every swap, paid to a recipient as ERC-6909 claims or tokens |
| `TwapOracleHook` | per pool time-weighted average tick |
| `PoolInitGateHook` | only allowed initializers create pools, with an overridable key rule |
| `LiquidityGateHook` | per pool allowlist for adding and removing liquidity (locked liquidity) |
| `FeeConversionHook` | converts fee claims to one currency inside the swap, holds and retries on failure |
| `BondingCurveHook` | reference custom-curve example (not used in production) |

`VaradaHook` and `VaradaLiveHook` are compositions of these plus Varada glue. Docs, install
(`forge install` plus a remapping while the repository is public, or copy the folder; MIT), gas
and trust assumptions: [`docs/hooks/README.md`](docs/hooks/README.md). Tutorial:
[`docs/hooks/ComposeYourOwn.md`](docs/hooks/ComposeYourOwn.md). Case study:
[`docs/hooks/Varada.md`](docs/hooks/Varada.md).

## Private chain reads

The app never talks to an Ethereum RPC provider directly. Every chain read goes through an
[anon-rpc](https://github.com/ethereum/anon-rpc) worker: a client bundle pinned by hash in an
on-chain specifier contract, fetched at start and run in a null-origin sandboxed iframe with no
access to the page, its storage or any keys. The default worker is [Nox](https://github.com/hisoka-io/nox),
the mixnet built by Hisoka. The worker connects to Nox anchors over KPS (WebRTC), the request is
mixed through the network, and an exit node forwards it to the RPC provider.

What this gives users:

- The RPC provider sees an exit node, never the user's IP.
- Each connected account gets its own random isolation key, and public reads use another, so the
  provider cannot tell which accounts belong to the same person.
- Varada's own servers never receive a wallet address. Reads of account data never fall back to a
  direct connection: if the mixnet is unreachable they fail rather than leak. Public data may load
  directly only after an explicit per-visit opt-in.
- Requests to the Varada indexer can go through the mixnet as well (a switch in the privacy pill),
  so Varada does not see the user's IP either.
- Nym and Tor run on the same plumbing behind one setting (`NEXT_PUBLIC_ANON_RPC_NETWORK`).

The header pill shows the live state. `pnpm --filter @varada/web check:private-rpc` drives the app
in headless Chrome and confirms a read completes through Nox. The route-by-route account of what
leaves the browser, measurements and known gaps: [`docs/PRIVACY.md`](docs/PRIVACY.md).

## Getting started

Requirements: pnpm 10; Node 22.12 or newer for the indexer (Ponder), Node 20 or newer is enough for the
web app, SDK and tests; Foundry for the contracts; Git LFS for the art originals.

The original artwork in `apps/web/assets-src/` is stored with [Git LFS](https://git-lfs.com).
Install it once per machine before cloning, or the art files arrive as small text pointers:

```sh
brew install git-lfs        # or your platform's package
git lfs install             # once per machine
git clone https://github.com/camdengrieh/verada.git
cd verada && git lfs pull   # only needed if you cloned before installing LFS
pnpm install
```

Nothing that builds or ships the app needs LFS: the optimised images in `apps/web/public/assets/` are
normal git files. You only need the LFS originals to add or regenerate art (see
[`apps/web/README.md`](apps/web/README.md#art-and-assets)).

## CROPS

How the app stands against the Ethereum Foundation's CROPS properties. Details, measurements and
every known gap are in [`docs/PRIVACY.md`](docs/PRIVACY.md).

- **C**ensorship resistance. The site is a static export on Swarm, resolved through ENS, so there
  is no app server to take down, and every token page is the one site under `<label>.varada.eth`.
  What we run that users depend on is the indexer (one AWS account): without it, core data falls
  back to chain reads, and the client takes a list of indexer mirrors. The anon-rpc worker bundle
  comes from resolvers the network operator lists, and the default mixnet's specifier contract is
  on Sepolia today; Nym and Tor (mainnet specifiers) are a configuration switch.
- **O**pen source. MIT, see [`LICENSE`](LICENSE). Everything builds and runs from this repository
  alone: follow Getting started, then `pnpm --filter @varada/web dev` for the app, `pnpm test` for
  the TypeScript suites and `forge test` in `contracts/`. The published site is a plain static
  export whose Swarm hash can be rebuilt and compared.
- **P**rivacy. Chain reads go through anon-rpc (Hisoka's Nox mixnet by default; Nym or Tor by
  configuration), isolated per account, so the RPC provider sees neither the user's IP nor which
  accounts belong together, and account reads never fall back to a direct connection. Ballot
  choices are encrypted (Zama FHE) and only per-option totals are decrypted. Varada's servers never
  receive a wallet address and keep no access logs; the client has no analytics and no third-party
  requests. What still learns something: the user's own wallet RPC (transactions), the Zama relayer
  (the voter's IP and address, never the choice), the Swarm gateway serving the page, and the
  bootstrap RPC that sees an anon-rpc worker starting.
- **S**ecurity. Keys stay in the user's wallet. The anon worker is pinned by hash in an on-chain
  specifier and runs in a null-origin sandbox with no access to the page, storage or keys. Trust
  assumptions: Zama's threshold KMS for ballot decryption, the specifier owner for the worker code,
  and the RPC the worker reads for its answers. Known gaps: no Content Security Policy yet (static
  export) and no second-RPC cross-check of critical reads.

## License

MIT. See [`LICENSE`](LICENSE).

Run the web app against a mock indexer (no RPC key needed), in two terminals:

```sh
pnpm --filter @varada/indexer serve:fixtures 42069
pnpm --filter @varada/web dev      # http://localhost:3000
```

Checks (the ones CI runs):

```sh
pnpm typecheck && pnpm test
pnpm --filter @varada/web build && pnpm --filter @varada/web verify:export
pnpm build:contracts && pnpm test:contracts
```

The real indexer, the publisher, the static export on a Swarm-style server and a mainnet fork are
covered in [`docs/OVERVIEW.md`](docs/OVERVIEW.md#running-everything-locally).
