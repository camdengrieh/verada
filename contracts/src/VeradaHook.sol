// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {PoolInitGateHook} from "./hooks/access/PoolInitGateHook.sol";
import {BaseHook} from "./hooks/base/BaseHook.sol";
import {PoolAdminHook} from "./hooks/base/PoolAdminHook.sol";
import {DecayingFeeHook} from "./hooks/fee/DecayingFeeHook.sol";
import {SwapFeeHook} from "./hooks/fee/SwapFeeHook.sol";
import {LinearDecay} from "./hooks/libraries/LinearDecay.sol";
import {TwapOracleHook} from "./hooks/oracle/TwapOracleHook.sol";
import {IFeeConsolidator} from "./interfaces/IFeeConsolidator.sol";
import {IVeradaHook} from "./interfaces/IVeradaHook.sol";

/// @dev Pool registration entry point of the fee consolidator.
interface IConsolidatorPools {
    function registerPool(address token, PoolKey calldata key) external;
}

/// @title VeradaHook
/// @notice Uniswap v4 hook for weekly-mode Verada pools (a launched token paired with an allowed
///         quote asset). It is a thin composition of the generic hooks in `src/hooks` plus the
///         Verada glue that maps the factory's per-token `FeeConfig` onto them:
///          - `PoolInitGateHook`: only the factory may initialize pools; the Verada key rule
///            (exactly one configured side, dynamic fee, one pool per token) reverts
///            `InvalidPool`.
///          - `TwapOracleHook`: tick accumulator, 24 checkpoints at least 5 minutes apart, read
///            by the fee consolidator through `twapTick(token, window)` (or the generic
///            `twapTick(poolId, window)`).
///          - `DecayingFeeHook`: the LP fee, set at initialization to a flat schedule at the
///            token's base fee (`startFee == endFee`). It accrues to the locked position.
///          - `SwapFeeHook`: the anti-sniper surcharge. Its rate (`_swapFeeBps`) decays linearly
///            from `sniperFeeStartBps` to zero over `sniperDecaySeconds` (`LinearDecay`, rounded
///            up); it is taken in `afterSwap` through the return delta on the unspecified
///            currency, sent as tokens to the fee consolidator and reported to it
///            (`consolidate`). Swaps made by the consolidator itself are exempt.
/// @dev Glue only, no hook logic of its own: per-pool config is written once at initialization
///      from the token's `FeeConfig` and frozen (no pool admin, so the generic setters
///      `setDecayingFee`, `setSwapFee` and `transferPoolAdmin` always revert `NotPoolAdmin`).
///      The external API of the previous bespoke hook is kept unchanged (`IVeradaHook`,
///      `configured`, `poolInitialized`, `sniperFeeBps`, `twapTick(address,uint32)`, the
///      constants, events and errors, and the address flags `beforeInitialize | beforeSwap |
///      afterSwap | afterSwapReturnDelta`). `TwapOracleHook` asks for `afterInitialize` to seed
///      its first checkpoint; this hook clears that flag to keep the deployed flag set and seeds
///      the oracle in `beforeInitialize` instead (the seed does not depend on the tick).
///      Mine a salt with the HookMiner library before deploying.
contract VeradaHook is IVeradaHook, PoolInitGateHook, TwapOracleHook, DecayingFeeHook, SwapFeeHook {
    /// @notice Minimum spacing between two stored oracle checkpoints.
    uint32 public constant OBS_INTERVAL = 5 minutes;
    /// @notice Number of oracle checkpoints kept per pool (covers 2 hours at the minimum spacing).
    uint8 public constant OBS_CAPACITY = 24;

    /// @notice Lowest allowed base fee in basis points.
    uint24 public constant MIN_FEE_BPS = 100;
    /// @notice Highest allowed base fee in basis points.
    uint24 public constant MAX_FEE_BPS = 500;
    /// @notice Highest allowed initial anti-sniper surcharge in basis points (80%).
    uint24 public constant MAX_SNIPER_FEE_START_BPS = 8000;
    /// @notice Longest allowed anti-sniper decay window.
    uint32 public constant MAX_SNIPER_DECAY_SECONDS = 1 days;
    /// @dev Pips (v4 fee unit) per basis point.
    uint24 internal constant PIPS_PER_BPS = 100;

    address public immutable factory;
    address public immutable feeConsolidator;

    mapping(address token => FeeConfig) internal _feeConfigs;
    mapping(address token => bool) public configured;
    /// @notice Pool of each token (zero until the factory initializes it).
    mapping(address token => PoolId) public poolIdOf;

    error InvalidFee(uint24 feeBps);
    error InvalidSniperFee(uint24 feeBps, uint32 decaySeconds);
    error InvalidPool();
    error ZeroAddress();

    /// @notice A surcharge was taken from a swap and forwarded to the consolidator.
    event SniperFeeTaken(address indexed token, address indexed currency, uint256 amount);

    constructor(IPoolManager _poolManager, address _factory, address _feeConsolidator)
        BaseHook(_nonZero(_poolManager, _factory, _feeConsolidator))
        TwapOracleHook(OBS_INTERVAL, OBS_CAPACITY)
    {
        factory = _factory;
        feeConsolidator = _feeConsolidator;
        _setPoolInitializer(_factory, true);
    }

    /// @dev Runs before the base constructors so a zero argument reverts `ZeroAddress` before the
    ///      hook address is validated.
    function _nonZero(IPoolManager pm, address f, address c) private pure returns (IPoolManager) {
        if (address(pm) == address(0) || f == address(0) || c == address(0)) revert ZeroAddress();
        return pm;
    }

    // ------------------------------------------------------------------ configuration

    /// @inheritdoc IVeradaHook
    function configureToken(address token, FeeConfig calldata config) external {
        if (msg.sender != factory) revert NotFactory();
        if (configured[token]) revert AlreadyConfigured(token);
        if (config.baseFeeBps < MIN_FEE_BPS || config.baseFeeBps > MAX_FEE_BPS) {
            revert InvalidFee(config.baseFeeBps);
        }
        if (config.sniperFeeStartBps > MAX_SNIPER_FEE_START_BPS) {
            revert InvalidSniperFee(config.sniperFeeStartBps, config.sniperDecaySeconds);
        }
        if (config.sniperFeeStartBps != 0) {
            if (
                config.sniperDecaySeconds == 0
                    || config.sniperDecaySeconds > MAX_SNIPER_DECAY_SECONDS
            ) {
                revert InvalidSniperFee(config.sniperFeeStartBps, config.sniperDecaySeconds);
            }
        }

        FeeConfig memory stored = config;
        if (stored.launchTimestamp == 0) stored.launchTimestamp = uint40(block.timestamp);
        _feeConfigs[token] = stored;
        configured[token] = true;
    }

    /// @inheritdoc IVeradaHook
    function feeConfig(address token) external view returns (FeeConfig memory) {
        return _feeConfigs[token];
    }

    /// @inheritdoc IVeradaHook
    function currentFeeBps(address token) public view returns (uint24) {
        if (!configured[token]) revert TokenNotConfigured(token);
        FeeConfig storage c = _feeConfigs[token];
        return c.baseFeeBps + _surchargeBps(c);
    }

    /// @notice Current anti-sniper surcharge of `token` in basis points.
    function sniperFeeBps(address token) external view returns (uint24) {
        if (!configured[token]) revert TokenNotConfigured(token);
        return _surchargeBps(_feeConfigs[token]);
    }

    /// @notice Whether the factory has initialized `token`'s pool.
    function poolInitialized(address token) external view returns (bool) {
        return PoolId.unwrap(poolIdOf[token]) != bytes32(0);
    }

    /// @notice Time-weighted average tick of `token`'s pool over at least `window` seconds.
    /// @dev Token-keyed view of the generic `twapTick(poolId, window)` (see `ITwapOracle`):
    ///      `ok == false` when the pool is unknown or younger than `window`; the average rounds
    ///      toward negative infinity and cannot be moved by swaps in the current block.
    function twapTick(address token, uint32 window)
        external
        view
        returns (bool ok, int24 avgTick, uint32 span)
    {
        return this.twapTick(poolIdOf[token], window);
    }

    /// @dev Surcharge schedule: `sniperFeeStartBps` down to zero over `sniperDecaySeconds` from
    ///      `launchTimestamp`, rounded up (the cause pool benefits from any rounding).
    function _surchargeBps(FeeConfig storage c) internal view returns (uint24) {
        uint256 start = c.sniperFeeStartBps;
        if (start == 0) return 0;
        return uint24(
            LinearDecay.value(start, 0, c.sniperDecaySeconds, c.launchTimestamp, block.timestamp)
        );
    }

    /// @dev The launched token is whichever side of the pool the factory configured. The quote
    ///      asset was already validated by the factory against the quote registry.
    function _tokenOf(PoolKey calldata key) internal view returns (address token) {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (configured[c0] && !configured[c1]) return c0;
        if (configured[c1] && !configured[c0]) return c1;
        revert InvalidPool();
    }

    // ------------------------------------------------------------------ generic hook glue

    /// @dev Verada key rule, run by `PoolInitGateHook` after the factory-only initializer check.
    function _validatePoolKey(PoolKey calldata key, uint160) internal view override {
        address token = _tokenOf(key);
        if (
            address(key.hooks) != address(this) || !LPFeeLibrary.isDynamicFee(key.fee)
                || PoolId.unwrap(poolIdOf[token]) != bytes32(0)
        ) revert InvalidPool();
    }

    /// @dev Pool config is derived from `FeeConfig` and frozen: no pool has an admin.
    function _initialPoolAdmin(address, PoolKey calldata) internal pure override returns (address) {
        return address(0);
    }

    /// @dev The surcharge rate of one swap; the consolidator's own swaps are exempt (they would
    ///      feed themselves).
    function _swapFeeBps(address sender, PoolKey calldata key, SwapParams calldata)
        internal
        view
        override
        returns (uint16)
    {
        if (sender == feeConsolidator) return 0;
        return uint16(_surchargeBps(_feeConfigs[_tokenOf(key)]));
    }

    /// @dev The consolidator accepts tokens only (`consolidate` checks its ERC-20 balance), so
    ///      the surcharge is always taken as tokens, also on the input side of exact-output
    ///      swaps. That take needs the pool manager to hold the input currency at that point
    ///      (the trader settles after the swap), which the shared pool manager does for the
    ///      allowed quote assets.
    function _swapFeeAsClaims(PoolKey calldata, SwapParams calldata, bool)
        internal
        pure
        override
        returns (bool)
    {
        return false;
    }

    /// @dev The surcharge was taken as tokens to the consolidator. It cannot unlock the pool
    ///      manager from inside this swap, so it records the amount and settles it later.
    function _onSwapFeeTaken(
        address,
        PoolKey calldata key,
        Currency currency,
        uint256 amount,
        address,
        bool
    ) internal override {
        address token = _tokenOf(key);
        IFeeConsolidator(feeConsolidator).consolidate(token, Currency.unwrap(currency), amount);
        emit SniperFeeTaken(token, Currency.unwrap(currency), amount);
    }

    /// @dev Writes the frozen per-pool config of the generic features, seeds the oracle and
    ///      registers the pool with the consolidator. Runs after every feature's checks.
    function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        override(BaseHook, PoolAdminHook, PoolInitGateHook, DecayingFeeHook)
        returns (bytes4 selector)
    {
        selector = super._beforeInitialize(sender, key, sqrtPriceX96);
        address token = _tokenOf(key);
        PoolId id = key.toId();
        poolIdOf[token] = id;

        // TwapOracleHook seed (its afterInitialize flag is cleared, see the contract notes).
        _seedOracle(id);

        // A flat schedule at the base fee: the LP fee.
        uint24 lpFee = _feeConfigs[token].baseFeeBps * PIPS_PER_BPS;
        _setDecayingFee(id, lpFee, lpFee, 0, 0);
        // The rate comes from `_swapFeeBps`; only the recipient and settlement are stored.
        _setSwapFee(id, 0, feeConsolidator, false);

        IConsolidatorPools(feeConsolidator).registerPool(token, key);
    }

    // ------------------------------------------------------------------ composition boilerplate

    /// @dev The merged flags of the features minus `afterInitialize` (the oracle is seeded in
    ///      `beforeInitialize`), which keeps the deployed flag set of this hook.
    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        override(PoolInitGateHook, TwapOracleHook, DecayingFeeHook, SwapFeeHook)
        returns (Hooks.Permissions memory)
    {
        p = super._hookPermissions(p);
        p.afterInitialize = false;
        return p;
    }

    function _afterInitialize(
        address sender,
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        int24 tick
    ) internal override(BaseHook, TwapOracleHook) returns (bytes4) {
        return super._afterInitialize(sender, key, sqrtPriceX96, tick);
    }

    function _beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    )
        internal
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
    ) internal override(BaseHook, SwapFeeHook) returns (bytes4, int128) {
        return super._afterSwap(sender, key, params, delta, hookData);
    }
}
