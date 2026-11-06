# Varada: how the pieces fit

A map of the code that is not a smart contract: the web app, the component library, the SDK and its
swap engine, the indexer API, and how to run all of it on one machine. For the contracts and the
protocol rules, read [ARCHITECTURE.md](ARCHITECTURE.md). For what the swap engine does in detail, read
[SWAP.md](SWAP.md); for what each component can see about a user, [PRIVACY.md](PRIVACY.md). This page
links to both and does not repeat them.

```
                       browser (static files from Swarm, resolved through ENS)
                       apps/web  ──uses──>  @varada/ui   (presentational components)
                          │  └────uses──>  @varada/sdk  (ABIs, fee math, swap engine, ENS, Swarm refs)
          reads/writes    │
   ┌──────────────────────┼───────────────────────────────┐
   │ private RPC          │ HTTPS GET                     │ HTTPS POST
   ▼ (public-scope and    ▼                               ▼
 Ethereum mainnet     services/indexer                services/publisher
 (wallet txs go       (Ponder + /api/*)               (logo/metadata uploads, tally
  through the wallet)  reads contract events           keeper, Arkiv mirror, x402
                                                       facilitator)
```

There is no application server. The only always-on read path is the indexer; the browser falls back
to direct chain reads when it is down.

## Workspaces

| Path | Package | Role |
|---|---|---|
| `apps/web` | `@varada/web` | Next.js static export. Pages, hooks, data clients, wallet. [README](../apps/web/README.md) |
| `packages/ui` | `@varada/ui` | Component library and design tokens. [README](../packages/ui/README.md) |
| `packages/sdk` | `@varada/sdk` | ABIs, addresses, fee and ballot math, ENS and Swarm helpers, the swap engine (`src/swap`). TypeScript source, no build step |
| `services/indexer` | `@varada/indexer` | Ponder indexer and the read-only `/api/*` layer. [README](../services/indexer/README.md) |
| `services/publisher` | `@varada/publisher` | Uploads to Swarm, tally keeper, Arkiv mirror, x402 facilitator. [README](../services/publisher/README.md) |
| `packages/publish` | `@varada/publish` | Release tooling: validate, upload and ENS contenthash for the static export. [README](../packages/publish/README.md) |
| `packages/cause-catalog`, `packages/curator`, `packages/endaoment-client`, `packages/arkiv-registry` | | Catalogue builder, curator agent CLI, Endaoment client, Arkiv schemas |
| `contracts` | | Foundry project |
| `infra` | `@varada/infra` | AWS CDK app (indexer, Bee gateway, publisher) |

## App shell (`apps/web`)

`src/app/layout.tsx` renders `<Providers><AppShell>{children}</AppShell></Providers>` and links the
self-hosted fonts. Every route is a client component under `src/app/<route>/page.tsx`.

- **`Providers`** (`components/providers.tsx`) fetches `config.json` once, validates it with zod,
  merges it over the `NEXT_PUBLIC_*` build defaults, and only then mounts wagmi, react-query, the
  private RPC (`lib/private-rpc.ts`) and the data clients (`createDeps` in `lib/data.ts`: the indexer
  client plus chain reads). It shows the library's loading screen until the config is in. Hooks:
  `useAppConfig`, `useDeps`, `usePrivateRpc`, `usePrivacyPrefs`.
- **`AppShell`** (`components/app-shell.tsx`) wraps the page in the library's `AssetProvider`
  (resolves `assets/...` against the site root), `SiteHeader` (nav, coin search, privacy menu, wallet
  button), the Cmd/Ctrl+K command palette, the mobile `BottomTabBar` and the toaster. The active tab
  is computed from the pathname without assuming any prefix (`activeRoute`).
- **Relative URLs.** The same build is served at `/bzz/<ref>/`, on a bzz subdomain and at an ENS
  gateway root, so nothing may be root-absolute. Navigation uses plain relative anchors
  (`components/nav.tsx`), `siteBase()` (`lib/base.ts`) resolves runtime URLs, and
  `scripts/postexport.mjs` rewrites the exported HTML and the webpack public path. Details in the
  [web README](../apps/web/README.md#static-export-and-swarm).
- **Routes:** `/` (discover, or a token page on a `<label>.varada.eth` gateway host), `/launch/`,
  `/token/?address=0x...`, `/causes/`, `/governance/`, `/agent/...`, `/design/` (component gallery).
- **Token page** (`components/token/*`): hero, a trade ticket (`ConnectedTradePanel`, below), market
  figures and chart, and tabs for trades, holders, impact, governance and about (plus manage for a
token's controller or editor). Market,
  trades and holders come from the indexer (`useMarket`, `useTradeTape`, `useHolders` in
  `components/token/use-token-data.ts`); there is no per-token RPC fallback for them, so they show an
  empty state when the indexer is unreachable.
- **Data rules.** The indexer is read first; address-keyed reads (voting weight, balances,
  `hasVoted`) go through an account-scoped client over the private RPC and never reach the indexer.
  "My trades" filters the public trade list in the browser. See [PRIVACY.md](PRIVACY.md).

## `@varada/ui`

A presentational library: components take data, link components and callbacks as props and never
fetch, read the chain or load third-party URLs. The app imports by path
(`@varada/ui/components/varada/trade-panel`) and Next transpiles the TypeScript source
(`transpilePackages`). Folders: `components/ui` (primitives and overlays), `components/data`,
`components/motion`, `components/mobile`, `components/varada` (shell, coins, trading, trades and
holders, causes, voting, ENS), `lib`, and `styles.css` (tokens and the Tailwind v4 theme).
Components size themselves with container queries, not the viewport. Every component and state is
on the `/design` page. See the [library README](../packages/ui/README.md) for usage and for how to add
a component.

## `@varada/sdk` and the swap engine

The SDK has no React and no network assumptions beyond a viem-style client.

- Protocol: ABIs (`@varada/sdk/abis`), addresses, fee math (`feeMath.ts`), epoch and ballot planning
  (`epoch.ts`, `ballot-prep.ts`), catalogue and agent helpers, ENS and Swarm helpers.
- **Swap engine** (`src/swap`): pool keys and state, fee reads, route discovery over existing Uniswap
  v4 pools, quotes through the V4Quoter, Universal Router calldata, Permit2 planning, Ondo
  compliance checks, error mapping. `quoteTrade` runs the whole pipeline. How it routes, what it
  assumes and what is not covered: [SWAP.md](SWAP.md).
- App glue: `apps/web/src/lib/swap` (amounts, market snapshots, depth, USD prices, trade requests),
  `apps/web/src/hooks/use-swap*.ts(x)` (clients, registry assets, balances, quote, execution) and
  `components/swap/ConnectedTradePanel`, which wires the library's `TradePanel`, price impact ladder
  and liquidity panel to those hooks. Mount it with the token only.

## Indexer API

Ponder indexes the contracts into Postgres (PGlite in local dev). `src/api/routes.ts` serves a
read-only Hono API under `/api/*`: GET only, CORS, per-IP rate limit, cursor pagination, weak ETags,
bigints as decimal strings. No route takes the viewer's wallet address. Full request and response
shapes are in the [indexer README](../services/indexer/README.md#http-api); the groups are:

| Group | Routes |
|---|---|
| Tokens | `/api/tokens`, `/api/tokens/:address`, `/api/tokens/by-label/:label`, `/api/discover` (token list with market summary in one request), `/api/stats`, `/api/active-tokens` |
| Market, trades, holders | `/api/tokens/:address/market?hours`, `/api/tokens/:address/trades?side&cursor&limit`, `/api/tokens/:address/holders`, `/api/tokens/:address/holders/summary` |
| Activity | `/api/activity`, `/api/activity/stream` (Server-Sent Events) |
| Giving and governance | `/api/causes`, `/api/causes/search`, `/api/causes/leaderboard`, `/api/epochs/:token[/:epoch]`, `/api/takeovers/:token[/:id]`, `/api/polls/...`, `/api/live/:token` |
| Catalogue | `/api/catalog`, `/search`, `/pool`, `/entries`, `/causes`, `/orgs/:id` |
| Curator agents | `/api/agents`, `/api/agents/:label`, `/api/agents/:label/reports/:epoch`, `/api/agents/:label/picks/:epoch/:region` |
| Other | `/api/health`; the legacy unversioned routes and `/graphql`; the `/x402/*` paid routes |

Trades and holders: every token is indexed as a child of `TokenCreated` twice, once for its ERC-20
`Transfer` events (holder balances, holder counts) and once for transfers into or out of the
PoolManager, from which each pool `Swap` is read (trades, and the hourly market rows behind `/market`). The web app's `IndexerClient` (`apps/web/src/lib/indexer.ts`)
validates every response and fails over across `indexerUrls`.

## Running everything locally

### One command: `pnpm dev:up`

A complete local stack on a fork of mainnet, for trying the app end to end:

```sh
export FORK_RPC_URL=<a mainnet RPC URL>    # or put FORK_RPC_URL=... in a gitignored .env.local at the repo root
pnpm dev:up      # about 1 minute warm; the first run also installs dependencies and compiles the contracts (10+ minutes)
pnpm dev:down    # stops everything it started
```

`dev:up` (`tools/dev/up.mjs`) does, in order, and stops with the tail of the failing log if a step fails:

1. **Preflight**: `anvil`, `forge`, `cast` and `pnpm` on the PATH; a Node 22.12+ for Ponder (the running Node if it
   is new enough, else `NODE22_BIN`, else the newest 22+ under `~/.nvm`); missing dependencies are installed
   (`pnpm install` under that Node 22, contract submodules, `pnpm install --ignore-workspace` in `contracts/`).
2. **Ports**: three random free ports above 20000 (anvil, indexer, web). Pin one with `DEV_ANVIL_PORT`,
   `DEV_INDEXER_PORT` or `DEV_WEB_PORT`; a pinned port that is busy is an error, not a silent change.
3. **anvil** forked from `FORK_RPC_URL` (chain id 1, `--auto-impersonate`; `FORK_BLOCK_NUMBER` pins the block).
   The URL goes to anvil only. Every log line and message is scrubbed of it, its path segments (API keys) and
   its credentials, so a banner or an upstream error never leaks it.
4. **Test wallet**: a fresh random key (`cast wallet new`, never an anvil dev account, which carry EIP-7702
   delegations on mainnet forks), funded with 1000 ETH and 100,000 USDC. The key lives in `.dev/test-key`
   (mode 600) and is deleted by `dev:down`.
5. **Deploy**: `contracts/script/E2eFixture.s.sol` (the fixture behind `apps/web/test/fork`) deploys the whole
   system with the wallet as owner, plain-ballot mock voting scheme, a two-organisation catalogue, one curator
   agent and one launched, traded token. The node's clock is then moved to two hours into epoch 1, where the
   fixture's catalogue has a pool. Addresses are copied to `.dev/fixture.json`.
6. **Indexer**: Ponder (`ponder dev`, Node 22) on the fork, `START_BLOCK` the deployment block, every address
   from the fixture, embedded PGlite. Waits for `GET /ready`. `services/indexer/.ponder` is removed first,
   because its sync cache is keyed by chain id 1 and would replay another fork's logs.
7. **Web**: `next dev` with build-time variables pointing at the fork and the indexer, `passthrough` private
   RPC (so no mixnet), `NEXT_PUBLIC_DEV_PLAIN_BALLOTS=true`, `NEXT_PUBLIC_DEV_STACK=true` (the tracked
   `public/config.json` must not override the dev services) and `NEXT_PUBLIC_DEV_WALLET_KEY`. That last one
   makes the app announce a **Varada Dev Wallet** over EIP-6963 (`src/lib/dev-wallet.ts`), so it appears in the
   wallet picker like a browser wallet. The helper page `/dev-wallet/` shows its address and balances and can
   reset the ETH and USDC balance or move the chain clock one hour or one day. The wallet reads and signs
   against the fork directly (not through the private RPC; it is local). Without the key, as in every real
   build, neither the wallet module nor the page exists: `next.config.mjs` inlines the key as empty so the
   bundler drops the module, and only then adds `*.dev.tsx` to the page extensions (`(dev)/dev-wallet`).

It prints the URLs when everything answers. Flags: `--no-indexer` (the app then reads from the chain), `--no-web`.

Processes run detached, one process group each, with logs in `.dev/{anvil,indexer,web,deploy}.log` (gitignored).
`.dev/state.json` records pid and start time of each; `pnpm dev:down` signals a process only when the start
time still matches (a recycled pid is left alone), sends SIGTERM to the group, then SIGKILL after 8 s, and
removes the state and key (`pnpm dev:down --purge` also deletes the logs). Ctrl-C during `dev:up` and any failed step
run the same cleanup; running `dev:up` while a stack is up is refused, and a stale state from a crash is cleared.

Not covered: the publisher (uploads), Swarm, ENS resolution, a real Zama relayer (ballots are plaintext to the
mock scheme) and the cause catalogue API (`CATALOG_SOURCE`).

The rest of this section runs the pieces separately.

Needs Node 22.12 or newer for Ponder (the web app, SDK and tests run on Node 20), pnpm 10, and
Foundry for contracts.

```sh
pnpm install
```

**Web app against a mock indexer** (no RPC key, no contracts). The mock serves the real route layer
over in-memory fixture data (three tokens, activity, and synthetic trades, holders and hourly market
rows), so the token list and token pages render. `/api/discover` and `/api/agents` are not wired in the
mock and answer 503; the home list then falls back to `/api/tokens`, and agent pages have no data.

```sh
pnpm --filter @varada/indexer serve:fixtures 42069   # terminal 1
pnpm --filter @varada/web dev                         # terminal 2, http://localhost:3000
```

`apps/web/public/config.json` points the app at `http://localhost:42069` (indexer) and
`http://localhost:42070` (publisher). Edit that file, or pass another URL with `NEXT_PUBLIC_INDEXER_URLS`
only when `config.json` does not set `indexerUrls`, because the file wins. Chain reads and wallet
actions need a real RPC and wallet; set `rpcUrl`, `factoryAddress` and the other addresses in
`config.json` (see [ENV.md](ENV.md)).

**Static export, served the way Swarm serves it:**

```sh
pnpm --filter @varada/web build            # next build + scripts/postexport.mjs, writes apps/web/out
pnpm --filter @varada/web verify:export    # size budget, relative URLs, an index.html per route
node apps/web/scripts/serve-static.mjs 8080 /bzz/abc123                 # http://localhost:8080/bzz/abc123/
```

**Real indexer** (Ponder, Node 22.12+): `cp services/indexer/.env.example services/indexer/.env.local`,
fill `PONDER_RPC_URL_1`, every contract address and `START_BLOCK`, then
`pnpm --filter @varada/indexer dev` (API on port 42069, PGlite database). `codegen`, `start` and
`serve` are also scripts. Optional `CATALOG_SOURCE` enables `/api/catalog/*`. Run `pnpm install` with
Node 22.12 or newer if you will run Ponder: an install under Node 20 does not fetch Rolldown's native
binding, and `ponder` then stops with "Cannot find native binding".

**Publisher:** `pnpm --filter @varada/publisher dev` (port 42070). Everything is off until its
variables are set; see its README.

**Contracts:** `pnpm build:contracts` and `pnpm test:contracts` (Foundry; submodules under
`contracts/lib`, plus `pnpm install --ignore-workspace` in `contracts/` for the Zama packages).
A mainnet fork with the whole system deployed, for the swap engine's integration tests, is described
in [SWAP.md](SWAP.md#tests).

**Checks, as CI runs them:**

```sh
pnpm typecheck && pnpm test                   # every workspace
pnpm --filter @varada/web build && pnpm --filter @varada/web verify:export
```

Each workspace also has its own `typecheck`, `test` and, for the web app, `lint` scripts.

## Releasing the site

`packages/publish` validates the export, uploads it to Swarm and prints the ENS contenthash
calldata; it is dry-run by default and never signs. The runbook, including the Swarm feed that keeps
one stable contenthash for `varada.eth` and every `<label>.varada.eth`, is in its
[README](../packages/publish/README.md). Environment variables for every component:
[ENV.md](ENV.md).
