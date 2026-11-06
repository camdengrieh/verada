# Environment variable reference

Which variable belongs to which component, and where its full description lives. Values marked
secret never go in the repository, in `config.json` or in a `NEXT_PUBLIC_*` variable. Every
`.env.example` is the template to copy.

| Component | Reads variables from | Template |
|---|---|---|
| Web app (`apps/web`) | build time (`NEXT_PUBLIC_*`), then `config.json` next to the page | `apps/web/.env.example`, `apps/web/public/config.json` |
| Indexer (`services/indexer`) | process environment (Ponder loads `.env.local`) | `services/indexer/.env.example` |
| Publisher (`services/publisher`) | process environment | no template; table in its [README](../services/publisher/README.md#environment) |
| Publish tool (`packages/publish`) | process environment | [README](../packages/publish/README.md) |
| Contracts scripts (`contracts/script`) | process environment | see each script's header |
| AWS CDK (`infra`) | `-c key=value` context | [README](../infra/README.md#context-values) |

## Web app

Public values only. At startup the app fetches `config.json` and merges it over the `NEXT_PUBLIC_*`
defaults compiled into the build; a key present in `config.json` wins, an invalid file is ignored
whole. Because the file sits in the published bundle, a release can be repointed without a rebuild.

| `config.json` key | Build-time variable | Default | Purpose |
|---|---|---|---|
| `chainId` | `NEXT_PUBLIC_CHAIN_ID` | `1` | Chain id |
| `indexerUrls` | `NEXT_PUBLIC_INDEXER_URLS` | `http://localhost:42069` | Indexer base URLs, comma-separated in the variable, tried in order |
| `rpcUrl` | `NEXT_PUBLIC_RPC_URL` | none | RPC reached through the private RPC network |
| `privateRpc` | `NEXT_PUBLIC_ANON_RPC_NETWORK`, `NEXT_PUBLIC_PRIVATE_RPC_URLS` | `nym`, none | Anonymizing transport (`nym`, `tor-js`, `passthrough` for tests) and the RPCs reached through it. In `config.json`: `{ network, rpcUrls, specifier, workerConfig, bootstrapRpcUrl }` |
| `walletConnectProjectId` | `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | none | WalletConnect project |
| `factoryAddress`, `factoryDeployBlock` | `NEXT_PUBLIC_FACTORY_ADDRESS`, `NEXT_PUBLIC_FACTORY_DEPLOY_BLOCK` | none | `VaradaFactory` and its block, which bounds the log scan of the no-indexer fallback |
| `vaultAddress`, `governorAddress` | `NEXT_PUBLIC_VAULT_ADDRESS`, `NEXT_PUBLIC_GOVERNOR_ADDRESS` | none | `FeeVault`, `EpochGovernor` |
| `profileRegistryAddress` | `NEXT_PUBLIC_PROFILE_REGISTRY_ADDRESS` | none | `TokenProfileRegistry` |
| `votingSchemeAddress` | `NEXT_PUBLIC_VOTING_SCHEME_ADDRESS` | none | `ZamaVotingScheme` |
| `takeoverGovernorAddress` | `NEXT_PUBLIC_TAKEOVER_GOVERNOR_ADDRESS` | none | `TakeoverGovernor` |
| `curatorRegistryAddress` | `NEXT_PUBLIC_CURATOR_REGISTRY_ADDRESS` | none | `CuratorRegistry`; the agent donate form stays disabled without it |
| `publisherUrl` | `NEXT_PUBLIC_PUBLISHER_URL` | none (`http://localhost:42070` in `.env.example` and `public/config.json`) | Logo and metadata uploads |
| `swarmGatewayUrl` | `NEXT_PUBLIC_SWARM_GATEWAY_URL` | none | Swarm read gateway for logos |
| `assetPacks.stocks` | `NEXT_PUBLIC_STOCK_LOGOS_REF` | none | Swarm reference of the stock logo pack |
| `ensParentName` | `NEXT_PUBLIC_ENS_PARENT_NAME` | `varada.eth` | Parent of every token's ENS name; also parses gateway hostnames |
| `zamaRelayerUrl` | `NEXT_PUBLIC_ZAMA_RELAYER_URL` | SDK preset | Relayer override, for example an operator proxy |
| (not settable) | `NEXT_PUBLIC_DEV_PLAIN_BALLOTS` | unset | `true` sends plaintext ballots to the mock scheme. Development only; `config.json` cannot set it. Never set for a published build |

Other variables read by web scripts: `BASE_URLS`, `INDEXER_URL` and `CHROME_PATH` (`scripts/e2e.mjs`,
a browser check that is not part of `pnpm test`).

## Local dev stack (`pnpm dev:up`)

Read by `tools/dev/up.mjs` from the process environment (or a gitignored `.env.local` at the repository
root); see [OVERVIEW.md](OVERVIEW.md#one-command-pnpm-devup).

| Variable | Purpose |
|---|---|
| `FORK_RPC_URL` | Required. Mainnet RPC anvil forks from. Passed to anvil only and scrubbed from every log |
| `FORK_BLOCK_NUMBER` | Optional fork block |
| `DEV_ANVIL_PORT`, `DEV_INDEXER_PORT`, `DEV_WEB_PORT` | Optional fixed ports (default: random free ports above 20000) |
| `NODE22_BIN` | Optional Node 22.12+ binary for Ponder when the running Node is older |
| `NEXT_PUBLIC_DEV_STACK` | `true` makes the web app ignore `config.json`. Set by `dev:up`; never for a published build |
| `NEXT_PUBLIC_DEV_WALLET_KEY` | Throwaway key of the dev wallet the app announces over EIP-6963. Set by `dev:up`; never for a published build |

## Indexer

Required to run Ponder (full descriptions in the [README](../services/indexer/README.md#environment)):
`PONDER_RPC_URL_1`, `START_BLOCK`, and the contract addresses `FACTORY_ADDRESS`, `FEE_VAULT_ADDRESS`,
`FEE_CONSOLIDATOR_ADDRESS`, `QUOTE_REGISTRY_ADDRESS`, `CAUSE_REGISTRY_ADDRESS`, `EPOCH_GOVERNOR_ADDRESS`,
`DONATION_DISTRIBUTOR_ADDRESS`, `TOKEN_REGISTRY_ADDRESS`, `CAUSE_CATALOG_ADDRESS`,
`CURATOR_REGISTRY_ADDRESS`, `VOTING_SCHEME_ADDRESS`, `TAKEOVER_GOVERNOR_ADDRESS`. Optional:
`ROTATION_GOVERNOR_ADDRESS` (live-donation tokens), `DATABASE_URL` (PGlite when unset),
`DATABASE_SCHEMA` (required by `ponder start`), `PORT` (42069).

HTTP layer (all optional; defaults from `src/api/config.ts`):

| Variable | Default | Purpose |
|---|---|---|
| `CORS_ALLOWED_ORIGINS` | any origin | Comma-separated origins and `*.` suffix patterns |
| `RATE_LIMIT_RPS`, `RATE_LIMIT_BURST` | `5`, `60` | Per-IP token bucket |
| `TRUST_PROXY_HOPS` | `1` | Proxy hops trusted in `X-Forwarded-For` (`1` behind the ALB, `0` to ignore the header) |
| `MAX_URL_LENGTH` | `2048` | Longest accepted URL |
| `ENDAOMENT_API_URL`, `ENDAOMENT_API_KEY` | production API, none | Endaoment search proxy; the key is secret and never returned |
| `SEARCH_CACHE_TTL_SECONDS`, `SEARCH_CACHE_MAX_ENTRIES` | `300`, `500` | Search proxy cache |
| `SSE_MAX_CLIENTS`, `SSE_POLL_MS`, `SSE_HEARTBEAT_MS`, `SSE_MAX_AGE_MS` | `500`, `2000`, `15000`, `300000` | Server-Sent Events stream limits |
| `CATALOG_SOURCE` | none | Catalogue snapshot (directory or Swarm gateway URL, comma-separated for several); `/api/catalog/*` answers 503 without it |
| `SWARM_GATEWAY_URL` | none | Gateway used to fetch curator reports for `/api/agents/...` |
| `ENS_PARENT_NAME` | `varada.eth` | Parent name for agent and token labels |
| `ETH_RPC_URL` | none | Used when `PONDER_RPC_URL_1` is unset |

x402 paid routes (`/x402/v1/*`), off unless `X402_ENABLED=true` and at least one pay-to address is set:
`X402_BASE_PAY_TO`, `X402_MAINNET_PAY_TO` (needs `X402_MAINNET_FACILITATOR_URL`, the publisher's
`https://<host>/x402`, and `X402_MAINNET_FACILITATOR_TOKEN`, a secret shared with the publisher),
`X402_BASE_NETWORK` (`eip155:8453`), `X402_MAINNET_NETWORK` (`eip155:1`), `X402_BASE_FACILITATOR_URL`
(Coinbase CDP when unset, with secrets `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`), prices in USD
`X402_PRICE_RANKINGS` (0.01), `X402_PRICE_HISTORY` (0.10), `X402_PRICE_CATALOG` (0.50),
`X402_PRICE_NEWSLETTERS` (0.02), and `X402_MAINNET_MIN_PRICE` (0.50). The web app never calls these routes.

## Publisher

About fifty variables, all optional, each job off until its own are set. The complete table with
defaults, and which are secret, is in the [publisher README](../services/publisher/README.md#environment).
Groups: uploads (`BEE_GATEWAY_URL`, `BEE_GATEWAY_AUTH_SECRET`, `BEE_STAMPS_URL`, `SWARM_BATCH_ID`,
`PUBLIC_GATEWAY_URL`), HTTP (`PORT` 42070, `CORS_ALLOWED_ORIGINS`, `RATE_LIMIT_*`, `TRUST_PROXY_HOPS`,
`MAX_*_BYTES`), Arkiv mirror (`ARKIV_*`, `INDEXER_URL`), tally keeper (`KEEPER_*`, `ETH_RPC_URL`,
governor and factory addresses, `ZAMA_RELAYER_*`) and the x402 facilitator (`X402_FACILITATOR_*`,
`X402_ONECLAW_*`, `ONECLAW_BASE_URL`).

## Release and curator tooling

| Variable | Used by | Purpose |
|---|---|---|
| `BEE_URL` (default `http://localhost:1633`), `BEE_POSTAGE_BATCH_ID` | `varada-publish upload`, `upload-pack` | Your Bee node and postage batch id (an identifier, not a key) |
| `SITE_FEED_PRIVATE_KEY` | `varada-publish feed-update` | Secret; signs Swarm feed chunks only, holds no funds |
| `ETH_RPC_URL` | `varada-publish ens-contenthash`, `verify` | Read-only ENS lookups |
| `ONECLAW_AGENT_ID`, `ONECLAW_API_KEY`, `ONECLAW_BASE_URL` | `varada-curator` | The agent's 1Claw identity; the API key is secret. See [agents/README.md](../agents/README.md) |
| `ETH_RPC_URL`, `CURATOR_REGISTRY_ADDRESS`, `CATALOG_SOURCE`, `PUBLISHER_URL` | `varada-curator` | RPC, registry, catalogue snapshot and report upload target |
| `ENDAOMENT_API_URL`, `ENDAOMENT_API_KEY`, `BEE_URL`, `BEE_POSTAGE_BATCH_ID` | `varada-catalog` | Endaoment API (the key is secret) and the Swarm upload of the catalogue snapshot |
| `SWAP_FORK_FIXTURE`, `PLATFORM_TREASURY` | `contracts/script/SwapForkFixture.s.sol` | Fork-only fixture; refuses to run without `SWAP_FORK_FIXTURE=1` |
| `FORK_RPC_URL` | `packages/sdk/test/swap.fork.test.ts` | Enables the mainnet-fork swap tests; see [SWAP.md](SWAP.md#tests) |
