# Varada

A memecoin launchpad on Ethereum Mainnet. Trading fees fund nonprofits: each week, holders vote
(with hidden ballots) on which cause (sourced from Endaoment) receives the accumulated funds. The
platform keeps a small, fixed share of fees. Every token gets an ENS subname (`<label>.varada.eth`)
with an editable profile and a page on the Swarm-hosted app. A token can instead launch in live
mode, where every swap's fee is converted to USDC and donated in the same swap to the current
cause, and holders rotate that cause by private vote every hour, 12 hours, day, three days or week.

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
