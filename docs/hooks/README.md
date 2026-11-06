# Generic Uniswap v4 hooks

A small library of Uniswap v4 hooks, each named for the one thing it does, that any LP, launchpad
or protocol can deploy on its own or combine with the others into a single hook. Solidity 0.8.26,
EVM `cancun`, Uniswap v4 core, MIT licence, built and tested for Ethereum mainnet.

Source: [`contracts/src/hooks`](../../contracts/src/hooks). Tests:
[`contracts/test/hooks`](../../contracts/test/hooks) (over 200 tests against the real v4
`PoolManager` and routers, including fuzz and invariant checks).

## Hooks at a glance

| Hook | What it does | Flags | Extra gas per swap | Standalone example |
| --- | --- | --- | --: | --- |
| [`DecayingFeeHook`](DecayingFeeHook.md) | Dynamic LP fee that decays linearly from a launch fee to a base fee | `beforeInitialize`, `beforeSwap` | ~6,900 | `DecayingFeeExample` |
| [`SwapFeeHook`](SwapFeeHook.md) | Hook fee in bps of the unspecified side of every swap, paid to a recipient | `beforeInitialize`, `afterSwap`, `afterSwapReturnDelta` | ~21,700 (claims), ~22,100 (tokens) | `SwapFeeExample` |
| [`TwapOracleHook`](TwapOracleHook.md) | Per pool time-weighted average tick, `twapTick(poolId, window)` | `afterInitialize`, `beforeSwap` | ~12,900, ~35,700 when it writes a checkpoint | `TwapOracleExample` |
| [`PoolInitGateHook`](AccessGates.md#poolinitgatehook) | Only allowed initializers create pools, plus an overridable pool key rule | `beforeInitialize` | 0 | `PoolInitGateExample` |
| [`LiquidityGateHook`](AccessGates.md#liquiditygatehook) | Per pool allowlist for adding and removing liquidity (locked liquidity) | `beforeInitialize`, `beforeAddLiquidity`, `beforeRemoveLiquidity` | 0 | `LiquidityGateExample` |
| [`FeeConversionHook`](FeeConversionHook.md) | Converts fee claims to one currency inside the swap; holds and retries on failure | `beforeSwap`, `afterSwap` | route dependent | `ConvertingSwapFeeExample` (with `SwapFeeHook`) |
| [`BondingCurveHook`](BondingCurveHook.md) | Reference custom curve through `beforeSwap` return deltas, then graduates | `beforeInitialize`, `beforeAddLiquidity`, `beforeSwap`, `beforeSwapReturnDelta` | not measured | `BondingCurveHook` itself (reference only) |

Flags are what the standalone example's address must encode; `beforeInitialize` on the per pool
features comes from `PoolAdminHook`. Gas is measured against a hookless swap (see [Gas](#gas)).
All examples live in `contracts/src/hooks/examples/`. `LaunchpadHook` there combines the first
five into one hook (~62,300 gas on a checkpoint swap).

## Why a library of features

A v4 pool has exactly one hook address, so most v4 hooks are written as one bespoke contract that
does everything its protocol needs. That code cannot be reused without taking all of it.

These hooks are written as **features** instead: abstract contracts on a shared `BaseHook` that
each do one job and merge cleanly with each other through Solidity inheritance. A protocol picks
the features it needs, lists them in one concrete contract and deploys that. Permissions,
return deltas, LP fee overrides and the reentrancy lock merge by fixed rules, so the result does
not depend on the order of the features. Every feature also ships as a minimal deployable
example, so a single feature can be used as is.

For a production protocol rebuilt on these features, see the case study in
[Varada.md](Varada.md).

## The hooks

| Hook | What it does | Use it when | Per pool config | Swap reverts it can add |
| --- | --- | --- | --- | --- |
| [`DecayingFeeHook`](DecayingFeeHook.md) | Dynamic LP fee that starts high and decays linearly to a base fee | Anti-sniper launch fee that pays LPs; or a plain admin-set dynamic fee (`startFee == endFee`) | yes, pool admin | none |
| [`SwapFeeHook`](SwapFeeHook.md) | Hook fee in bps of the unspecified side of every swap, paid to a recipient as ERC-6909 claims or tokens (input-side fees of exact-output swaps are always claims) | Protocol, creator, treasury or referral fee on top of the LP fee | yes, pool admin | only with token settlement (a reverting recipient), or from your `_swapFeeBps` / `_onSwapFeeTaken` overrides |
| [`TwapOracleHook`](TwapOracleHook.md) | Per pool tick accumulator with a ring buffer of checkpoints; `twapTick(poolId, window)` | A manipulation-resistant price for lending, guards, conversions, dashboards | none (constructor: interval, capacity) | none |
| [`PoolInitGateHook`](AccessGates.md#poolinitgatehook) | Only allowed initializers may create pools with this hook, plus an overridable pool key rule | Factory-only pools, allowed quote lists, one pool per token | hook level (your access control) | none (initialization only) |
| [`LiquidityGateHook`](AccessGates.md#liquiditygatehook) | Per pool allowlist for adding and/or removing liquidity | Locked launch liquidity, permissioned or KYC'd LP vaults | yes, pool admin | none (liquidity only) |
| [`FeeConversionHook`](FeeConversionHook.md) | Converts fee claims the hook holds into one target currency inside the swap that earned them, through hookless pools under a price guard; holds and retries on any failure | Fees must end up in one currency (a stablecoin treasury, a donation vault) without an off-chain keeper | hook level (routes, guard) | `InsufficientGas` only |
| [`BondingCurveHook`](BondingCurveHook.md) (example) | Prices the pool with a virtual constant-product curve through `beforeSwap` return deltas, then graduates | Learning the custom curve pattern; a starting point to fork. **Reference only, not audited, not used in production** | yes, pool admin | curve errors (see its page) |

Shared base contracts, documented in [BaseHook.md](BaseHook.md):

| Contract | Role |
| --- | --- |
| `BaseHook` | Implements `IHooks`, pool-manager-only entry points, address check of the merged permissions, merge helpers, the shared transient lock |
| `PoolAdminHook` | Records the caller of `PoolManager.initialize` as the pool's admin; `onlyPoolAdmin(key)`, `transferPoolAdmin` (zero renounces and freezes config) |
| `LinearDecay` (library) | `value(start, end, duration, startTime, now)`, the rounded-up linear ramp used by `DecayingFeeHook`, reusable for any schedule |
| `ITwapOracle` (interface) | The read interface of `TwapOracleHook` for consumers |

Deployable examples in `contracts/src/hooks/examples/`:

| Example | Composition |
| --- | --- |
| `DecayingFeeExample` | `DecayingFeeHook` |
| `SwapFeeExample` | `SwapFeeHook` |
| `TwapOracleExample` | `TwapOracleHook(5 minutes, 24)` |
| `PoolInitGateExample` | `PoolInitGateHook, Ownable` |
| `LiquidityGateExample` | `LiquidityGateHook` |
| `ConvertingSwapFeeExample` | `SwapFeeHook, FeeConversionHook, Ownable` |
| `LaunchpadHook` | `PoolInitGateHook, LiquidityGateHook, TwapOracleHook, DecayingFeeHook, SwapFeeHook, Ownable` |
| `BondingCurveHook` | `PoolAdminHook, IUnlockCallback` plus its own curve (reference only) |

## Permission flags

v4 reads a hook's callbacks from the low 14 bits of its address. A concrete hook's flags are the
OR of its features' flags; `getHookPermissions()` returns the merged set and the `BaseHook`
constructor reverts unless the deployed address encodes exactly that set. Mine the address with
`contracts/script/HookMiner.sol` (see [ComposeYourOwn.md](ComposeYourOwn.md#4-mine-the-address)).

| Feature | beforeInitialize | afterInitialize | beforeAddLiquidity | beforeRemoveLiquidity | beforeSwap | afterSwap | beforeSwapReturnDelta | afterSwapReturnDelta |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `PoolAdminHook` | x | | | | | | | |
| `DecayingFeeHook` | x | | | | x | | | |
| `SwapFeeHook` | x | | | | | x | | x |
| `TwapOracleHook` | | x | | | x | | | |
| `PoolInitGateHook` | x | | | | | | | |
| `LiquidityGateHook` | x | | x | x | | | | |
| `FeeConversionHook` | | | | | x | x | | |
| `BondingCurveHook` | x | | x | | x | | x | |

`x` under `beforeInitialize` for the per pool features comes from `PoolAdminHook`. No feature uses
the donate callbacks or the liquidity return deltas; a protocol adds them with a feature of its
own (the compose guide adds a donation block in three lines).

## How composition works, in one screen

```solidity
contract MyPoolHook is TwapOracleHook, DecayingFeeHook, SwapFeeHook {
    constructor(IPoolManager m) BaseHook(m) TwapOracleHook(5 minutes, 24) {}
    // plus one super-only re-declaration per shared callback (see ComposeYourOwn.md)
}
```

- **Callbacks** run every feature once, in inheritance order; each feature calls `super` first.
- **Permissions** are OR-merged; features only ever set flags.
- **Deltas** are summed, each computed from the pool's own swap delta, so a 1% and a 2% hook fee
  take 3% of the same amount and never compound.
- **LP fee overrides** merge to the highest fee, whatever the order.
- **Reentrancy**: one transient lock shared by all features; any feature can turn on a swap span
  lock that blocks nested swaps on every pool of the hook.

The full rules are in [DESIGN.md](DESIGN.md#the-composition-rule) and in the NatSpec of
`BaseHook.sol`. [Composition.md](Composition.md) is the reference walkthrough on `LaunchpadHook`;
[ComposeYourOwn.md](ComposeYourOwn.md) is the hands-on tutorial.

## Installation

The feature hooks depend only on Uniswap v4 core. The examples that pick an access-control
scheme (`PoolInitGateExample`, `ConvertingSwapFeeExample`, `LaunchpadHook`) and the bonding curve
also use OpenZeppelin Contracts (`Ownable`, `SafeERC20`).

There are two ways in. `forge install` clones the GitHub repository, so it only works while the
repository is **public** (or you have git credentials for it) and only for a ref that contains
`contracts/src/hooks`. If either is not true for you, copy the folder (Option B): the hooks are
plain Solidity files with relative imports and need nothing from the rest of the repository
besides v4 core (and OpenZeppelin for the examples).

### Option A: forge install

```sh
forge install camdengrieh/varada@<commit-or-tag>   # pin the ref you reviewed
```

The hooks live in a subfolder of this monorepo, so add remappings yourself (in `foundry.toml` or
`remappings.txt`):

```toml
remappings = [
  "v4-hooks/=lib/varada/contracts/src/hooks/",
  "v4-hooks-script/=lib/varada/contracts/script/",            # HookMiner
  "v4-core/=lib/v4-core/src/",                                  # or lib/varada/contracts/lib/v4-core/src/
  "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/", # examples only
]
```

```solidity
import {BaseHook} from "v4-hooks/base/BaseHook.sol";
import {SwapFeeHook} from "v4-hooks/fee/SwapFeeHook.sol";
import {HookMiner} from "v4-hooks-script/HookMiner.sol";
```

If you do not have v4 core yet, the nested copy works: `forge install` fetches this repo's
submodules, so `lib/varada/contracts/lib/v4-core/src/` and
`lib/varada/contracts/lib/openzeppelin-contracts/contracts/` exist after the install. This exact
remapping set is what the compose tutorial was compiled and tested with.

Compiler settings: `solc 0.8.26` (sources use `^0.8.26`), `evm_version = "cancun"` (transient
storage for the lock). `via_ir` is not required.

### Option B: copy the folder

Works with a private repository, a download of the sources or a review copy:

```sh
cp -R varada/contracts/src/hooks        my-project/src/hooks
cp    varada/contracts/script/HookMiner.sol my-project/script/   # optional, the address miner
cd my-project
forge install uniswap/v4-core@bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6   # the tested commit
forge install OpenZeppelin/openzeppelin-contracts                          # examples only
```

The v4 core commit above is the one the library is built and tested against; other commits are
untested.

```toml
remappings = [
  "v4-core/=lib/v4-core/src/",
  "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/", # examples only
]
```

The files import each other with relative paths and v4 core as `v4-core/...`, so these two
remappings are all they need; import them from your own path (`import {SwapFeeHook} from
"./hooks/fee/SwapFeeHook.sol";` or a `v4-hooks/=src/hooks/` remapping). `HookMiner.sol` imports
nothing. Keep the `SPDX-License-Identifier: MIT` headers.

### Build and test the library itself

```sh
git clone https://github.com/camdengrieh/verada.git && cd verada/contracts
git submodule update --init --recursive
FOUNDRY_PROFILE=hooks forge build        # src/hooks only, no via_ir, a few seconds
FOUNDRY_PROFILE=hooks forge test         # test/hooks
```

## Gas

Measured with forge (solc 0.8.26, optimizer 200 runs, no `via_ir`) on an exact-input swap through
the v4 `PoolSwapTest` router, with the pool manager, router, tokens and hook marked cold as in a
fresh transaction. Baseline: the same swap on a hookless pool, 91,681 gas.

| Hook | Extra gas per swap | Notes |
| --- | --: | --- |
| `DecayingFeeHook` | ~6,900 | one hook call, one storage read, the decay math |
| `TwapOracleHook`, no new checkpoint | ~12,900 | accrues the tick into one state slot |
| `TwapOracleHook`, writes a checkpoint | ~35,700 | at most once per `observationInterval`; cheaper once the ring buffer wraps (overwrites a used slot) |
| `SwapFeeHook`, fee as claims | ~21,700 | `mint` of ERC-6909 claims, return delta, event |
| `SwapFeeHook`, fee as tokens | ~22,100 | `take` (ERC-20 transfer) instead of `mint`; exact-output swaps mint claims instead |
| `LaunchpadHook` (five features, checkpoint swap) | ~62,300 | one hook call per callback for all features |
| `FeeConversionHook` | route dependent | a converted fee runs one v4 swap per hop (1 to 3) inside the swap; the swap needs `conversionGasRequired()` (770,317 by default) left at `afterSwap`, else it reverts `InsufficientGas`, so wallets must estimate gas rather than use a fixed limit |
| Access gates | 0 on swaps | they only run on initialize and modify liquidity |

Composed hooks pay the v4 per-callback cost once, not once per feature, so a composition costs
less than the sum of its standalone examples.

## Security notes and trust assumptions

Applies to every hook:

- Every `IHooks` entry point is `onlyPoolManager`. Every per pool config entry point takes a
  `PoolKey` and checks `key.hooks == address(this)`, so a pool of another hook cannot be
  configured through this one.
- No owner upgrades, no proxies, no `delegatecall`, no `selfdestruct`. Hook-level config is
  `internal`; the concrete hook decides who can call it.
- Native ETH (`address(0)`) is supported wherever a `Currency` is accepted.
- `sender` in every callback is the caller of the pool manager (a router, the position manager,
  a factory), never the end user. Gates, exemptions and per-sender rules apply to that contract.
- Each feature lists every revert it can add to a trader's swap on its page.

Who you trust, per hook:

| Hook | Trusted party | What they can do | How to remove the trust |
| --- | --- | --- | --- |
| `PoolAdminHook` (all per pool features) | the pool admin (the account that called `PoolManager.initialize`) | change that pool's config at any time | `transferPoolAdmin(key, address(0))` freezes it; check `poolAdmin(poolId) == address(0)` |
| `DecayingFeeHook` | pool admin | set a new schedule, up to a 100% LP fee | renounce; traders always use slippage limits |
| `SwapFeeHook` | pool admin | rate up to `_maxSwapFeeBps()` (10% default), recipient, claims or tokens | renounce, or override `_isPoolAdmin` |
| `TwapOracleHook` | nobody | | consumers must still handle `ok == false` and pick a window long against multi-block manipulation |
| `PoolInitGateHook` | the concrete hook's owner scheme | allow initializers; no effect on existing pools | a fixed initializer set, or renounce the owner |
| `LiquidityGateHook` | pool admin | allow or block adders and removers (removal gating also blocks fee collection) | renounce after placing locked liquidity |
| `FeeConversionHook` | the concrete hook's owner scheme, and its price guard | routes, guard bounds, payout | a guard against a reference the trader cannot move within one transaction; holding is always safe |
| `BondingCurveHook` | pool admin | seed until the first buy, receive both reserves at graduation | use a migrator contract as the admin |

The library has extensive tests but **has not had an external audit**. Treat it as you would any
unaudited code that holds value.

## Pages

- [BaseHook.md](BaseHook.md): `BaseHook` and `PoolAdminHook`, the shared lock, merge helpers
- [DecayingFeeHook.md](DecayingFeeHook.md), [SwapFeeHook.md](SwapFeeHook.md),
  [TwapOracleHook.md](TwapOracleHook.md), [AccessGates.md](AccessGates.md),
  [FeeConversionHook.md](FeeConversionHook.md): one page per feature
- [ComposeYourOwn.md](ComposeYourOwn.md): tutorial, three features into one hook, mined, deployed
  and a pool initialized
- [Composition.md](Composition.md): composition reference on `LaunchpadHook`, protocol glue,
  deployment checklist
- [BondingCurveHook.md](BondingCurveHook.md): the custom curve reference and a numeric walkthrough
- [Varada.md](Varada.md): case study, a production launchpad's two hooks rebuilt on the library
- [DESIGN.md](DESIGN.md): the design spec: composition rules and every module's API
