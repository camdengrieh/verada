# Verada

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
- `apps/web/` — static-export frontend (served from Swarm behind ENS)
- `infra/` — AWS CDK (indexer, Bee node + gateway, publisher)

See `docs/ARCHITECTURE.md` for how the pieces fit together.
