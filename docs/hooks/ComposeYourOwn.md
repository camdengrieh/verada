# Compose your own hook

A hands-on tutorial: combine three feature hooks into one concrete Uniswap v4 hook, test it, mine
its address, deploy it on Ethereum mainnet and initialize a pool. Every code block on this page
was compiled and run (solc 0.8.26, `cancun`) against the real v4 `PoolManager`, using the
remappings from [README.md](README.md#installation).

The reference version of the same rules, worked on the five-feature `LaunchpadHook`, is
[Composition.md](Composition.md).

## What we build

`MyPoolHook`, for an LP or a DAO launching a pool that wants:

| Need | Feature |
| --- | --- |
| A launch LP fee that starts at 10% and decays to 0.30% over an hour, paid to LPs | `DecayingFeeHook` |
| A 0.5% treasury fee on every swap | `SwapFeeHook` |
| An on-chain TWAP other contracts can read | `TwapOracleHook` |
| Only the DAO may configure the pools, whoever creates them | a fixed `_initialPoolAdmin` |

## 1. Install

```sh
forge install camdengrieh/varada@<commit-or-tag>
```

`forge install` needs the repository to be public and the ref to contain `contracts/src/hooks`.
Otherwise copy the folder instead ([README.md, Option B](README.md#option-b-copy-the-folder)) and
point the `v4-hooks/` remappings below at your copy.

```toml
# foundry.toml
[profile.default]
solc_version = "0.8.26"
evm_version = "cancun"
remappings = [
  "v4-hooks/=lib/varada/contracts/src/hooks/",
  "v4-hooks-script/=lib/varada/contracts/script/",
  "v4-hooks-test/=lib/varada/contracts/test/hooks/",
  "v4-core/=lib/varada/contracts/lib/v4-core/src/",
  "@uniswap/v4-core/=lib/varada/contracts/lib/v4-core/",
  "solmate/=lib/varada/contracts/lib/v4-core/lib/solmate/",
  "forge-std/=lib/forge-std/src/",
]
```

`v4-hooks-test/`, `@uniswap/v4-core/` and `solmate/` are only needed for the test in step 3
(the shared `HookTest` base uses v4 core's `Deployers`).

## 2. Write the hook

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {BaseHook} from "v4-hooks/base/BaseHook.sol";
import {PoolAdminHook} from "v4-hooks/base/PoolAdminHook.sol";
import {DecayingFeeHook} from "v4-hooks/fee/DecayingFeeHook.sol";
import {SwapFeeHook} from "v4-hooks/fee/SwapFeeHook.sol";
import {TwapOracleHook} from "v4-hooks/oracle/TwapOracleHook.sol";

/// @notice A pool hook with a TWAP oracle, a launch LP fee that decays, and a treasury fee.
contract MyPoolHook is TwapOracleHook, DecayingFeeHook, SwapFeeHook {
    /// @notice Pool admin of every pool created with this hook.
    address public immutable admin;

    constructor(IPoolManager manager, address admin_)
        BaseHook(manager)
        TwapOracleHook(5 minutes, 24)
    {
        admin = admin_;
    }

    // Who administers a pool. A pool key is public, so `return sender` here would let anyone
    // who calls PoolManager.initialize first become the admin. A fixed admin removes that risk.
    function _initialPoolAdmin(address, PoolKey calldata) internal view override returns (address) {
        return admin;
    }

    // Rule 6: re-declare every internal function two or more bases define. Bodies only call super.

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        virtual
        override(TwapOracleHook, DecayingFeeHook, SwapFeeHook)
        returns (Hooks.Permissions memory)
    {
        return super._hookPermissions(p);
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        virtual
        override(BaseHook, PoolAdminHook, DecayingFeeHook)
        returns (bytes4)
    {
        return super._beforeInitialize(sender, key, sqrtPriceX96);
    }

    function _afterInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96, int24 tick)
        internal
        virtual
        override(BaseHook, TwapOracleHook)
        returns (bytes4)
    {
        return super._afterInitialize(sender, key, sqrtPriceX96, tick);
    }

    function _beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    )
        internal
        virtual
        override(BaseHook, TwapOracleHook, DecayingFeeHook)
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return super._beforeSwap(sender, key, params, hookData);
    }

    function _afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) internal virtual override(BaseHook, SwapFeeHook) returns (bytes4, int128) {
        return super._afterSwap(sender, key, params, delta, hookData);
    }
}
```

That is the whole hook. All behaviour lives in the features; the concrete contract only lists
them, calls the constructors, picks the admin rule, and re-declares the shared functions.

### Choosing the admin rule

`PoolAdminHook` leaves `_initialPoolAdmin` unimplemented, so the compiler stops you until you
choose who configures each pool (error 3656, "Contract should be marked as abstract"). The
choices, and the front-running risk behind them, are in
[BaseHook.md](BaseHook.md#front-running-the-initializer). In short:

- **Fixed admin** (this page): anyone may create a pool with the hook, only `admin` configures it.
- **Gated initializers**: add `PoolInitGateHook` to the list, let an owner allow your factory, and
  return `sender` (see `LaunchpadHook` in [Composition.md](Composition.md)).
- **Open** (`return sender` with no gate): an attacker who initializes your key first becomes its
  admin. Use it only if every pool is initialized and configured in one transaction from a
  contract, so a front-run can only make that transaction revert.

Only `PoolAdminHook` declares `_initialPoolAdmin`, so the override takes no base list.

### Why these `override(...)` lists

Solidity makes the concrete contract re-declare every function that two or more bases define,
and the list must name each base whose definition is still "open" from here:

| Function | Defined by | Open bases |
| --- | --- | --- |
| `_hookPermissions` | all three features (and `PoolAdminHook`, `BaseHook` underneath) | the three features; every path overrides the bases below |
| `_beforeInitialize` | `PoolAdminHook`, `DecayingFeeHook` | `DecayingFeeHook`; `PoolAdminHook` (reached through `SwapFeeHook`, which does not override it); `BaseHook` (reached through `TwapOracleHook`) |
| `_afterInitialize` | `TwapOracleHook` | `TwapOracleHook`, `BaseHook` |
| `_beforeSwap` | `TwapOracleHook`, `DecayingFeeHook` | both, plus `BaseHook` (through `SwapFeeHook`) |
| `_afterSwap` | `SwapFeeHook` | `SwapFeeHook`, `BaseHook` |

You do not have to work this out by hand: write the list you expect and compile. The compiler
names each function you have not re-declared (error 6480, "Derived contract must override
function"), each missing base (error 4327, "Function needs to specify overridden contract") and
each extra one (error 2353, "Invalid contract specified in override list").

### What runs, in order

The inheritance list is `TwapOracleHook, DecayingFeeHook, SwapFeeHook`, and each feature calls
`super` first, so:

- `beforeInitialize`: `PoolAdminHook` records `admin` as pool admin, then `DecayingFeeHook`
  requires a dynamic-fee key (`NotDynamicFee`).
- `afterInitialize`: `TwapOracleHook` seeds checkpoint 0.
- `beforeSwap`: `TwapOracleHook` accrues the pre-swap tick, then `DecayingFeeHook` returns the
  current fee with `OVERRIDE_FEE_FLAG`.
- `afterSwap`: `SwapFeeHook` takes 0.5% of the unspecified side and returns it as the hook delta.

Merged flags: `BEFORE_INITIALIZE | AFTER_INITIALIZE | BEFORE_SWAP | AFTER_SWAP |
AFTER_SWAP_RETURNS_DELTA`.

## 3. Test it

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolAdminHook} from "v4-hooks/base/PoolAdminHook.sol";
import {HookMiner} from "v4-hooks-script/HookMiner.sol";
import {HookTest} from "v4-hooks-test/utils/HookTest.sol";

import {MyPoolHook} from "../src/MyPoolHook.sol";

contract MyPoolHookTest is HookTest {
    MyPoolHook hook;
    address treasury = makeAddr("treasury");

    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG
        | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    function setUp() public {
        deployFreshManagerAndRouters(); // real PoolManager and test routers
        deployMintAndApprove2Currencies();
        // Places the hook at an address whose low bits encode FLAGS.
        hook = MyPoolHook(
            _deployHook("MyPoolHook.sol:MyPoolHook", abi.encode(manager, address(this)), FLAGS)
        );
    }

    function test_flags() public view {
        assertEq(_flags(hook.getHookPermissions()), FLAGS);
    }

    function test_minedDeploy() public {
        (address predicted, bytes32 salt) = HookMiner.find(
            address(this), FLAGS, type(MyPoolHook).creationCode, abi.encode(manager, address(this))
        );
        MyPoolHook h = new MyPoolHook{salt: salt}(manager, address(this));
        assertEq(address(h), predicted);
    }

    function test_initializerIsNotAdmin() public {
        address squatter = makeAddr("squatter");
        PoolKey memory k =
            PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        vm.prank(squatter);
        manager.initialize(k, SQRT_PRICE_1_1);
        assertEq(hook.poolAdmin(k.toId()), address(this)); // the fixed admin, not the squatter
        vm.prank(squatter);
        vm.expectRevert(
            abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, k.toId(), squatter)
        );
        hook.setSwapFee(k, 1000, squatter, true);
    }

    function test_endToEnd() public {
        (key,) = initPool(
            currency0, currency1, IHooks(address(hook)), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1
        );
        hook.setDecayingFee(key, 100_000, 3_000, 1 hours, 0); // 10% -> 0.30% over an hour
        hook.setSwapFee(key, 50, treasury, true); // 0.5%, as ERC-6909 claims
        modifyLiquidityRouter.modifyLiquidity(key, LIQUIDITY_PARAMS, ZERO_BYTES);

        assertEq(hook.currentFee(key.toId()), 100_000);
        swap(key, true, -1e15, ZERO_BYTES);
        assertGt(manager.balanceOf(treasury, currency1.toId()), 0); // fee on the output side

        vm.warp(block.timestamp + 1 hours);
        assertEq(hook.currentFee(key.toId()), 3_000);
        swap(key, false, -1e15, ZERO_BYTES);
        (bool ok,,) = hook.twapTick(key.toId(), 30 minutes);
        assertTrue(ok);
    }
}
```

```sh
forge test --match-contract MyPoolHookTest
```

The test contract deploys the hook with itself as `admin`, so it may call `setDecayingFee` and
`setSwapFee`. `test_initializerIsNotAdmin` shows that someone else who initializes a pool does not
get the admin role.

## 4. Mine the address

v4 reads a hook's permissions from the low 14 bits of its address, so the hook must be deployed
with CREATE2 at an address that encodes exactly the merged flags. `HookMiner.find(deployer,
flags, creationCode, constructorArgs)` searches salts and returns the first matching address:

- `deployer` is the address that executes CREATE2. In a `forge script` broadcast, `new
  X{salt: s}(...)` goes through the standard CREATE2 deployer, available in scripts as
  `CREATE2_FACTORY` (`0x4e59b44847b379578588920cA78FbF26c0B4956C`). From a factory contract it is
  the factory.
- The constructor arguments are part of the init code: mine with exactly the arguments you
  deploy with.
- Five flags take about 2^14 attempts on average, well inside the default bound of 400,000.

## 5. Deploy, initialize and configure

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {HookMiner} from "v4-hooks-script/HookMiner.sol";

import {MyPoolHook} from "../src/MyPoolHook.sol";

contract DeployMyPoolHook is Script {
    // Uniswap v4 PoolManager on Ethereum mainnet.
    IPoolManager constant POOL_MANAGER = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);

    function run() external {
        address token0 = vm.envAddress("TOKEN0"); // sorted: token0 < token1
        address token1 = vm.envAddress("TOKEN1");
        address treasury = vm.envAddress("TREASURY");
        address admin = vm.envAddress("ADMIN"); // the account you broadcast with

        // 1. Mine a salt whose CREATE2 address encodes exactly the hook's merged flags.
        uint160 flags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        bytes memory args = abi.encode(POOL_MANAGER, admin);
        (address predicted, bytes32 salt) =
            HookMiner.find(CREATE2_FACTORY, flags, type(MyPoolHook).creationCode, args);

        vm.startBroadcast();

        // 2. Deploy through the standard CREATE2 deployer (forge routes `new{salt}` through it).
        MyPoolHook hook = new MyPoolHook{salt: salt}(POOL_MANAGER, admin);
        require(address(hook) == predicted, "address mismatch");

        // 3. Initialize a dynamic-fee pool; `admin` is its pool admin.
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        POOL_MANAGER.initialize(key, TickMath.getSqrtPriceAtTick(0));

        // 4. Configure: 10% LP fee decaying to 0.30% over 1 hour, 0.5% treasury fee as claims.
        hook.setDecayingFee(key, 100_000, 3_000, 1 hours, 0);
        hook.setSwapFee(key, 50, treasury, true);

        vm.stopBroadcast();
    }
}
```

```sh
TOKEN0=0x... TOKEN1=0x... TREASURY=0x... ADMIN=0x... \
forge script script/DeployMyPoolHook.s.sol --rpc-url "$ETH_RPC_URL" --account deployer --broadcast
```

Notes:

- `fee` must be `LPFeeLibrary.DYNAMIC_FEE_FLAG`, or initialization reverts `NotDynamicFee`
  (wrapped by the pool manager in `WrappedError`).
- Set the starting price for your pair (`TickMath.getSqrtPriceAtTick(tick)` or an explicit
  `sqrtPriceX96`); tick 0 means a 1:1 raw-unit price.
- `ADMIN` must be the broadcasting account, or the two config calls revert `NotPoolAdmin`.
- The script sends initialize and the two config calls as separate transactions. That is safe
  here because the admin is fixed and the pool has no liquidity until step 6: someone who
  initializes the key first gets no admin role, and a price they set on an empty pool costs
  nothing to move back. If liquidity goes in at creation, do all of it from one contract call
  (a factory, as `LaunchpadHook`'s launch flow does). With an open admin rule
  (`return sender`), separate transactions are **not** safe: whoever initializes first owns
  the pool's config.
- `ADMIN` is the admin of every pool this hook serves and can change both fees later. To fix the
  terms of one pool for good: `hook.transferPoolAdmin(key, address(0))`.
- The treasury redeems its claims with `PoolManager.unlock` then `burn` and `take`, or uses
  them as v4 balances directly.

## 6. Add liquidity and trade

The pool is a normal v4 pool: add liquidity through the v4 `PositionManager` and trade through
the Universal Router or any v4 router, with the `PoolKey` above. Every swap:

- pays the current decaying LP fee to in-range LPs (visible in the pool manager's `Swap` event),
- pays 0.5% of the output (exact input) or 0.5% extra input (exact output) to the treasury,
- updates the TWAP: `hook.twapTick(key.toId(), 30 minutes)` returns `(ok, avgTick, span)`.

## 7. Add a feature of your own

Need behaviour no feature provides? Write a small feature on `BaseHook` (see the complete
`NoDonateHook` in [BaseHook.md](BaseHook.md#writing-a-feature-a-complete-example)) and **add it
to the inheritance list** of your concrete hook:

```solidity
contract MyPoolHook is TwapOracleHook, DecayingFeeHook, SwapFeeHook, NoDonateHook {
    // ... the same constructor and re-declarations as above, with NoDonateHook added to
    // _hookPermissions' list:
    //     override(TwapOracleHook, DecayingFeeHook, SwapFeeHook, NoDonateHook)
    // and one more re-declaration:

    function _beforeDonate(
        address sender,
        PoolKey calldata key,
        uint256 amount0,
        uint256 amount1,
        bytes calldata hookData
    ) internal virtual override(BaseHook, NoDonateHook) returns (bytes4) {
        return super._beforeDonate(sender, key, amount0, amount1, hookData);
    }
}
```

The flags gain `Hooks.BEFORE_DONATE_FLAG`, so mine a new address. Prefer adding the feature to the flat
list over inheriting your finished concrete hook (`contract V2 is MyPoolHook, NoDonateHook`): the
new feature opens a second path to `BaseHook`, and every callback then has to be re-declared
again with `override(BaseHook, MyPoolHook)`.

## 8. Before mainnet

Walk the [deployment checklist](Composition.md#deployment-checklist): flags, mined salt for the
exact init code, dynamic-fee keys, who the pool admin is (and whether a front-runner could
become it), fee recipients, and the reverts each
feature can add to a trade. Other ideas for glue, all `internal virtual` overrides with no
feature edits: a fee exemption (`_swapFeeBps`), factory-only admin (`_isPoolAdmin`), a key rule
(`_validatePoolKey` with `PoolInitGateHook`), fee routing (`_onSwapFeeTaken`), in-swap
conversion of the fee (`FeeConversionHook`). See [Composition.md](Composition.md#adding-protocol-glue).
