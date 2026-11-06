// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Script, console2} from "forge-std/Script.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {CauseCatalog} from "../src/CauseCatalog.sol";
import {DonationDistributor} from "../src/DonationDistributor.sol";
import {EpochGovernor} from "../src/EpochGovernor.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {VaradaFactory} from "../src/VaradaFactory.sol";
import {VaradaLiveHook} from "../src/VaradaLiveHook.sol";
import {VaradaLpLocker} from "../src/VaradaLpLocker.sol";
import {RotationPeriod} from "../src/interfaces/IRotationGovernor.sol";
import {DonationAsset} from "../src/interfaces/IDonationAsset.sol";
import {IVaradaFactory} from "../src/interfaces/IVaradaFactory.sol";
import {CatalogPublish} from "../test/utils/CatalogFixture.sol";

interface IWETH9 {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
}

/// @title RehearseFork
/// @notice Anvil-fork rehearsal of the post-deploy lifecycle with real mainnet addresses. NEVER for
///         a live network: it uses `--private-key` test keys and refuses to run unless
///         `REHEARSAL_FORK=yes` is set. Phases (run in order, each with its own account):
///           catalog()   as OWNER   publish a catalogue version so launches can start
///           trade()     as TRADER  launch weekly + live tokens against WETH / an Ondo stock / WBTC and
///                                  trade them (the trader also holds the quote assets, funded by
///                                  the shell script)
///           collect()   as anyone  LP fee collection and consolidation, live retries (after time
///                                  has moved on, for `settle`)
///           settle()    as anyone  finalize (default cause), settle into the distributor, push
///                                  the donation to the Endaoment org, withdraw the platform share
contract RehearseFork is Script {
    IPoolManager internal constant PM = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant WBTC = 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599;
    address internal constant AMZN_ON = 0xbb8774FB97436d23d74C1b882E8E9A69322cFD31;
    bytes32 internal constant WIKI_ORG = bytes32("200049703");
    address internal constant WIKI_ADDR = 0xe5F123750FcEa2D82b1441048F1A431FDD3D2Dc1;
    bytes32 internal constant WIKI_CAUSE = keccak256(abi.encode(WIKI_ORG));
    bytes32 internal constant FRESH_ORG = bytes32("999000111");

    struct Addrs {
        address factory;
        address locker;
        address vault;
        address governor;
        address distributor;
        address catalog;
        address liveHook;
        address liveVault;
        address hook;
    }

    function _guard() internal view {
        require(
            keccak256(bytes(vm.envOr("REHEARSAL_FORK", string("")))) == keccak256("yes"),
            "rehearsal only"
        );
    }

    function _addrs() internal view returns (Addrs memory a) {
        string memory w = vm.readFile("deployments/1.json");
        string memory l = vm.readFile("deployments/1-live.json");
        a.factory = vm.parseJsonAddress(w, ".factory");
        a.locker = vm.parseJsonAddress(w, ".lpLocker");
        a.vault = vm.parseJsonAddress(w, ".feeVault");
        a.governor = vm.parseJsonAddress(w, ".epochGovernor");
        a.distributor = vm.parseJsonAddress(w, ".donationDistributor");
        a.catalog = vm.parseJsonAddress(w, ".causeCatalog");
        a.hook = vm.parseJsonAddress(w, ".hook");
        a.liveHook = vm.parseJsonAddress(l, ".liveHook");
        a.liveVault = vm.parseJsonAddress(l, ".liveVault");
    }

    // ------------------------------------------------------------------ phases

    function catalog() external {
        _guard();
        Addrs memory a = _addrs();
        bytes32[] memory orgs = new bytes32[](2);
        orgs[0] = WIKI_ORG;
        orgs[1] = FRESH_ORG;
        vm.startBroadcast();
        CatalogPublish.publish(CauseCatalog(a.catalog), orgs);
        vm.stopBroadcast();
    }

    function trade() external {
        _guard();
        Addrs memory a = _addrs();
        vm.startBroadcast();
        (, address me,) = vm.readCallers();
        PoolSwapTest router = new PoolSwapTest(PM);
        IWETH9(WETH).deposit{value: 8 ether}();
        IERC20(WETH).approve(address(router), type(uint256).max);
        IERC20(AMZN_ON).approve(address(router), type(uint256).max);
        IERC20(WBTC).approve(address(router), type(uint256).max);

        string memory k = "rehearsal";
        // Weekly tokens: WETH, an Ondo stock, WBTC.
        address wWeth = _weekly(a, 1, WETH, -69_000, "rh-w-weth");
        address wAmzn = _weekly(a, 2, AMZN_ON, -230_200, "rh-w-amzn");
        address wBtc = _weekly(a, 3, WBTC, -207_200, "rh-w-wbtc");
        _buyWeekly(router, a, wWeth, WETH, 2 ether);
        _buyWeekly(router, a, wAmzn, AMZN_ON, 0.05 ether);
        _buyWeekly(router, a, wBtc, WBTC, 5_000_000); // 0.05 WBTC

        // Live tokens: threshold 0, so the converted fee is pushed to the Endaoment org in the swap.
        (address lWeth, PoolKey memory kWeth) = _live(a, 4, WETH, -69_000, "rh-l-weth");
        (address lBtc, PoolKey memory kBtc) = _live(a, 5, WBTC, -207_200, "rh-l-wbtc");
        for (uint256 i; i < 3; ++i) {
            _swap(router, kWeth, lWeth, 1 ether);
        }
        for (uint256 i; i < 3; ++i) {
            _swap(router, kBtc, lBtc, 2_000_000); // 0.02 WBTC
        }
        vm.stopBroadcast();

        vm.serializeAddress(k, "trader", me);
        vm.serializeAddress(k, "wWeth", wWeth);
        vm.serializeAddress(k, "wAmzn", wAmzn);
        vm.serializeAddress(k, "wBtc", wBtc);
        vm.serializeAddress(k, "lWeth", lWeth);
        vm.serializeAddress(k, "lBtc", lBtc);
        vm.serializeUint(k, "epoch", EpochGovernor(a.governor).currentEpoch());
        string memory json = vm.serializeAddress(k, "router", address(router));
        vm.writeJson(json, "deployments/rehearsal.json");
    }

    function collect() external {
        _guard();
        Addrs memory a = _addrs();
        string memory r = vm.readFile("deployments/rehearsal.json");
        vm.startBroadcast();
        VaradaLpLocker(a.locker).collectFees(vm.parseJsonAddress(r, ".wWeth"));
        VaradaLpLocker(a.locker).collectFees(vm.parseJsonAddress(r, ".wAmzn"));
        VaradaLpLocker(a.locker).collectFees(vm.parseJsonAddress(r, ".wBtc"));
        vm.stopBroadcast();
        console2.log("vault USDC", IERC20(USDC).balanceOf(a.vault));
    }

    function settle() external {
        _guard();
        Addrs memory a = _addrs();
        string memory r = vm.readFile("deployments/rehearsal.json");
        uint256 epoch = vm.parseJsonUint(r, ".epoch");
        bytes32[] memory none = new bytes32[](0);
        address[3] memory ts = [
            vm.parseJsonAddress(r, ".wWeth"),
            vm.parseJsonAddress(r, ".wAmzn"),
            vm.parseJsonAddress(r, ".wBtc")
        ];
        uint256 orgBefore = IERC20(USDC).balanceOf(WIKI_ADDR);
        vm.startBroadcast();
        for (uint256 i; i < ts.length; ++i) {
            EpochGovernor(a.governor).finalizeEpoch(ts[i], epoch, none);
            FeeVault(a.vault).settle(ts[i], epoch);
            DonationDistributor(a.distributor).distribute(ts[i], epoch);
        }
        FeeVault(a.vault).withdrawPlatform();
        vm.stopBroadcast();
        console2.log("org USDC received", IERC20(USDC).balanceOf(WIKI_ADDR) - orgBefore);
    }

    // ------------------------------------------------------------------ helpers

    function _weekly(Addrs memory a, uint256 n, address quote, int24 tick, string memory label)
        internal
        returns (address token)
    {
        IVaradaFactory.DeployParams memory p = IVaradaFactory.DeployParams(
            "Rehearsal",
            "REH",
            "ipfs://rehearsal",
            bytes32(n + 1000),
            300,
            0,
            0,
            tick,
            quote,
            label,
            bytes32(0),
            CatalogPublish.CATEGORIES,
            CatalogPublish.REGIONS,
            DonationAsset.Usdc
        );
        (token,) = VaradaFactory(a.factory).deployToken(p);
        console2.log(label, token);
    }

    function _live(Addrs memory a, uint256 n, address quote, int24 tick, string memory label)
        internal
        returns (address token, PoolKey memory key)
    {
        IVaradaFactory.DeployParams memory p = IVaradaFactory.DeployParams(
            "Rehearsal Live",
            "RHL",
            "ipfs://rehearsal-live",
            bytes32(n + 2000),
            300,
            0,
            0,
            tick,
            quote,
            label,
            bytes32(0),
            CatalogPublish.CATEGORIES,
            CatalogPublish.REGIONS,
            DonationAsset.Usdc
        );
        (token,) = VaradaFactory(a.factory)
            .deployLiveToken(p, IVaradaFactory.LiveParams(WIKI_CAUSE, RotationPeriod.OneDay, 0));
        (address c0, address c1) = token < quote ? (token, quote) : (quote, token);
        key = PoolKey(
            Currency.wrap(c0),
            Currency.wrap(c1),
            LPFeeLibrary.DYNAMIC_FEE_FLAG,
            200,
            IHooks(a.liveHook)
        );
        console2.log(label, token);
    }

    function _buyWeekly(
        PoolSwapTest router,
        Addrs memory a,
        address token,
        address quote,
        uint256 spend
    ) internal {
        (address c0, address c1) = token < quote ? (token, quote) : (quote, token);
        PoolKey memory key =
            PoolKey(Currency.wrap(c0), Currency.wrap(c1), 0x800000, 200, IHooks(a.hook));
        _swapKey(router, key, quote, spend);
    }

    function _swap(PoolSwapTest router, PoolKey memory key, address token, uint256 spend) internal {
        address quote = Currency.unwrap(key.currency0) == token
            ? Currency.unwrap(key.currency1)
            : Currency.unwrap(key.currency0);
        _swapKey(router, key, quote, spend);
    }

    function _swapKey(PoolSwapTest router, PoolKey memory key, address quote, uint256 spend)
        internal
    {
        bool zeroForOne = Currency.unwrap(key.currency0) == quote;
        router.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(spend),
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }
}
