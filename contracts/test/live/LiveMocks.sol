// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {TransientStateLibrary} from "v4-core/libraries/TransientStateLibrary.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

import {IFeeConsolidator} from "../../src/interfaces/IFeeConsolidator.sol";
import {MockEndaomentRegistry} from "../mocks/EndaomentMocks.sol";
import {MockProfileRegistryLite} from "../mocks/GovernanceMocks.sol";

/// @dev 6-decimal USDC stand-in that can be paused and can block accounts, like the real token.
contract LiveUSDC is ERC20 {
    bool public paused;
    mapping(address account => bool) public blacklisted;

    error Paused();
    error Blacklisted(address account);

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setBlacklisted(address account, bool b) external {
        blacklisted[account] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (paused) revert Paused();
        if (blacklisted[from]) revert Blacklisted(from);
        if (blacklisted[to]) revert Blacklisted(to);
        super._update(from, to, value);
    }
}

/// @dev Endaoment org with switchable behaviour. Etched over a deployed `MockOrg`, so its first
///      four slots mirror `MockOrg` (registry, orgId, baseToken, balance) and the extra settings
///      live after them.
contract AdversarialOrg {
    enum Mode {
        Normal,
        Revert,
        BurnGas,
        ReturnBomb,
        ReenterFlush,
        ReenterRetry,
        ReenterSwap,
        LeaveDelta,
        LeaveSync,
        PullLess
    }

    // Slots 0..3: same layout as MockOrg.
    MockEndaomentRegistry public registry;
    bytes32 public orgId;
    address public baseToken;
    uint256 public balance;
    // Slots 4..: adversarial settings.
    Mode public mode;
    address public target; // vault, hook or pool manager depending on the mode
    address public token;
    bytes32 public causeId;
    PoolKey internal _key;

    function configure(Mode mode_, address target_, address token_, bytes32 causeId_) external {
        mode = mode_;
        target = target_;
        token = token_;
        causeId = causeId_;
    }

    function setKey(PoolKey calldata key) external {
        _key = key;
    }

    function donate(uint256 amount) external {
        Mode m = mode;
        if (m == Mode.Revert) revert("org: refused");
        if (m == Mode.BurnGas) {
            uint256 x;
            while (true) {
                x++;
            }
        }
        if (m == Mode.ReturnBomb) {
            assembly {
                revert(0, 1000000)
            }
        }
        if (m == Mode.ReenterFlush) {
            (bool ok, bytes memory ret) =
                target.call(abi.encodeWithSignature("flush(address,bytes32)", token, causeId));
            if (!ok) _bubble(ret);
        }
        if (m == Mode.ReenterRetry) {
            (bool ok, bytes memory ret) = target.call(
                abi.encodeWithSignature("retryHeld(address,bytes32,uint256)", token, causeId, 1)
            );
            if (!ok) _bubble(ret);
        }
        if (m == Mode.ReenterSwap) {
            IPoolManager(target)
                .swap(
                    _key,
                    SwapParams({
                    zeroForOne: true, amountSpecified: -1e9, sqrtPriceLimitX96: 4_295_128_740
                }),
                    ""
                );
        }
        if (m == Mode.LeaveDelta) {
            // Opens a delta for this org (allowed while the pool manager is unlocked).
            IPoolManager(target).mint(address(this), Currency.wrap(baseToken).toId(), 1);
        }
        if (m == Mode.LeaveSync) {
            IPoolManager(target).sync(Currency.wrap(baseToken));
        }
        uint256 pull = m == Mode.PullLess ? amount / 2 : amount;
        uint256 f = pull * registry.getDonationFee(address(this)) / 10_000;
        IERC20(baseToken).transferFrom(msg.sender, registry.treasury(), f);
        IERC20(baseToken).transferFrom(msg.sender, address(this), pull - f);
        balance += pull - f;
    }

    function _bubble(bytes memory ret) private pure {
        assembly {
            revert(add(ret, 32), mload(ret))
        }
    }
}

/// @dev Router that syncs a currency before swapping (as a router mid-settlement would), then
///      settles everything. Used to exercise the hook's synced-currency precheck.
contract SyncingRouter is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable manager;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    struct Call {
        address payer;
        PoolKey key;
        SwapParams params;
        Currency syncFirst;
    }

    function swap(PoolKey calldata key, SwapParams calldata params, Currency syncFirst)
        external
        returns (BalanceDelta delta)
    {
        delta = abi.decode(
            manager.unlock(abi.encode(Call(msg.sender, key, params, syncFirst))), (BalanceDelta)
        );
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        Call memory c = abi.decode(data, (Call));
        manager.sync(c.syncFirst);
        BalanceDelta delta = manager.swap(c.key, c.params, "");
        _settle(c.payer, c.key.currency0, delta.amount0());
        _settle(c.payer, c.key.currency1, delta.amount1());
        return abi.encode(delta);
    }

    function _settle(address payer, Currency currency, int128 amount) private {
        if (amount < 0) {
            // `syncFirst` may be this currency (already synced) or another one: sync again.
            manager.sync(currency);
            IERC20(Currency.unwrap(currency))
                .transferFrom(payer, address(manager), uint256(uint128(-amount)));
            manager.settle();
        } else if (amount > 0) {
            manager.take(currency, payer, uint256(uint128(amount)));
        }
    }
}

/// @dev Minimal hook (beforeSwap only) used to build a hooked route pool. Optionally makes one
///      call from `beforeSwap` and bubbles its revert (re-entrancy probes).
contract NoopRouteHook {
    address public callTarget;
    bytes public callData;

    function setCall(address target, bytes calldata data) external {
        callTarget = target;
        callData = data;
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (callTarget != address(0)) {
            (bool ok, bytes memory ret) = callTarget.call(callData);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        return IHooks.beforeInitialize.selector;
    }

    function beforeAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return IHooks.beforeAddLiquidity.selector;
    }
}

/// @dev A consolidator source that holds ERC-6909 claims and converts them through
///      `convertClaims` inside its own unlock (the shape the live hook uses for retries).
contract ClaimsSource is IUnlockCallback {
    IPoolManager public immutable manager;
    IFeeConsolidator public consolidator;
    /// @dev Gas used by the last `convertClaims` call (measurement aid).
    uint256 public lastConvertGas;

    enum Action {
        Deposit,
        Convert
    }

    constructor(IPoolManager manager_, IFeeConsolidator consolidator_) {
        manager = manager_;
        consolidator = consolidator_;
        manager_.setOperator(address(consolidator_), true);
    }

    function setOperator(bool approved) external {
        manager.setOperator(address(consolidator), approved);
    }

    /// @dev Turns `amount` of `currency` held by this contract into claims.
    function deposit(address currency, uint256 amount) external {
        manager.unlock(abi.encode(Action.Deposit, currency, amount, address(0), false));
    }

    function convert(address currency, uint256 amount, address to, bool hooklessOnly)
        external
        returns (uint256 out)
    {
        out = abi.decode(
            manager.unlock(abi.encode(Action.Convert, currency, amount, to, hooklessOnly)),
            (uint256)
        );
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (Action a, address currency, uint256 amount, address to, bool hooklessOnly) =
            abi.decode(data, (Action, address, uint256, address, bool));
        if (a == Action.Deposit) {
            manager.sync(Currency.wrap(currency));
            IERC20(currency).transfer(address(manager), amount);
            manager.settle();
            manager.mint(address(this), Currency.wrap(currency).toId(), amount);
            return "";
        }
        uint256 g = gasleft();
        uint256 out = consolidator.convertClaims(currency, amount, to, hooklessOnly);
        lastConvertGas = g - gasleft();
        return abi.encode(out);
    }
}

/// @dev Profile registry stand-in whose tokens default to `(categories, regions)` until a focus
///      is set, so live tests can register tokens without setting one each time.
contract LiveProfiles is MockProfileRegistryLite {
    uint64 internal immutable _defaultCategories;
    uint16 internal immutable _defaultRegions;

    constructor(uint64 categories, uint16 regions) {
        _defaultCategories = categories;
        _defaultRegions = regions;
    }

    function focusOf(address token) public view override returns (uint64, uint16) {
        (uint64 c, uint16 r) = super.focusOf(token);
        if (c == 0 && r == 0) return (_defaultCategories, _defaultRegions);
        return (c, r);
    }
}
