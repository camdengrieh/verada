// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {FeeConsolidator} from "../src/FeeConsolidator.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {IQuoteRegistry} from "../src/interfaces/IQuoteRegistry.sol";

/// @title AddQuoteAssets
/// @notice Owner-run: registers a curated set of liquid mainnet assets as quote assets, each with a
///         hookless Uniswap v4 route to USDC (at most three hops), then seeds the fee consolidator's
///         price reference for every route pool that has none. No contract change is involved: the
///         registry takes any ERC-20 with a route that ends in USDC, and `Kind` is only a label.
/// @dev    DRY RUN BY DEFAULT. Without `APPLY=1` nothing is broadcast, even with `--broadcast`: the
///         script only checks the live registry and pools and prints the plan.
///
///         Dry run (any RPC, no key needed):
///           QUOTE_REGISTRY=0x.. FEE_CONSOLIDATOR=0x.. forge script script/AddQuoteAssets.s.sol \
///             --rpc-url $ETH_RPC_URL
///         Apply (signer must own both contracts; use a keystore or hardware wallet, never a key on
///         the command line):
///           APPLY=1 QUOTE_REGISTRY=0x.. FEE_CONSOLIDATOR=0x.. forge script script/AddQuoteAssets.s.sol \
///             --rpc-url $ETH_RPC_URL --broadcast --account <owner keystore>
///         Optional: `ASSETS=WBTC,cbBTC,AAPLon` limits the run to those symbols.
///
///         The route table below was chosen from live pools (price impact of a $10k and a $100k
///         swap to USDC along each candidate route, pools of any fee tier, no hooks). Assets whose
///         best route impacted a $100k swap by more than 3% are left out; see docs/DEPLOYMENT.md.
///         Pools can move, so every run re-checks that each hop exists and has liquidity, and skips
///         (and reports) any asset that fails.
contract AddQuoteAssets is Script {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    address internal constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WBTC = 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599;
    address internal constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address internal constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;
    address internal constant LINK = 0x514910771AF9Ca656af840dff83E8264EcF986CA;
    address internal constant UNI = 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984;
    address internal constant AAVE = 0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9;

    /// @dev A pool must hold at least this much in-range liquidity (v4 `L`) to count as live; the
    ///      real depth test is the price-impact table above, this only catches a drained pool.
    uint128 internal constant MIN_LIQUIDITY = 1;

    struct Planned {
        string symbol;
        address asset;
        IQuoteRegistry.Kind kind;
        PoolKey[] route;
    }

    // ------------------------------------------------------------------ plan

    /// @notice The curated set: crypto assets first, then the Ondo tokens with a USDC pool.
    function plan() public pure returns (Planned[] memory out) {
        Planned[] memory crypto = _crypto();
        Planned[] memory ondo = _ondo();
        out = new Planned[](crypto.length + ondo.length);
        for (uint256 i; i < crypto.length; ++i) {
            out[i] = crypto[i];
        }
        for (uint256 i; i < ondo.length; ++i) {
            out[crypto.length + i] = ondo[i];
        }
    }

    /// @dev `Kind.Native` is the registry's label for non-Ondo assets (it is not WETH-only).
    function _crypto() internal pure returns (Planned[] memory p) {
        p = new Planned[](6);
        // Direct pools against USDC.
        p[0] = _one("WBTC", WBTC, IQuoteRegistry.Kind.Native, _key(WBTC, USDC, 3000, 60));
        p[1] = _one("cbBTC", CBBTC, IQuoteRegistry.Kind.Native, _key(CBBTC, USDC, 3000, 60));
        p[2] = _one("UNI", UNI, IQuoteRegistry.Kind.Native, _key(UNI, USDC, 3000, 60));
        p[3] = _one("AAVE", AAVE, IQuoteRegistry.Kind.Native, _key(AAVE, USDC, 3000, 60));
        // Through native ETH: asset/ETH, then the ETH/USDC 0.05% pool the registry already uses for
        // WETH (its price reference is shared, so it is not re-seeded).
        p[4] = _two(
            "wstETH",
            WSTETH,
            IQuoteRegistry.Kind.Native,
            _key(address(0), WSTETH, 100, 1),
            _key(address(0), USDC, 500, 10)
        );
        p[5] = _two(
            "LINK",
            LINK,
            IQuoteRegistry.Kind.Native,
            _key(address(0), LINK, 3000, 60),
            _key(address(0), USDC, 500, 10)
        );
    }

    /// @dev Every Ondo token (of the 451 in the SDK list) with a live hookless pool to USDC or ETH
    ///      at the usual fee tiers, as of the survey. All of them are THIN (a $1k swap moves the
    ///      price 2% to 9%; none passes the 3% at $100k bar the crypto assets use), so the web app
    ///      shows their depth and gates launches on it; the registry allowlists them regardless
    ///      because that is the owner's call. CRCLon and SLVon have a pool but no quotable depth
    ///      and are left out.
    function _ondo() internal pure returns (Planned[] memory p) {
        p = new Planned[](6);
        IQuoteRegistry.Kind ondo = IQuoteRegistry.Kind.Ondo;
        p[0] = _one(
            "USDon",
            0xAcE8E719899F6E91831B18AE746C9A965c2119F1,
            ondo,
            _key(0xAcE8E719899F6E91831B18AE746C9A965c2119F1, USDC, 10_000, 100)
        );
        p[1] = _one(
            "AMZNon",
            0xbb8774FB97436d23d74C1b882E8E9A69322cFD31,
            ondo,
            _key(0xbb8774FB97436d23d74C1b882E8E9A69322cFD31, USDC, 10_000, 100)
        );
        p[2] = _one(
            "GOOGLon",
            0xbA47214eDd2bb43099611b208f75E4b42FDcfEDc,
            ondo,
            _key(0xbA47214eDd2bb43099611b208f75E4b42FDcfEDc, USDC, 3000, 60)
        );
        p[3] = _one(
            "TSLAon",
            0xf6b1117ec07684D3958caD8BEb1b302bfD21103f,
            ondo,
            _key(0xf6b1117ec07684D3958caD8BEb1b302bfD21103f, USDC, 10_000, 100)
        );
        p[4] = _one(
            "USOon",
            0x1F5fc5c3c8B0F15c7E21AF623936FF2b210b6415,
            ondo,
            _key(0x1F5fc5c3c8B0F15c7E21AF623936FF2b210b6415, USDC, 3000, 60)
        );
        // SPYon has no USDC pool; it routes through native ETH.
        p[5] = _two(
            "SPYon",
            0xFeDC5f4a6c38211c1338aa411018DFAf26612c08,
            ondo,
            _key(address(0), 0xFeDC5f4a6c38211c1338aa411018DFAf26612c08, 10_000, 200),
            _key(address(0), USDC, 500, 10)
        );
    }

    // ------------------------------------------------------------------ run

    function run() external {
        QuoteRegistry registry = QuoteRegistry(vm.envAddress("QUOTE_REGISTRY"));
        FeeConsolidator cons = FeeConsolidator(payable(vm.envAddress("FEE_CONSOLIDATOR")));
        bool doApply = vm.envOr("APPLY", false);
        string[] memory only = vm.envOr("ASSETS", ",", new string[](0));

        require(registry.settlementAsset() == USDC, "registry settles in USDC");
        console2.log(doApply ? "mode: APPLY" : "mode: DRY RUN (set APPLY=1 to broadcast)");
        console2.log("registry owner", registry.owner());
        console2.log("consolidator owner", cons.owner());

        Planned[] memory all = plan();
        bool[] memory ok = new bool[](all.length);
        uint256 adds;
        for (uint256 i; i < all.length; ++i) {
            if (!_wanted(all[i].symbol, only)) continue;
            ok[i] = _check(registry, all[i]);
            if (ok[i]) ++adds;
        }
        console2.log("assets to add", adds);

        if (!doApply) return;
        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        require(sender == registry.owner(), "signer must own the quote registry");
        require(sender == cons.owner(), "signer must own the fee consolidator");
        for (uint256 i; i < all.length; ++i) {
            if (!ok[i]) continue;
            applyOne(registry, cons, all[i]);
        }
        vm.stopBroadcast();
    }

    /// @notice Registers one planned asset and seeds the references of its route pools that have none.
    ///         Callers must already be the owner of both contracts (broadcast or prank).
    function applyOne(QuoteRegistry registry, FeeConsolidator cons, Planned memory a) public {
        registry.addQuoteAssetWithRoute(a.asset, a.kind, a.route);
        PoolKey[] memory unseeded = new PoolKey[](a.route.length);
        uint256 n;
        for (uint256 i; i < a.route.length; ++i) {
            (,, bool set,,) = cons.references(a.route[i].toId());
            if (!set) unseeded[n++] = a.route[i];
        }
        if (n != 0) {
            PoolKey[] memory keys = new PoolKey[](n);
            for (uint256 i; i < n; ++i) {
                keys[i] = unseeded[i];
            }
            cons.seedReferences(keys);
        }
    }

    /// @dev Read-only preflight of one asset; logs the reason when it is skipped.
    function _check(QuoteRegistry registry, Planned memory a) internal view returns (bool) {
        if (registry.getQuoteAsset(a.asset).decimals != 0) {
            console2.log("skip (already registered)", a.symbol);
            return false;
        }
        if (a.asset.code.length == 0) {
            console2.log("skip (no contract at address)", a.symbol);
            return false;
        }
        for (uint256 i; i < a.route.length; ++i) {
            PoolId id = a.route[i].toId();
            (uint160 sqrtPriceX96,,,) = IPoolManager(POOL_MANAGER).getSlot0(id);
            if (sqrtPriceX96 == 0) {
                console2.log("skip (hop not initialized)", a.symbol, i);
                return false;
            }
            if (IPoolManager(POOL_MANAGER).getLiquidity(id) < MIN_LIQUIDITY) {
                console2.log("skip (hop has no liquidity)", a.symbol, i);
                return false;
            }
        }
        console2.log("add", a.symbol, a.route.length);
        return true;
    }

    function _wanted(string memory symbol, string[] memory only) internal pure returns (bool) {
        if (only.length == 0) return true;
        for (uint256 i; i < only.length; ++i) {
            if (keccak256(bytes(only[i])) == keccak256(bytes(symbol))) return true;
        }
        return false;
    }

    // ------------------------------------------------------------------ builders

    function _key(address a, address b, uint24 fee, int24 spacing)
        internal
        pure
        returns (PoolKey memory)
    {
        (a, b) = a < b ? (a, b) : (b, a);
        return PoolKey(Currency.wrap(a), Currency.wrap(b), fee, spacing, IHooks(address(0)));
    }

    function _one(string memory symbol, address asset, IQuoteRegistry.Kind kind, PoolKey memory k)
        internal
        pure
        returns (Planned memory p)
    {
        p.symbol = symbol;
        p.asset = asset;
        p.kind = kind;
        p.route = new PoolKey[](1);
        p.route[0] = k;
    }

    function _two(
        string memory symbol,
        address asset,
        IQuoteRegistry.Kind kind,
        PoolKey memory k0,
        PoolKey memory k1
    ) internal pure returns (Planned memory p) {
        p.symbol = symbol;
        p.asset = asset;
        p.kind = kind;
        p.route = new PoolKey[](2);
        p.route[0] = k0;
        p.route[1] = k1;
    }
}
