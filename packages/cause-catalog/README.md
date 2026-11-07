# @varada/cause-catalog

Builds the cause catalogue that `CauseCatalog` commits to: every compliant Endaoment organization
with a mainnet address, classified by cause and region and bucketed into a Merkle tree. See
`docs/ARCHITECTURE.md` (Cause catalogue) for how the contracts use it.

## Pipeline

```sh
# 1. Crawl the Endaoment search API into .catalog/harvest (resumable; rerun to continue).
node packages/cause-catalog/bin/varada-catalog.mjs harvest
#    A partial crawl for reviewing the taxonomy:
node packages/cause-catalog/bin/varada-catalog.mjs harvest --max-per-partition 250

# 2. Classify, bucket and build the tree into .catalog/build.
node packages/cause-catalog/bin/varada-catalog.mjs build
node packages/cause-catalog/bin/varada-catalog.mjs stats     # per-category / region / bucket counts

# 3. Upload the snapshot to Swarm (dry run without --execute) and print the owner's calldata.
BEE_POSTAGE_BATCH_ID=... node packages/cause-catalog/bin/varada-catalog.mjs publish --execute
node packages/cause-catalog/bin/varada-catalog.mjs calldata --swarm-ref <reference>
```

`.catalog/` is git-ignored. The crawl partitions by NTEE major group, writes one JSONL file per
group plus `state.json`, and records the counts endpoint's `asOf`; `harvest` prints harvested vs
expected counts per group. Endaoment bans an IP for about ten minutes after a 429, so requests are
spaced (`--interval-ms`, default 1000) and retries back off in minutes. Ask Endaoment for a
workload-specific limit before a full crawl.

## Classification

- Categories and regions are defined once, in `packages/sdk/src/catalog.ts` (`TAXONOMY_VERSION`).
  Changing what a bit means requires a new taxonomy version and a new catalogue version.
- Specific NTEE codes map by prefix. Keywords in the name and description apply when the code is
  missing, unclassified (`Z`), major-group-only (`A00`, `E`) or international (`Q*`).
- `alwaysKeywords` (high-precision phrases such as "wrongful conviction" or "innocence project")
  apply to every org, for causes that organizations file under general codes.
- Regions come from the HQ country. International (`Q*`) orgs also get Global and every region
  their text names (unambiguous place names only).
- `region-overrides.json` corrects individual orgs, keyed by EIN digits or Endaoment id:
  `{ "orgs": { "123456789": { "regions": ["africa"], "categories": ["hunger"], "mode": "add" } } }`
  (`mode` defaults to `replace`).
- Orgs nothing places go to `other`, which tokens with an "any cause" focus include.

## Outputs

`catalog.json` (root, bucket sizes, taxonomy version, stats), `orgs.jsonl` (one org per line, with
its categories, regions and entries) and `tree.json` (the OpenZeppelin `StandardMerkleTree` dump).
`contractFixture()` and `pnpm gen:fixture` regenerate `contracts/test/fixtures/catalog.json`, which
the Solidity tests verify against `CauseCatalog` so the two implementations cannot drift.

## Names (`<label>.org.varada.eth`)

`build` gives every catalogued org an ENS label and writes two more files:

- `labels.json`: the append-only ledger `{ label: orgId }`. Pass the previous build's ledger with
  `--previous-labels <file>`. It defaults to `<out>/labels.json` when that file exists. A label
  never moves to another org. Orgs that leave the catalogue keep their label reserved.
- `names-tree.json`: an OpenZeppelin `StandardMerkleTree` of
  `[bytes32 labelhash, bytes32 orgIdEth, bytes32 orgIdOptimism, bytes32 orgIdBase]`. Its root is
  `meta.namesRoot` in `catalog.json` and `root()` on `VaradaOrgResolver`. The resolver checks a
  gateway proof against it, then computes each chain's address with Endaoment's L1
  OrgFundFactory: `computeOrgAddress(orgId)` gives the same address for a given orgId on
  Ethereum, Optimism and Base. A zero orgId means the org has no record on that chain.

### Per-chain orgIds (`verify-addresses`)

An org's entity on some chain can have been created under a different orgId. For example, NPR on
Base was created under the hyphenated EIN `"52-0907625"`, so its address there differs from
Ethereum and Optimism. Run `verify-addresses` before `build`. It writes a resumable cache to
`.catalog/addresses/`:

- `computed.jsonl`: `computeOrgAddress(orgId)` from the L1 factory, fetched in Multicall3 batches.
- `reads.jsonl`: `orgId()` read from deployed entities whose API address is not the default's.

For each chain c in {1, 10, 8453}, `build` picks:

| Case | orgId_c | Counted as |
|---|---|---|
| The API lists nothing on c | `toOrgId(h)` (deterministic) | default |
| The API address on c equals `computeOrgAddress(toOrgId(h))` | `toOrgId(h)` | default |
| Deployed on c, and the entity's `orgId()` computes back to the API address | that orgId | override |
| Anything else | `0x0` (no record) | unresolved |

`stats.addresses.perChain` counts each case and lists the overrides and unresolved orgs (up to 500
of each). Without the cache, `build` warns and uses `toOrgId(h)` on every chain
(`stats.addresses.verified = false`).

`name-proof --label <label>` prints the proof for one label.

How labels are built:

1. Lowercase ASCII slug of the name. Accents are stripped (NFKD), and a few letters are
   transliterated (`ß`→`ss`, `æ`→`ae`, `ø`→`o`…). `&` becomes `and` and apostrophes are dropped.
   Every other run of characters becomes one `-`.
2. At most 63 bytes, cut at a hyphen where possible.
3. A slug shorter than 3 characters, empty (for example a non-Latin name) or starting with `xn-`
   becomes `org-<ein>`, or `org-<first 8 of the Endaoment id>` when there is no EIN. A purely
   numeric slug becomes `org-<slug>`.
4. Reserved labels are never assigned: www, app, api, admin, varada, endaoment, agent, org,
   gateway, docs, mail, root.
5. New orgs are labelled in Endaoment id order. A taken label gets `-2`, `-3`… in that order.

## Rank

Each org gets `rank`, an integer from 0 to 1000, and `rankSignals`, both computed from the search
listing (`src/rank.ts`). Rank orders browsing and search only; it is never used on-chain. Missing
fields count as 0.

| Signal | Points |
|---|---|
| Lifetime contributions (`lifetimeContributionsUsdc`, 6-decimal USDC) | `450 × min(1, log10(1 + usd) / 7)`; $10M is full marks |
| Donations received | `150 × min(1, log10(1 + n) / 4)`; 10,000 is full marks |
| Grants received | `100 × min(1, log10(1 + n) / 3)`; 1,000 is full marks |
| Claimed Endaoment profile (can receive and withdraw) | 200 |
| `featuredIndex > 0` | 50 |
| Website listed | 25 |
| Description listed | 25 |
