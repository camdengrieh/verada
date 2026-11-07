# Org names: `<label>.org.varada.eth`

Every Endaoment org in the cause catalogue gets an ENS name under `org.varada.eth`. The name
resolves to the org's Endaoment entity on Ethereum, Optimism and Base, and is an owned token on
Optimism that we hand to the charity when it claims its Endaoment org.

## How it fits together

```
wallet (any chain) ──► Ethereum Universal Resolver v2
                         .eth ─► varada (ENSv2 UserRegistry) ─► org: resolver = VaradaOrgResolver
VaradaOrgResolver.resolve(<label>.org.varada.eth)
  1. CCIP-Read to the Optimism proof gateways (ours first: /l2, then Unruggable's)
     ─► VaradaOrgNames on Optimism: default org id + overrides for chains 1, 10, 8453
     ─► checked by Unruggable's OP fault-proof verifier (0x7F49…604c, the one ENS uses)
  2. if the name is not in finalized Optimism state yet (~7 days), or no valid proof came back:
     CCIP-Read to our Merkle gateway (/ccip) ─► proof against the names root stored on Ethereum
  3. address on each chain = Endaoment OrgFundFactory.computeOrgAddress(that chain's org id)
```

- **Why per-chain org ids:** Endaoment's factory and org implementation have the same addresses
  on all three chains, so one org id gives one address everywhere. Some orgs, however, have their
  live entity on a chain under a different id. NPR and Clean Air Task Force on Base were created
  with the hyphenated EIN (`"52-0907625"`). `verify-addresses` finds these by reading `orgId()`
  from the deployed entity, and the registry stores them as overrides.
- **Coin types:** ETH (60), Optimism (`0x80000000|10`) and Base (`0x80000000|8453`) only. There
  is no ENSIP-19 default address: funds sent to the address on a chain without Endaoment's
  factory would be stuck.
- **Trust:**
  - A gateway cannot change an address. Optimism data is proven against finalized Optimism
    state, the Merkle fallback is proven against the root the resolver's owner publishes, and the
    address itself is computed on Ethereum.
  - Gateways can only withhold an answer. Withholding the Optimism proof forces the Merkle
    fallback; withholding the Merkle answer as well means the name does not resolve.
- **Wallets** need CCIP-Read, as with every L2 or off-chain ENS name (Basenames included).

## Contracts

| Contract | Chain | Source |
|---|---|---|
| `VaradaOrgNames` (ERC-721, records at fixed slots) | Optimism | `contracts/src/l2/VaradaOrgNames.sol` |
| `VaradaOrgResolver` (hybrid CCIP-Read resolver) | Ethereum | `contracts/src/VaradaOrgResolver.sol` |
| varada.eth `UserRegistry` + `org` entry (ENSv2) | Ethereum | created by `contracts/script/SetupOrgNames.s.sol` |
| Unruggable fetcher (vendored, MIT) | Ethereum | `contracts/src/vendor/unruggable/` |

## Runbook

All on mainnet. Rehearse each step on a fork first.

1. **Catalogue:** finish the harvest, then build. The first build into `.catalog/build` freezes
   label assignment, because labels are append-only.
   ```sh
   node packages/cause-catalog/bin/varada-catalog.mjs verify-addresses
   node packages/cause-catalog/bin/varada-catalog.mjs build
   ```
2. **Gateway:** host `services/org-gateway` (`ORG_BUILD_DIRS`, `ORG_RESOLVER` once known,
   `ETH_RPC_URL`). On AWS this is the opt-in `Varada-<env>-OrgGateway` stack: see
   `infra/ORG_GATEWAY.md` for the Docker image (catalogue baked in) and the deploy recipe. It serves
   the following:
   - `/ccip` (Merkle)
   - `/l2` (Optimism proof proxy, 3 s budget)
   - `/orgs` (ranked API)
   - `/health`
3. **Optimism registry:**
   ```sh
   ORG_NAMES_OWNER=<owner> ORG_NAMES_REGISTRAR=<minting key address> \
     forge script script/DeployOrgNamesOp.s.sol --rpc-url $OP_RPC_URL --broadcast --ledger
   ```
4. **Mint**, highest rank first (dry run without `--execute`):
   ```sh
   # demo subset
   ORG_NAMES_ADDRESS=<registry> OP_PRIVATE_KEY=... pnpm --filter @varada/org-gateway op-mint --limit 1000 --execute
   # everything
   ORG_NAMES_ADDRESS=<registry> OP_PRIVATE_KEY=... pnpm --filter @varada/org-gateway op-mint --execute
   ```
   A name costs ~51k gas (measured): ~0.00005 ETH per 1,000 names at 0.001 gwei.
5. **Ethereum.** Mainnet order, agreed with the site/token-names work:
   1. `Deploy.s.sol` (this reserves `agent`, `org` and `names` in TokenProfileRegistry).
   2. `SetParentResolver.s.sol`: varada.eth → VaradaResolver, so the site and token names go live.
   3. `SetupOrgNames.s.sol`: it adds the varada.eth subregistry with `org`, and never changes
      varada.eth's resolver.

   `test/fork/VaradaNamesV2.t.sol` rehearses exactly this order. For step 3, the varada.eth owner
   runs:
   ```sh
   ORG_NAMES_ROOT=<namesRoot> ORG_GATEWAY_URLS='https://<host>/ccip/{sender}/{data}.json' \
   ORG_L2_REGISTRY=<registry> ORG_L2_GATEWAY_URLS='https://<host>/l2/{sender}/{data}.json,https://optimism.gateway.unruggable.com' \
     forge script script/SetupOrgNames.s.sol --rpc-url $ETH_RPC_URL --broadcast --ledger
   ```
   About 3.6M gas (fork-measured). Then restart the gateway with `ORG_RESOLVER=<resolver>`.
6. **Each new build:**
   1. run `verify-addresses` and `build`
   2. `op-mint` the new names
   3. `setRoot(namesRoot)` on the resolver (~50k gas)
   4. reload the gateway (SIGHUP)

   The previous root stays valid until the next rotation.
7. **Claims:** transfer the charity's token on Optimism (`transferFrom`). Records are unchanged,
   and only registrars can repoint org ids.

## Tests

- `forge test --match-contract 'VaradaOrgResolverTest|VaradaOrgNamesTest'` (unit)
- `ETH_RPC_URL=… forge test --match-contract OrgNamesForkTest`: live ENSv2, Universal Resolver
  v2 and the Endaoment factory. The Optimism verifier's `getStorageValues` is mocked.
- `pnpm --filter @varada/org-gateway test`
- Live check: on an anvil mainnet fork, a viem client with CCIP-Read resolved through the real
  verifier and the real public gateways. They were all failing on 2026-11-07 (Unruggable 403,
  dRPC `_ensureRootClaim` timeout, 3668.io 504). That run proved the fallback path. A real
  Optimism proof can be shown once `VaradaOrgNames` is on Optimism and a name is ~7 days old.
