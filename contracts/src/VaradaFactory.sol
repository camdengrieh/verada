// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {SqrtPriceMath} from "v4-core/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {IPositionManager} from "v4-periphery/interfaces/IPositionManager.sol";
import {Actions} from "v4-periphery/libraries/Actions.sol";
import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";

import {VaradaToken} from "./VaradaToken.sol";
import {ICauseCatalog} from "./interfaces/ICauseCatalog.sol";
import {IEpochGovernor} from "./interfaces/IEpochGovernor.sol";
import {IFeeVault} from "./interfaces/IFeeVault.sol";
import {ILiveDonationVault} from "./interfaces/ILiveDonationVault.sol";
import {ILpLocker} from "./interfaces/ILpLocker.sol";
import {IQuoteRegistry} from "./interfaces/IQuoteRegistry.sol";
import {ITokenProfileRegistry} from "./interfaces/ITokenProfileRegistry.sol";
import {IVaradaFactory} from "./interfaces/IVaradaFactory.sol";
import {IVaradaHook} from "./interfaces/IVaradaHook.sol";
import {IVaradaLiveHook} from "./interfaces/IVaradaLiveHook.sol";
import {IVaradaToken} from "./interfaces/IVaradaToken.sol";

/// @dev Permit2 address as exposed by the v4 position manager.
interface IPositionManagerPermit2 {
    function permit2() external view returns (address);
}

/// @dev The slice of Permit2 the factory needs to let the position manager pull the token.
interface IPermit2Allowance {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @title VaradaFactory
/// @notice Launches a token: deploys it with CREATE2, initializes its Uniswap v4 pool against
///         a registry-approved quote asset (WETH or an Ondo token) with the Varada hook, mints the whole supply as single-sided liquidity, sends
///         the position NFT to the locker and registers the token with the fee vault, the
///         epoch governor and the profile registry (its `<label>.varada.eth` name). The factory
///         holds no tokens or positions after a launch. Once the deployer has configured live
///         mode, `deployLiveToken` runs the same launch on the live-donation hook and registers
///         the token with the live vault and rotation governor instead. Both modes fix the
///         token's cause focus at launch, under the same catalogue check.
/// @dev `startTick` in `DeployParams` is expressed in whole-token terms: the price of one whole
///      token (18 decimals) in whole units of the quote asset is 1.0001^startTick, whatever the
///      quote's decimals. The pool works in raw units, so the factory shifts the tick by
///      (quoteDecimals - 18) * log_1.0001(10) (about 23_027 ticks per decimal) and snaps the
///      result to the pool's tick spacing (at most 100 ticks, about 1%, of rounding). A quote with
///      18 decimals needs no shift. When the token sorts as currency1 the pool tick is the
///      negation. Liquidity covers every price above the start price, so the pool opens holding
///      only the new token. Start prices so high that the supply would need more liquidity than
///      one tick can hold are rejected.
contract VaradaFactory is IVaradaFactory, ReentrancyGuard {
    /// @notice Lowest allowed base fee in basis points.
    uint24 public constant MIN_FEE_BPS = 100;
    /// @notice Highest allowed base fee in basis points.
    uint24 public constant MAX_FEE_BPS = 500;
    /// @notice Highest allowed initial anti-sniper surcharge in basis points (80%).
    uint24 public constant MAX_SNIPER_FEE_START_BPS = 8000;
    /// @notice Longest allowed anti-sniper decay window.
    uint32 public constant MAX_SNIPER_DECAY_SECONDS = 1 days;
    /// @notice Tick spacing of every Varada pool.
    int24 public constant TICK_SPACING = 200;
    /// @notice Ticks per factor of ten in price: round(ln(10) / ln(1.0001)).
    int256 public constant TICKS_PER_DECADE = 23_027;
    /// @notice Decimals of every Varada token.
    uint8 public constant TOKEN_DECIMALS = 18;

    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    address public immutable permit2;
    IQuoteRegistry internal immutable _quoteRegistry;
    IVaradaHook public immutable hook;
    ILpLocker public immutable locker;
    IFeeVault public immutable feeVault;
    IEpochGovernor public immutable governor;
    ITokenProfileRegistry internal immutable _profileRegistry;
    /// @notice Account that deployed the factory; the only one allowed to configure live mode.
    address public immutable deployer;

    uint256 public tokenCount;
    mapping(address token => bool) public isVaradaToken;
    mapping(address token => address) public quoteAssetOf;
    /// @inheritdoc IVaradaFactory
    address public liveHook;
    /// @inheritdoc IVaradaFactory
    address public liveVault;

    error ZeroAddress();
    error InvalidStartTick(int24 startTick);
    error UnexpectedValue();
    /// @dev The supply at this start price needs more liquidity than a single tick may hold.
    error LiquidityTooLarge(uint128 liquidity, uint128 maxPerTick);

    constructor(
        IPoolManager poolManager_,
        IPositionManager positionManager_,
        IQuoteRegistry quoteRegistry_,
        IVaradaHook hook_,
        ILpLocker locker_,
        IFeeVault feeVault_,
        IEpochGovernor governor_,
        ITokenProfileRegistry profileRegistry_
    ) {
        if (
            address(poolManager_) == address(0) || address(positionManager_) == address(0)
                || address(quoteRegistry_) == address(0) || address(hook_) == address(0)
                || address(locker_) == address(0) || address(feeVault_) == address(0)
                || address(governor_) == address(0) || address(profileRegistry_) == address(0)
        ) revert ZeroAddress();
        poolManager = poolManager_;
        positionManager = positionManager_;
        permit2 = IPositionManagerPermit2(address(positionManager_)).permit2();
        _quoteRegistry = quoteRegistry_;
        hook = hook_;
        locker = locker_;
        feeVault = feeVault_;
        governor = governor_;
        _profileRegistry = profileRegistry_;
        deployer = msg.sender;
    }

    /// @inheritdoc IVaradaFactory
    /// @dev Deployer only, once. The live hook must differ from the weekly hook and report
    ///      `liveVault_` as its vault.
    function configureLiveMode(address liveHook_, address liveVault_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (liveHook != address(0)) revert LiveModeAlreadyConfigured();
        if (liveHook_ == address(0) || liveVault_ == address(0)) revert ZeroAddress();
        if (liveHook_ == address(hook) || IVaradaLiveHook(liveHook_).vault() != liveVault_) {
            revert InvalidLiveMode(liveHook_, liveVault_);
        }
        liveHook = liveHook_;
        liveVault = liveVault_;
        emit LiveModeConfigured(liveHook_, liveVault_);
    }

    /// @inheritdoc IVaradaFactory
    function quoteRegistry() external view returns (address) {
        return address(_quoteRegistry);
    }

    /// @inheritdoc IVaradaFactory
    function profileRegistry() external view returns (address) {
        return address(_profileRegistry);
    }

    /// @inheritdoc IVaradaFactory
    /// @dev Reverts if the pool was already initialized by someone else (pools can be created
    ///      for a predicted token address before launch); pick another salt in that case.
    function deployToken(DeployParams calldata params)
        external
        payable
        nonReentrant
        returns (address token, uint256 lpTokenId)
    {
        LiveParams memory none;
        return _deploy(params, hook, none);
    }

    /// @inheritdoc IVaradaFactory
    /// @dev Same launch as `deployToken` on the live hook. The token is registered with the live
    ///      vault (and through it the rotation governor) before the pool is initialized, and is
    ///      not registered with the weekly fee vault or epoch governor.
    function deployLiveToken(DeployParams calldata params, LiveParams calldata live)
        external
        payable
        nonReentrant
        returns (address token, uint256 lpTokenId)
    {
        address h = liveHook;
        if (h == address(0)) revert LiveModeNotConfigured();
        return _deploy(params, IVaradaHook(h), live);
    }

    /// @dev Shared launch body. `hook_` is the weekly hook or the live hook (both expose
    ///      `configureToken(address,(uint24,uint24,uint32,uint40))`); `live` is read only for the
    ///      live hook. The mode is derived from `hook_` rather than passed as a constant so the
    ///      compiler keeps one copy of this body.
    function _deploy(DeployParams calldata params, IVaradaHook hook_, LiveParams memory live)
        private
        returns (address token, uint256 lpTokenId)
    {
        bool isLive = hook_ != hook;
        if (msg.value != 0) revert UnexpectedValue();
        _validate(params);
        if (!_quoteRegistry.isAllowed(params.quoteAsset)) {
            revert QuoteAssetNotAllowed(params.quoteAsset);
        }
        uint8 quoteDecimals = _quoteRegistry.getQuoteAsset(params.quoteAsset).decimals;
        if (isVaradaToken[_predict(msg.sender, params)]) {
            revert TokenAlreadyDeployed(_predict(msg.sender, params));
        }

        token = address(
            new VaradaToken{salt: _salt(msg.sender, params.salt)}(
                params.name, params.symbol, params.metadataURI, msg.sender, address(this)
            )
        );
        isVaradaToken[token] = true;
        quoteAssetOf[token] = params.quoteAsset;
        unchecked {
            ++tokenCount;
        }

        // Claims the ENS label before any pool state exists, so a bad or taken label reverts
        // the launch cheaply.
        _profileRegistry.register(token, params.label, msg.sender, params.logoRef);
        _profileRegistry.setFocus(token, params.categoryMask, params.regionMask);
        // A weekly token's focus is checked against the catalogue when the epoch governor
        // registers it; a live token never reaches that governor, so the same check runs here.
        if (isLive) _checkFocusPool(token, params.categoryMask, params.regionMask);

        hook_.configureToken(
            token,
            IVaradaHook.FeeConfig({
                baseFeeBps: params.baseFeeBps,
                sniperFeeStartBps: params.sniperFeeStartBps,
                sniperDecaySeconds: params.sniperDecaySeconds,
                launchTimestamp: uint40(block.timestamp)
            })
        );
        if (isLive) {
            ILiveDonationVault(liveVault)
                .registerToken(
                    token, live.donationThreshold, live.initialCause, live.rotationPeriod
                );
        }

        PoolKey memory key = _poolKey(token, params.quoteAsset, hook_);
        bool tokenIsCurrency0 = Currency.unwrap(key.currency0) == token;
        int24 poolTick = _poolTick(params.startTick, quoteDecimals, tokenIsCurrency0);
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(poolTick));

        lpTokenId = _mintLiquidity(key, token, tokenIsCurrency0, poolTick);

        locker.lock(token, lpTokenId);
        if (!isLive) {
            feeVault.registerToken(token);
            governor.registerToken(token);
        }

        // Rounding in the liquidity math can leave a few wei of tokens behind; burn them so the
        // factory never holds a balance.
        uint256 dust = VaradaToken(token).balanceOf(address(this));
        if (dust != 0) IVaradaToken(token).burn(dust);

        emit TokenCreated(
            token,
            msg.sender,
            PoolId.unwrap(PoolIdLibrary.toId(key)),
            address(hook_),
            lpTokenId,
            params.baseFeeBps,
            params.metadataURI
        );
    }

    /// @inheritdoc IVaradaFactory
    function predictTokenAddress(address creator, DeployParams calldata params)
        external
        view
        returns (address)
    {
        return _predict(creator, params);
    }

    // ------------------------------------------------------------------ internals

    /// @dev The epoch governor's launch rule (`IEpochGovernor.registerToken`): the latest
    ///      catalogue must give the focus at least `MIN_OPTIONS` entries.
    function _checkFocusPool(address token, uint64 categoryMask, uint16 regionMask) internal view {
        ICauseCatalog catalog = ICauseCatalog(governor.catalog());
        uint256 size = catalog.poolSize(catalog.latestVersion(), categoryMask, regionMask);
        if (size < governor.MIN_OPTIONS()) revert IEpochGovernor.PoolTooSmall(token, size);
    }

    function _validate(DeployParams calldata params) internal pure {
        if (params.baseFeeBps < MIN_FEE_BPS || params.baseFeeBps > MAX_FEE_BPS) {
            revert InvalidFee(params.baseFeeBps);
        }
        if (params.sniperFeeStartBps > MAX_SNIPER_FEE_START_BPS) {
            revert InvalidSniperFee(params.sniperFeeStartBps);
        }
        if (
            params.sniperFeeStartBps != 0
                && (params.sniperDecaySeconds == 0
                    || params.sniperDecaySeconds > MAX_SNIPER_DECAY_SECONDS)
        ) revert InvalidSniperFee(params.sniperFeeStartBps);

        int24 limit = TickMath.maxUsableTick(TICK_SPACING);
        if (
            params.startTick % TICK_SPACING != 0 || params.startTick <= -limit
                || params.startTick >= limit
        ) revert InvalidStartTick(params.startTick);
    }

    function _predict(address creator, DeployParams calldata params)
        internal
        view
        returns (address)
    {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(VaradaToken).creationCode,
                abi.encode(params.name, params.symbol, params.metadataURI, creator, address(this))
            )
        );
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff), address(this), _salt(creator, params.salt), initCodeHash
                        )
                    )
                )
            )
        );
    }

    /// @dev Same bound the pool manager enforces per initialized tick for this tick spacing.
    function _maxLiquidityPerTick() internal pure returns (uint128) {
        int24 minTick = (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING;
        int24 maxTick = (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;
        uint32 numTicks = uint32(int32((maxTick - minTick) / TICK_SPACING)) + 1;
        return type(uint128).max / numTicks;
    }

    function _salt(address creator, bytes32 userSalt) internal pure returns (bytes32) {
        return keccak256(abi.encode(creator, userSalt));
    }

    /// @notice Raw pool tick (in the pool's currency order) for a whole-token `startTick`.
    /// @dev Shifts by the decimals difference, snaps to the tick spacing and bounds-checks.
    function poolTickFor(int24 startTick, uint8 quoteDecimals, bool tokenIsCurrency0)
        external
        pure
        returns (int24)
    {
        return _poolTick(startTick, quoteDecimals, tokenIsCurrency0);
    }

    function _poolTick(int24 startTick, uint8 quoteDecimals, bool tokenIsCurrency0)
        internal
        pure
        returns (int24)
    {
        int256 raw = int256(startTick)
            + (int256(uint256(quoteDecimals)) - int256(uint256(TOKEN_DECIMALS))) * TICKS_PER_DECADE;
        // Round to the nearest multiple of the spacing (halves round up).
        int256 spacing = int256(TICK_SPACING);
        int256 rem = raw % spacing;
        if (rem < 0) rem += spacing;
        raw -= rem;
        if (rem * 2 >= spacing) raw += spacing;

        int256 limit = int256(TickMath.maxUsableTick(TICK_SPACING));
        if (raw <= -limit || raw >= limit) revert InvalidStartTick(startTick);
        // casting to int24 is safe: |raw| < limit < 2^23
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 tick = int24(raw);
        return tokenIsCurrency0 ? tick : -tick;
    }

    function _poolKey(address token, address quote, IVaradaHook hooks_)
        internal
        pure
        returns (PoolKey memory)
    {
        (address c0, address c1) = token < quote ? (token, quote) : (quote, token);
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 0x800000, // LPFeeLibrary.DYNAMIC_FEE_FLAG
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hooks_))
        });
    }

    /// @dev Mints a position holding the full token supply and no WETH. For a currency0 token
    ///      the position spans [poolTick, max]; for a currency1 token it spans [min, poolTick].
    function _mintLiquidity(
        PoolKey memory key,
        address token,
        bool tokenIsCurrency0,
        int24 poolTick
    ) internal returns (uint256 lpTokenId) {
        uint256 supply = VaradaToken(token).balanceOf(address(this));

        int24 tickLower;
        int24 tickUpper;
        if (tokenIsCurrency0) {
            tickLower = poolTick;
            tickUpper = TickMath.maxUsableTick(TICK_SPACING);
        } else {
            tickLower = TickMath.minUsableTick(TICK_SPACING);
            tickUpper = poolTick;
        }
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(tickUpper);

        uint128 liquidity = tokenIsCurrency0
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtLower, sqrtUpper, supply)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtUpper, supply);

        uint128 maxPerTick = _maxLiquidityPerTick();
        if (liquidity > maxPerTick) revert LiquidityTooLarge(liquidity, maxPerTick);

        // Liquidity is rounded down, but the amount owed for it is rounded up; make sure it
        // cannot exceed the supply.
        while (
            (tokenIsCurrency0
                        ? SqrtPriceMath.getAmount0Delta(sqrtLower, sqrtUpper, liquidity, true)
                        : SqrtPriceMath.getAmount1Delta(sqrtLower, sqrtUpper, liquidity, true))
                > supply
        ) {
            --liquidity;
        }

        VaradaToken(token).approve(permit2, supply);
        IPermit2Allowance(permit2)
            .approve(token, address(positionManager), uint160(supply), uint48(block.timestamp));

        lpTokenId = positionManager.nextTokenId();

        bytes memory actions =
            abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory mintParams = new bytes[](2);
        mintParams[0] = abi.encode(
            key,
            tickLower,
            tickUpper,
            uint256(liquidity),
            tokenIsCurrency0 ? uint128(supply) : uint128(0),
            tokenIsCurrency0 ? uint128(0) : uint128(supply),
            address(locker),
            bytes("")
        );
        mintParams[1] = abi.encode(key.currency0, key.currency1);
        positionManager.modifyLiquidities(abi.encode(actions, mintParams), block.timestamp);
    }
}
