// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {DonationAsset} from "./interfaces/IDonationAsset.sol";
import {IQuoteRegistry} from "./interfaces/IQuoteRegistry.sol";
import {V3RouteLib} from "./libraries/V3RouteLib.sol";

/// @title QuoteRegistry
/// @notice Owner-managed allowlist of assets a token's pool may be paired against (any ERC-20 with a route to USDC: WETH, other liquid crypto and
///         verified Ondo tokens; `Kind` is only a label), plus the Uniswap v4 route that converts each asset into the
///         settlement asset (USDC).
/// @dev A hop is a v4 pool key, or a Uniswap v3 pool encoded as a key with tick spacing zero
///      (`V3RouteLib`; validated structurally here, its pool is looked up by the consolidator
///      when it executes). A route is an ordered list of such hops. Starting from the quote asset, every hop
///      swaps the current currency for the other currency of the pool, and the last hop must
///      end in the settlement asset. One special case is allowed: when the current currency is
///      WETH and the next pool is quoted in native ETH (currency address zero) instead, the
///      consolidator unwraps first. Deactivating an asset blocks new launches only; the route is
///      kept so existing pools keep consolidating.
contract QuoteRegistry is IQuoteRegistry, Ownable2Step {
    /// @notice Maximum hops in a route.
    uint256 public constant MAX_ROUTE_LENGTH = 3;

    /// @notice The settlement asset (USDC) every route must end in.
    address public immutable settlementAsset;

    /// @notice Wrapped native asset, used for the unwrap special case.
    address public immutable weth;

    mapping(address asset => QuoteAsset data) private _assets;
    mapping(address asset => bool exists) private _exists;
    mapping(address asset => PoolKey[] hops) private _routes;
    /// @dev Routes into WETH (the `Eth` donation asset). Empty for WETH itself.
    mapping(address asset => PoolKey[] hops) private _routesEth;
    address[] private _list;

    event RouteSet(address indexed asset, uint256 hops);
    event RouteToSet(address indexed asset, DonationAsset indexed donationAsset, uint256 hops);

    error EmptyRoute();
    error RouteTooLong(uint256 length);
    error RouteDisconnected(uint256 hop);
    error RouteDoesNotSettle(address endsIn);
    error InvalidV3Hop(uint256 hop);
    error AssetIsSettlement();
    error InvalidDecimals(address asset);
    error HopFeeTooHigh(uint256 hop, uint24 fee);

    /// @notice Highest static pool fee (pips) a route hop may charge; matches the consolidator's
    ///         `MAX_HOP_FEE_BPS` (1000 bps), above which every conversion would revert.
    uint24 public constant MAX_HOP_FEE_PIPS = 100_000;
    error RouteIsImplicit(address asset);

    constructor(address owner_, address settlementAsset_, address weth_) Ownable(owner_) {
        if (settlementAsset_ == address(0) || weth_ == address(0)) revert ZeroAddress();
        settlementAsset = settlementAsset_;
        weth = weth_;
    }

    // ------------------------------------------------------------------ allowlist

    /// @inheritdoc IQuoteRegistry
    function addQuoteAsset(address asset, Kind kind) external onlyOwner {
        _add(asset, kind);
    }

    /// @notice Adds a quote asset together with its route to the settlement asset.
    function addQuoteAssetWithRoute(address asset, Kind kind, PoolKey[] calldata route)
        external
        onlyOwner
    {
        _add(asset, kind);
        _setRoute(asset, route);
    }

    /// @inheritdoc IQuoteRegistry
    function deactivateQuoteAsset(address asset) external onlyOwner {
        if (!_exists[asset]) revert QuoteAssetNotFound(asset);
        _assets[asset].active = false;
        emit QuoteAssetDeactivated(asset);
    }

    /// @inheritdoc IQuoteRegistry
    function reactivateQuoteAsset(address asset) external onlyOwner {
        if (!_exists[asset]) revert QuoteAssetNotFound(asset);
        _assets[asset].active = true;
        emit QuoteAssetReactivated(asset);
    }

    /// @inheritdoc IQuoteRegistry
    function getQuoteAsset(address asset) external view returns (QuoteAsset memory) {
        return _assets[asset];
    }

    /// @inheritdoc IQuoteRegistry
    function isAllowed(address asset) external view returns (bool) {
        return _assets[asset].active;
    }

    /// @inheritdoc IQuoteRegistry
    function quoteAssetCount() external view returns (uint256) {
        return _list.length;
    }

    /// @inheritdoc IQuoteRegistry
    function quoteAssetAt(uint256 index) external view returns (address) {
        return _list[index];
    }

    // ------------------------------------------------------------------ routes

    /// @notice Replaces the route that converts `asset` into the settlement asset.
    function setRoute(address asset, PoolKey[] calldata route) external onlyOwner {
        if (!_exists[asset]) revert QuoteAssetNotFound(asset);
        _setRoute(asset, route);
    }

    /// @notice Replaces the route that converts `asset` into the donation asset `da`.
    /// @dev `Usdc` is `setRoute`. For `Eth` the route must end in WETH, or in native ETH (the
    ///      consolidator wraps it). WETH has no `Eth` route: it already is the donation asset.
    function setRouteTo(address asset, DonationAsset da, PoolKey[] calldata route)
        external
        onlyOwner
    {
        if (!_exists[asset]) revert QuoteAssetNotFound(asset);
        if (da == DonationAsset.Usdc) {
            _setRoute(asset, route);
        } else {
            if (asset == weth) revert RouteIsImplicit(asset);
            _setRouteEth(asset, route);
        }
    }

    /// @notice The route of `asset` into donation asset `da` (empty for `Usdc` when none is
    ///         configured, and for WETH with `Eth`).
    function routeToOf(address asset, DonationAsset da) external view returns (PoolKey[] memory) {
        return da == DonationAsset.Usdc ? _routes[asset] : _routesEth[asset];
    }

    /// @inheritdoc IQuoteRegistry
    function hasRouteTo(address asset, DonationAsset da) external view returns (bool) {
        if (da == DonationAsset.Usdc) return _routes[asset].length != 0;
        return asset == weth ? _exists[asset] : _routesEth[asset].length != 0;
    }

    /// @inheritdoc IQuoteRegistry
    function donationToken(DonationAsset da) external view returns (address) {
        return da == DonationAsset.Usdc ? settlementAsset : weth;
    }

    /// @notice The route of `asset` (empty when none is configured).
    function routeOf(address asset) external view returns (PoolKey[] memory) {
        return _routes[asset];
    }

    /// @notice Number of hops in the route of `asset`.
    function routeLength(address asset) external view returns (uint256) {
        return _routes[asset].length;
    }

    /// @notice Whether a route to the settlement asset is configured for `asset`.
    function hasRoute(address asset) external view returns (bool) {
        return _routes[asset].length != 0;
    }

    // ------------------------------------------------------------------ internals

    function _add(address asset, Kind kind) private {
        if (asset == address(0)) revert ZeroAddress();
        if (asset == settlementAsset) revert AssetIsSettlement();
        if (_exists[asset]) revert QuoteAssetAlreadyExists(asset);
        uint8 decimals_ = IERC20Metadata(asset).decimals();
        if (decimals_ == 0 || decimals_ > 36) revert InvalidDecimals(asset);

        _exists[asset] = true;
        _assets[asset] = QuoteAsset({decimals: decimals_, kind: kind, active: true});
        _list.push(asset);
        emit QuoteAssetAdded(asset, decimals_, kind);
    }

    function _setRoute(address asset, PoolKey[] calldata route) private {
        delete _routes[asset];
        address end = _walk(asset, route, _routes[asset]);
        if (end != settlementAsset) revert RouteDoesNotSettle(end);
        emit RouteSet(asset, route.length);
    }

    function _setRouteEth(address asset, PoolKey[] calldata route) private {
        delete _routesEth[asset];
        address end = _walk(asset, route, _routesEth[asset]);
        // WETH, or native ETH (wrapped by the consolidator on the way out).
        if (end != weth && end != address(0)) revert RouteDoesNotSettle(end);
        emit RouteToSet(asset, DonationAsset.Eth, route.length);
    }

    /// @dev Validates connectivity of `route` from `asset` and copies it to `out`; returns the
    ///      currency the route ends in.
    function _walk(address asset, PoolKey[] calldata route, PoolKey[] storage out)
        private
        returns (address current)
    {
        uint256 length = route.length;
        if (length == 0) revert EmptyRoute();
        if (length > MAX_ROUTE_LENGTH) revert RouteTooLong(length);

        current = asset;
        for (uint256 i; i < length; ++i) {
            PoolKey calldata key = route[i];
            if (!LPFeeLibrary.isDynamicFee(key.fee) && key.fee > MAX_HOP_FEE_PIPS) {
                revert HopFeeTooHigh(i, key.fee);
            }
            address c0 = Currency.unwrap(key.currency0);
            address c1 = Currency.unwrap(key.currency1);
            if (key.tickSpacing == V3RouteLib.TICK_SPACING && !V3RouteLib.isValidV3(key)) {
                revert InvalidV3Hop(i);
            }
            if (current == c0) {
                current = c1;
            } else if (current == c1) {
                current = c0;
            } else if (current == weth && (c0 == address(0) || c1 == address(0))) {
                // Unwrap special case: the pool is quoted in native ETH.
                current = c0 == address(0) ? c1 : c0;
            } else {
                revert RouteDisconnected(i);
            }
            out.push(key);
        }
    }
}
