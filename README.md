# Varada

A memecoin launchpad on Ethereum Mainnet. Trading fees fund nonprofits: each week, holders vote
(with hidden ballots) on which cause (sourced from Endaoment) receives the accumulated funds. The
platform keeps a small, fixed share of fees. Every token gets an ENS subname (`<label>.varada.eth`)
with an editable profile and a page on the Swarm-hosted app. A token can instead launch in live
mode, where every swap's fee is converted to USDC and donated in the same swap to the current
cause, and holders rotate that cause by private vote every hour, 12 hours, day, three days or week.

## Layout
- `contracts/` — Foundry (Uniswap v4 hook-based launch, fee vault, causes, weekly governance,
  live-donation hook, vault and rotation governor, ENS profile registry and wildcard resolver, Zama FHE voting scheme, community takeover)
- `packages/` — shared TypeScript (`sdk`, `endaoment-client`, `publish` for Swarm/ENS releases,
  `arkiv-registry` for the Arkiv mirror)
- `services/` — `indexer` (Ponder + read-only API) and `publisher` (uploads, Arkiv mirror, tally keeper)
- `packages/ui/` — the component library (Direction A design system; gallery at `/design`)
- `apps/web/` — static-export frontend (served from Swarm behind ENS)
- `infra/` — AWS CDK (indexer, Bee node + gateway, publisher)

See `docs/ARCHITECTURE.md` for how the pieces fit together.

Security reviews, their coverage, every finding and its status: [`docs/SECURITY.md`](docs/SECURITY.md).
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

## Getting started

The original artwork in `apps/web/assets-src/` is stored with [Git LFS](https://git-lfs.com).
Install it once per machine before cloning, or the art files arrive as small text pointers:

```sh
brew install git-lfs        # or your platform's package
git lfs install             # once per machine
git clone https://github.com/camdengrieh/verada.git
cd varada && git lfs pull   # only needed if you cloned before installing LFS
pnpm install
```

Nothing that builds or ships the app needs LFS: the optimised images in `apps/web/public/assets/` are
normal git files. You only need the LFS originals to add or regenerate art (see
[`apps/web/README.md`](apps/web/README.md#art-and-assets)).
