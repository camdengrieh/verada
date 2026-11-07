# @varada/web

Static-export Next.js app (app router). There is no web server: the `out/` folder is published to
Ethereum Swarm and resolved through an ENS name's contenthash. The only always-on backend is the
indexer; browsers call it over HTTPS and fall back to direct chain reads (wagmi/viem) when it is down
(market, trades and holders have no chain fallback and show an empty state instead).
Images ship only as optimised copies under `assets/`, within a size budget (see Art and assets).

How this app relates to `@varada/ui`, `@varada/sdk` and the indexer, and how to run the whole stack:
[`docs/OVERVIEW.md`](../../docs/OVERVIEW.md). Every variable and `config.json` key:
[`docs/ENV.md`](../../docs/ENV.md).

## Run it locally

```sh
pnpm install                                                              # once, from the repository root
pnpm --filter @varada/indexer serve:fixtures 42069   # mock indexer, terminal 1
pnpm --filter @varada/web dev                         # terminal 2, http://localhost:3000
```

`public/config.json` points at the indexer on 42069 and the publisher on 42070. The mock indexer serves
three fixture tokens, activity, and synthetic trades, holders and market rows, so the home list and token
pages render with no RPC key (it does not serve `/api/discover` or `/api/agents`: the home list falls back
to `/api/tokens` and agent pages have no data); wallet actions and live chain reads need `rpcUrl` and the contract addresses (see Runtime
configuration). To use another port, change `indexerUrls` in `public/config.json` (local edit, do not
commit); `NEXT_PUBLIC_INDEXER_URLS` is ignored while the file sets `indexerUrls`.

To see the exported site the way Swarm serves it (exact paths, directory indexes, `404.html` as the
error document, optionally under a `/bzz/<ref>/` prefix):

```sh
pnpm --filter @varada/web build            # next build, then scripts/postexport.mjs; writes out/
pnpm --filter @varada/web verify:export
node apps/web/scripts/serve-static.mjs 8080 /bzz/abc123      # http://localhost:8080/bzz/abc123/
```

`dev` serves from `/`, so run the exported build to test prefix handling.

## Routes

| Route | Purpose |
|---|---|
| `/` | Discover: hero with platform totals, Trending / New / Stocks & RWA / By cause / Live donation lists with market data (`GET /api/discover`; plain `/api/tokens` then chain-log fallback), live giving; or a token's page when served on its ENS name (see Hostname routing) |
| `/launch/` | Launch wizard (identity, giving mode, pair, cause focus, fees, review): logo and metadata uploads, ENS label, `VaradaFactory.deployToken` or `deployLiveToken` |
| `/token/?address=0x...` | Single client-side token page; the address is read from the query (or `#0x...` hash), or resolved from `?label=` |
| `/causes/` | Cause categories with catalogue counts and totals, the most-given-to leaderboard (`GET /api/causes/leaderboard`), the catalogue browser (category x region x name, offset paging, a filter sheet on phones) and Endaoment search (`GET /api/causes/search`). Filters live in `?category=&region=&q=` |
| `/governance/` | The platform vote: epoch clock, every token's ballot and status, the viewer's weight (account-scoped chain reads), the selected token's ballot with the encrypted vote flow (dialog, bottom sheet on phones), curator picks, takeover polls, results and past winners (`?token=0x...` links a token) |
| `/agent/`, `/agent/<label>/`, `/agent/<label>/<region>/` | The 20 curator agents (`<cause>.agent.<parent>`): vault balances, weekly report with Merkle proofs, donate dialog, credited donors and gifts, ENS identity |
| `/design/` | The `@varada/ui` gallery: every component and state, with the Direction A tokens |
| `/404.html` | Swarm error document (self-contained, no external assets); `/<label>` redirects to `token/?label=<label>` |

## Static export and Swarm

`next.config.mjs`: `output: "export"`, `trailingSlash: true` (each route is `<route>/index.html`, which a
Swarm manifest serves as a directory index), unoptimized images.

Why no `basePath` / `assetPrefix`: both bake one absolute prefix into the build, so the same output could
not serve under `/bzz/<hash>/`, on a bzz gateway subdomain and at an ENS gateway root. Instead
`scripts/postexport.mjs` (run by `build`) makes the output hash-agnostic:

- HTML `/_next/...` references become depth-relative (`./_next/` at the root, `../_next/` one level down).
- The webpack runtime public path is derived from the runtime script's own URL, so lazy chunks load from
  wherever the bundle is served.
- `404.html` is replaced by a self-contained page, because the error document is served at any depth. Its
  inline script (`labelRedirect` in `scripts/postexport.mjs`) sends a one-segment path that passes the label
  rules (`/pepe`, `/bzz/<64-hex>/pepe`, lowercased) to `./token/?label=pepe` (`../` with a trailing
  slash), a relative URL that works on subdomain and path gateways alike. Route names and anything else
  show the 404 content.
- Navigation uses plain relative anchors (`components/nav.tsx`), not `next/link`, which would push absolute
  paths. Runtime URLs (`config.json`) resolve against `siteBase()` in `src/lib/base.ts`.

### Hosting on Swarm and ENS

Publishing is a manual step done with `packages/publish`, never by CI here (CI only builds, validates
and dry-runs the upload). Upload `out/` as a Swarm collection with index document `index.html` and error
document `404.html`:

```sh
node packages/publish/bin/varada-publish.mjs build            # build + validate
node packages/publish/bin/varada-publish.mjs upload --ttl-days 90   # dry run: size, stamp depth, cost
```

`upload --execute` needs your own Bee node and postage batch (`BEE_URL`, `BEE_POSTAGE_BATCH_ID`). The ENS
contenthash is an EIP-1577 value: `0xe4` (swarm-ns) + `01` (CIDv1) + `fa01` (swarm-manifest) + `1b`
(keccak-256) + `20` (32 bytes) + the 32-byte Swarm reference, i.e. `0xe40101fa011b20<reference>` (text form
`bzz://<reference>`). Varada serves one site for `varada.eth` and every `<label>.varada.eth` through its own
resolver, whose default contenthash points at a Swarm feed manifest, so a release is a feed update, not an
on-chain transaction. The tool prints the calldata and never signs. Full runbook:
[`packages/publish/README.md`](../../packages/publish/README.md).

Because one build is served from a gateway root, a `/bzz/<ref>/` path and a label host
(`pepe.varada.eth.limo`), any new code must keep URLs relative (see Hostname routing).

## Runtime configuration

At startup the app fetches `config.json` (next to the page, so it follows the bundle) and merges it over
build-time defaults from `NEXT_PUBLIC_*` (see `.env.example`). Public values only, no secrets.

```json
{
  "chainId": 1,
  "indexerUrls": ["https://indexer-a.example", "https://indexer-b.example"],
  "rpcUrl": "https://...", "factoryAddress": "0x...", "factoryDeployBlock": 0,
  "vaultAddress": "0x...", "governorAddress": "0x...", "donationDistributorAddress": "0x...",
  "publisherUrl": "https://publisher.example", "swarmGatewayUrl": "https://gw.example",
  "assetPacks": { "stocks": "<swarm reference>" },
  "ensParentName": "varada.eth", "profileRegistryAddress": "0x...",
  "votingSchemeAddress": "0x...", "takeoverGovernorAddress": "0x...",
  "curatorRegistryAddress": "0x...", "zamaRelayerUrl": "https://..."
}
```

Also accepted: `walletConnectProjectId` and `privateRpc` (`network`, `rpcUrls`, ...). The complete key to
`NEXT_PUBLIC_*` mapping, with defaults, is in [`docs/ENV.md`](../../docs/ENV.md#web-app).

| Key | `NEXT_PUBLIC_*` | Purpose |
|---|---|---|
| `publisherUrl` | `PUBLISHER_URL` | Publisher base URL for `POST /uploads/logo` and `/uploads/metadata` |
| `swarmGatewayUrl` | `SWARM_GATEWAY_URL` | Public Swarm read gateway; logos load from `<base>/bzz/<logoRef>/` |
| `ensParentName` | `ENS_PARENT_NAME` | Parent name (default `varada.eth`): `<label>.<parent>` names and hostname routing |
| `profileRegistryAddress` | `PROFILE_REGISTRY_ADDRESS` | `TokenProfileRegistry`: label availability, profile fallback reads, profile edits |
| `votingSchemeAddress` | `VOTING_SCHEME_ADDRESS` | `ZamaVotingScheme`: ballots are sent here (an opened poll's own scheme wins) |
| `takeoverGovernorAddress` | `TAKEOVER_GOVERNOR_ADDRESS` | `TakeoverGovernor`: the takeover panel |
| `donationDistributorAddress` | `DONATION_DISTRIBUTOR_ADDRESS` | `DonationDistributor`: with `vaultAddress` (the `FeeVault`) and `governorAddress`, the token page's "Send this epoch's donation" card; hidden when any is unset |
| `zamaRelayerUrl` | `ZAMA_RELAYER_URL` | Optional relayer override; otherwise the SDK's preset for the chain |
| (build time only) | `DEV_PLAIN_BALLOTS` | `true` sends plaintext ballots to the mock scheme. Development only; `config.json` cannot set it |

All values are zod-validated; an invalid or missing file falls back to the defaults. `public/config.json`
ships a local-development default (indexer on 42069, publisher on 42070).

## Discover (home)

`components/discover/*` renders the home page from `GET /api/discover` (one request per cursor page, never per token):

- Tabs and filters live in the query string (`?tab=stocks&pair=NVDAon&category=hunger&region=africa&mode=live&cadence=24h&q=`), read and written without navigating (`lib/discover.ts`: `parseState`, `stateToSearch`, `buildQuery`). The header search and the palette (Cmd/Ctrl+K: coins, causes, pages) set `q` on the home list in place.
- Lists are cards, compact rows or the sortable `DataTable` (cards on phones; the remembered choice is in `localStorage`). Infinite scroll uses an IntersectionObserver sentinel with a Load more button; on phones the list sits in the library `PullToRefresh` and filters in the `FilterSheet`.
- Money is shown in each coin's quote asset (price, market cap, volume 24h, and "liquidity", the quote side of the pool); there is no USD oracle for coins. Only what a coin raised is USDC. A coin that has not traded shows dashes, not zeros.
- Pairs come from the quote registry allowlist (`/quote-assets`) with names, kinds and logos from the SDK and `asset-packs.ts` (`lib/quote-assets.ts`). `lib/quote-markets.ts` adds each asset's fee route (`QuoteRegistry.routeOf`), USD price and depth from the pools along that route (v4 StateView; depth is virtual reserves at the current price), and Ondo's pause state, through the public-scope private RPC. When the chain does not answer, the pair list says so.
- The US session label uses `lib/market-calendar.ts` (2026 holidays only; extend yearly).
- Live strip, donations feed and the total raised use the SSE stream (`lib/activity-stream.ts`; polling when indexer traffic is routed privately). No request carries a wallet address.

## Data layer

- `src/lib/indexer.ts`: client for the indexer contract (`/health`, `/api/tokens`, `/api/discover`,
  `/api/activity`, `/api/causes[/search|/leaderboard]`, `/api/epochs/...`, `/api/stats`, `/api/live/:token`,
  `/api/catalog/...`, `/api/agents/...`, and per token `/trades`, `/holders`, `/holders/summary` and
  `/market`), cursor pagination, ordered failover across `indexerUrls` (network errors and 5xx fail
  over, 4xx does not), bigint values kept as decimal strings. Every response is validated and mapped to
  plain types in this file. Route shapes: the [indexer README](../../services/indexer/README.md#http-api).
- `src/lib/activity-stream.ts`: Server-Sent Events subscription with Last-Event-ID resume (browser
  default), dropping to polling `/api/activity` after repeated SSE errors or without `EventSource`.
- `src/lib/chain-reads.ts` / `src/lib/data.ts`: core reads (token list/detail from `TokenCreated` logs,
  current epoch, cause pool) straight from the chain when the indexer is down. Set `factoryDeployBlock` to
  bound the log scan; the RPC must allow that range.

## Launch flow

`/launch/` is a six-step wizard (`components/launch/`, step rules in `lib/launch-steps.ts`): Identity, Giving (epoch pool, or live donation with a rotation period, a nonzero USDC donation threshold and a first charity that is active in the cause registry), Pair (quote registry allowlist; the start market cap is typed in quote units and becomes the factory's `startTick`, a multiple of 200), Causes (focus of at least two eligible catalogue entries), Fees and Review (gas estimate through the wagmi client, i.e. the private RPC). The numbered list below describes the calls it makes.

1. Logo: the file input posts the image to `{publisherUrl}/uploads/logo` (multipart field `file`,
   PNG/JPEG/WebP, 2 MiB at most; the form prechecks size and type). The preview is a local object URL.
   The returned reference becomes the on-chain `logoRef` (`swarmReferenceToBytes32`).
2. Label: prefilled from `labelFromSymbol(symbol)` until edited, validated with `isValidLabel`, and
   checked against `TokenProfileRegistry.tokenByLabelhash` / `reservationOf` through the public-scope
   private RPC. The form shows the resulting `<label>.<parent>` name.
3. Metadata: on submit, `{ name, symbol, logoRef, description?, website?, twitter?, telegram?, discord? }`
   is posted to `{publisherUrl}/uploads/metadata` and the returned `bzz://` URI becomes `metadataURI`
   (an "override" field in Advanced skips the upload). The document never includes a wallet address,
   and upload requests send no cookies or referrer.
4. Quote asset: WETH by default; other options come from the indexer's `GET /quote-assets?active=true`
   (a static Ondo suggestion list when the route is missing). The factory rejects anything not allowlisted.
5. `deployToken` is sent from the wallet. After the receipt, the `TokenCreated` log gives the address
   and the form links to the token page and to `https://<label>.<parent>.limo/`.

`parseLaunchInput` and `buildMetadataDocument` (`src/lib/launch.ts`) are pure and unit-tested.

## Token page

`components/token-detail.tsx` resolves the token (address, `?label=`, or hostname) and loads its detail,
then renders `components/token/token-view.tsx`, which composes:

- `token/token-hero.tsx`, `token/market-section.tsx`: name, symbol, logo from the Swarm gateway, ENS name,
  headline market figures (price, 24h change, volume, liquidity in the coin's quote asset) and the
  `PriceChart`, all from `GET /api/tokens/:address/market`.
- `token/trade-surface.tsx`: the trade ticket. On desktop it is an aside, on phones a bottom sheet; both
  mount `components/swap/ConnectedTradePanel`, which wires the SDK swap engine (route, quote, Permit2,
  swap, the 90/10 fee split, the anti-sniper surcharge countdown, price impact ladder, liquidity panel)
  to the library `TradePanel`. Engine behaviour: [`docs/SWAP.md`](../../docs/SWAP.md). A swap refreshes the
  trade tape.
- Tabs: `trades-tab.tsx` (trade tape from `/trades` with paging, "my trades" filtered in the browser),
  `holders-tab.tsx` (top holders from `/holders`, concentration and holder history from `/holders/summary`),
  `impact-tab.tsx` (donations), a governance tab (`epoch-panel.tsx` below) and `about-tab.tsx` (text
  records `url`, `description`, `com.twitter`, `org.telegram`, `com.discord`, `com.github` from the indexer
  profile, read through ENS with `getTokenTextRecord` when the indexer has none, plus creator,
  controller, editor, fee and metadata). A Manage tab appears for the controller or editor.
  The data hooks are in `token/use-token-data.ts`.
- `epoch-panel.tsx`: current epoch, options with cause names from `/api/causes` and the catalogue
  (`/api/catalog/causes`), a "ballot not prepared yet" state (only the pins are known until the
  rotation draws are made), poll state, per-option totals once the tally is decrypted, the connected
  account's weight and `hasVoted` (account-scoped client, never the indexer), and the vote form.
- `edit-profile-panel.tsx` (controller or editor): `setText` per key, `setLogoRef` via a new upload
  and, for the controller, `setEditor`. There is no per-token contenthash: every name is the one site.
- `shortlist-editor.tsx` ("Pinned causes", controller): up to 8 catalogue orgs inside the token's
  focus, picked with the catalogue browser; each is saved with its in-focus entry and Merkle proof
  through `EpochGovernor.setShortlist`. Changes take effect from the next epoch once the current
  ballot is prepared.
- `catalog-browser.tsx`: browses the cause catalogue by name, category and region (Causes page, pin
  editor) and the launch form's focus picker, which shows the focus pool size (a launch needs two).
- `token-detail.tsx` shows the token's cause focus.
- `takeover-panel.tsx`: active proposal state (including `Superseded`), parameters with the holding
  period (`lookback`: weight is the smaller of the votes at the snapshot and `lookback` earlier), quorum
  as a share of the proposal's `circulatingWeight`, FOR/AGAINST ballots, `closeProposal` / `recordTally` /
  `execute` / `cancel` when applicable, a propose form, and history from `/api/takeovers/:token`
  (chain fallback: the active proposal only).

The indexer is read first for everything; when it is down the page falls back to registry, governor and
scheme reads through the public-scope private RPC.

## Voting

Ballots go to the voting scheme, sent by the voter: `castBallot(governor, token, scope, ballot)`, where
`scope` is the epoch (epoch governor) or the proposal id (takeover governor).

- `src/lib/ballot.ts` lazily imports `@zama-fhe/sdk` (dynamic `import()`, so pages that never vote do not
  load it) and builds a read-only SDK: `createConfig({ chains: [mainnet preset with
  network = EIP-1193 wrapper over the private public-scope client, relayerUrl = zamaRelayerUrl ?? preset],
  provider: new ViemProvider({ publicClient }), storage: memoryStorage, telemetry: false,
  relayers: { [id]: web({ offloadEncrypt: false, batchRpcCalls: true }) } })`, then
  `sdk.encrypt({ values: [{ type: "euint8", value: choice }], contractAddress: scheme, userAddress: voter })`.
  The ballot is `encodeFheBallot(encryptedValues[0], inputProof)`.
- No webpack changes are needed: `@fhevm/sdk` compiles the TFHE WASM from an embedded base64 module, so
  the export contains only `.js` (several MB of lazy chunks, loaded on the first ballot only; the SDK then fetches the FHE public key, tens of MB, from the relayer).
  Encryption runs on the main thread (`offloadEncrypt: false`) because the SDK's worker URL is not
  rewritten by the static-export post-processing.
- What the user signs: only the `castBallot` transaction. Creating the encrypted input needs no
  signature and costs nothing; the relayer verifies the input proof off-chain. The choice never leaves
  the browser in clear.
- What leaves the browser: the SDK's host-chain reads go through the private RPC (public scope). The FHE
  public key/CRS download and the input-proof request go directly to the Zama relayer (or
  `zamaRelayerUrl`), which therefore sees the IP, the scheme and the voter address (both public in the
  transaction moments later), never the choice. This is a direct third-party request, like the wallet's
  own RPC: point `zamaRelayerUrl` at an operator proxy to avoid it.
- `VoteAdapter` (`src/lib/vote-adapter.ts`) keeps the seam: `zamaVoteAdapter` (default) and, only when the
  build sets `NEXT_PUBLIC_DEV_PLAIN_BALLOTS=true`, `plainVoteAdapter` (`encodePlainBallot`) for the mock
  scheme, marked as not private in the UI.

## Hostname routing

Every `<label>.<parent>` name resolves to the same contenthash, so the root page decides what to show.
`src/lib/host.ts` `tokenLabelFromLocation()` reads `?label=<label>` (for local testing) or parses the
gateway hostname with `parseGatewayHostname(hostname, ensParentName)` (`pepe.varada.eth.limo`,
`.eth.link`, `pepe.varada.bzz.link`). With a label, `/` renders the token page and resolves the address
through ENS (`getTokenAddressByLabel`, public-scope private RPC), then the registry, then the indexer's
`/api/tokens/by-label/:label`. Without one it renders the token list. Try it locally with
`/?label=<label>`. The plain-DNS form `varada.com/<label>` goes through `404.html`, which redirects to
`token/?label=<label>`; the token route resolves the label the same way.

## Privacy notes for these features

- Address-keyed reads (voting weight, `hasVoted`) use `createAccountClient`; the indexer and publisher
  never receive the wallet address. Controller/editor checks compare addresses in the browser.
- Uploads and logo images go to the configured publisher and Swarm gateway (operator-run), which see the
  IP, like the indexer. The Zama relayer is the one third-party service contacted directly (see Voting).

## Checking the private RPC

The header pill shows the read path: "Connecting privately" until the anon-rpc worker is started
(it starts on the first chain read, when a wallet connects, or when "Also route Varada API
requests" is turned on in the pill's popover), then "Private RPC on · <network>", or
"Private RPC failed" with a Retry. The worker's boot log is in the browser console under
`[worker]`. To run that check without a browser session, start the app (`pnpm dev`) and run

```sh
pnpm --filter @varada/web check:private-rpc            # BASE_URL=http://127.0.0.1:3000/ by default
```

It drives headless Chrome (`CHROME_PATH`, needs `playwright-core` like `scripts/e2e.mjs`), turns the
routing switch on, prints the worker log and exits 0 once the pill reads "Private RPC on". The
configured network is `privateRpc.network` (Nox by default, see `docs/PRIVACY.md`).

## Art and assets

Three places, each with one job:

| Path | What it holds | Tracked | Published |
|---|---|---|---|
| `assets-src/` | Full-size originals: `images/background` (scenes), `images/foreground` (cut-outs), `causes` (one icon per catalogue category, named by agent ENS label), `stocks` (Ondo stock and ETF marks, named by symbol), `logo` | Git LFS | Never |
| `public/assets/` | Optimised copies built from the originals | Normal git | Inside the site on Swarm |
| `packs/<name>/` | Large or growing sets (today: `stocks`) built for separate upload | No (build output) | As their own Swarm collection |

`src/lib/assets.generated.ts` (generated, tracked) records each asset's size, the widths per format and a
blur placeholder (`ASSETS`), plus each pack's entries (`PACKS`).

### Adding or changing art

1. Make sure the originals are real files, not LFS pointers: `git lfs install` once, then `git lfs pull`.
2. Put the original in the right `assets-src/` folder (PNG, JPEG or WebP; SVG for vector marks). Use
   lowercase kebab-case names; stock marks use the Ondo symbol, e.g. `NVDAon.png`.
3. Run `pnpm --filter @varada/web assets`. It rewrites `public/assets/`, `packs/` and
   `src/lib/assets.generated.ts`.
4. Commit the original, the new `public/assets/` files and `assets.generated.ts` together. The original
   goes to LFS automatically (`.gitattributes` covers `apps/web/assets-src/**`).
5. If a pack changed, upload it (below) and update its reference in config.

What the script emits:

| Group | Formats and widths |
|---|---|
| Scenes | AVIF 640 and 1280, WebP 960 fallback, inline blur placeholder |
| Cut-outs | AVIF 320 and 640, WebP 320 fallback (transparency kept) |
| Cause icons | WebP 128 and 256 (128 covers 64 px chips on dense screens) |
| Logo, SVG marks | Copied as they are |
| Stock pack | WebP 64 and 128, SVGs as they are, plus `index.json` |

### Size budget

`verify:export` and the publish tool reject the export if `out/assets/` breaks the budget: only `.webp`,
`.avif`, `.svg`, `.woff2` or `.png`; at most 400 KB per file (100 KB for `.png`); at most 5 MB in total.
Binary files anywhere else in `out/` fail the export. Packs have only the per-file limit.

### Asset packs

Packs keep big or growing sets out of the site bundle and are not re-uploaded with each release.

```sh
pnpm --filter @varada/web assets                                   # builds packs/stocks
node packages/publish/bin/varada-publish.mjs upload-pack \
  --dir apps/web/packs/stocks                                      # dry run: validates, estimates the stamp
BEE_URL=… BEE_POSTAGE_BATCH_ID=… node packages/publish/bin/varada-publish.mjs upload-pack \
  --dir apps/web/packs/stocks --execute                            # uploads, prints the reference
```

The upload prints a Swarm reference. Put it in `config.json` as `"assetPacks": { "stocks": "<ref>" }`
(or `NEXT_PUBLIC_STOCK_LOGOS_REF` at build time). The app then loads images from
`<swarmGatewayUrl>/bzz/<ref>/`, like token logos; `stockLogo(config, "NVDAon")` in
`src/lib/asset-packs.ts` returns the URL and `srcSet`, or nothing while the pack isn't configured, so
the UI shows a lettered badge instead.

### Git LFS notes

- Pushes upload LFS objects first. The local `.git/hooks/pre-push` runs the repository checks, then
  passes the refs to `git lfs pre-push`; keep both if you change that hook.
- Without LFS installed, files in `assets-src/` are ~130-byte pointers and `pnpm --filter @varada/web assets`
  fails on them. Builds, tests and CI don't read `assets-src/`, so they're unaffected.
- Full-size originals committed before LFS was turned on remain in git history.
- GitHub's free plan includes 1 GB of LFS storage and 1 GB of downloads a month.

## Scripts

`pnpm --filter @varada/web dev | typecheck | lint | test | build | verify:export | build:verify | assets | e2e`

`e2e` (`scripts/e2e.mjs`) drives a built `out/` in Chrome through `playwright-core`, once at the root and
once under a `/bzz/<ref>/` prefix. It expects `scripts/serve-static.mjs` on `BASE_URLS` and an indexer
(for example the mock) at `INDEXER_URL`, needs a Chrome binary (`CHROME_PATH`) and `playwright-core`,
which is not a dependency of this package (install it yourself), and is not part of CI.

`verify:export` (or `node scripts/verify-export.mjs --build`) checks `out/`: binaries only as budgeted
assets under `assets/` (see Size budget), `index.html` for every route, `404.html` and `config.json` present, no root-absolute `/_next/`
references left, runtime public path patched.

## Governance and agent pages

- `components/governance-panel.tsx` composes `components/governance/*`. Loaders and mappers (epoch clock and status, ballot options for `BallotList`, tally results, history) are pure and live in `src/lib/governance.ts`.
- The viewer's weight and `hasVoted` are read through `createAccountClient` only (`useStanding`); the history comes from the public `/api/activity?kind=epoch|donation` feeds, so no address reaches the indexer.
- Every wallet write goes through `useTx`, which raises a pending/confirmed/reverted `txToast`; `src/lib/tx-errors.ts` turns rejections, wrong networks and known reverts into plain reasons.
- Links inside page components are built with `useSiteRel` (from the real site base); agent pages take `root` from the route.
- Agent vault balances are public chain reads (`balanceOf` on USDC); the donate flow reads the vault from `CuratorRegistry` and runs approve then donate in a dialog. The web app never calls the `/x402` routes.
- The privacy menu opens a full "what goes where" dialog (`src/lib/privacy-routes.ts`) and shows a first-visit explainer, remembered in `privacy-prefs` (`introSeen`).
