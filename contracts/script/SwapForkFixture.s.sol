// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {CauseCatalog} from "../src/CauseCatalog.sol";
import {CauseRegistry} from "../src/CauseRegistry.sol";
import {FeeConsolidator} from "../src/FeeConsolidator.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {VaradaFactory} from "../src/VaradaFactory.sol";
import {IQuoteRegistry} from "../src/interfaces/IQuoteRegistry.sol";
import {IRotationGovernor, RotationPeriod} from "../src/interfaces/IRotationGovernor.sol";
import {IVaradaFactory} from "../src/interfaces/IVaradaFactory.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {CatalogPublish} from "../test/utils/CatalogFixture.sol";
import {DeployLive} from "./DeployLive.s.sol";
import {DonationAsset} from "src/interfaces/IDonationAsset.sol";

/// @title SwapForkFixture
/// @notice FORK-ONLY fixture for the swap engine's integration tests (`packages/sdk/test/swap.fork.test.ts`).
///         Deploys the whole system with live mode on a mainnet fork (anvil), allowlists WETH and AMZNon
///         as quote assets through their real pools, and launches three tokens: weekly + WETH with an
///         active anti-sniper surcharge, weekly + AMZNon, and live + WETH. Addresses go to
///         `deployments/swap-fork.json`. It refuses to run unless `SWAP_FORK_FIXTURE=1` is set, and it
///         must never be broadcast to a real network.
/// @dev    forge script script/SwapForkFixture.s.sol --sig "fixture()" --rpc-url http://127.0.0.1:8546 --broadcast \
///           --private-key <anvil key 0> with SWAP_FORK_FIXTURE=1 PLATFORM_TREASURY=<any address>
contract SwapForkFixture is DeployLive {
    address internal constant AMZN_ON = 0xbb8774FB97436d23d74C1b882E8E9A69322cFD31;
    // Wikimedia Foundation: an Endaoment org already deployed on mainnet.
    bytes32 internal constant WIKI_ORG = bytes32("200049703");
    address internal constant WIKI_ADDR = 0xe5F123750FcEa2D82b1441048F1A431FDD3D2Dc1;
    bytes32 internal constant WIKI_CAUSE = keccak256(abi.encode(WIKI_ORG));
    bytes32 internal constant FRESH_ORG = bytes32("999000111");
    bytes32 internal constant FRESH_CAUSE = keccak256(abi.encode(FRESH_ORG));

    struct Launched {
        address weeklyWeth;
        address weeklyOndo;
        address liveWeth;
    }

    function fixture() external {
        require(vm.envOr("SWAP_FORK_FIXTURE", uint256(0)) == 1, "fork fixture only");
        address treasury = vm.envAddress("PLATFORM_TREASURY");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        (Deployment memory d, LiveDeployment memory l) = deployWithLive(
            Config({owner: deployer, platformTreasury: treasury, siteSwarmRef: bytes32(0)}), deployer
        );

        bytes32[] memory orgs = new bytes32[](2);
        orgs[0] = WIKI_ORG;
        orgs[1] = FRESH_ORG;
        CatalogPublish.publish(CauseCatalog(d.causeCatalog), orgs);
        address freshAddr = IEndaomentOrgFundFactory(ENDAOMENT_FACTORY).computeOrgAddress(FRESH_ORG);
        CauseRegistry(d.causeRegistry).addCause(WIKI_CAUSE, WIKI_ORG, WIKI_ADDR, "ipfs://wiki");
        CauseRegistry(d.causeRegistry).addCause(FRESH_CAUSE, FRESH_ORG, freshAddr, "ipfs://fresh");

        PoolKey[] memory ethRoute = new PoolKey[](1);
        ethRoute[0] = PoolKey(Currency.wrap(address(0)), Currency.wrap(USDC), 500, 10, IHooks(address(0)));
        QuoteRegistry(d.quoteRegistry).addQuoteAssetWithRoute(WETH, IQuoteRegistry.Kind.Native, ethRoute);
        FeeConsolidator(payable(d.feeConsolidator)).seedReferences(ethRoute);

        PoolKey[] memory amznRoute = new PoolKey[](1);
        amznRoute[0] = PoolKey(Currency.wrap(USDC), Currency.wrap(AMZN_ON), 10_000, 100, IHooks(address(0)));
        QuoteRegistry(d.quoteRegistry).addQuoteAssetWithRoute(AMZN_ON, IQuoteRegistry.Kind.Ondo, amznRoute);
        FeeConsolidator(payable(d.feeConsolidator)).seedReferences(amznRoute);

        Launched memory t;
        // about 0.001 WETH per token; a 40% surcharge decaying over a day
        t.weeklyWeth = _launch(d, "Swap Weekly", "SWKL", WETH, -69_000, 300, 4000, 1 days, "swap-weekly", 1);
        // about 4e-5 AMZNon per token
        t.weeklyOndo = _launch(d, "Swap Ondo", "SOND", AMZN_ON, -100_600, 200, 0, 0, "swap-ondo", 2);
        t.liveWeth = _launchLive(d, "Swap Live", "SLIV", WETH, -69_000, 300, 2000, 1 days, "swap-live", 3);
        vm.stopBroadcast();

        string memory k = "swapfork";
        vm.serializeAddress(k, "factory", d.factory);
        vm.serializeAddress(k, "hook", d.hook);
        vm.serializeAddress(k, "liveHook", l.liveHook);
        vm.serializeAddress(k, "quoteRegistry", d.quoteRegistry);
        vm.serializeAddress(k, "feeConsolidator", d.feeConsolidator);
        vm.serializeAddress(k, "weeklyWeth", t.weeklyWeth);
        vm.serializeAddress(k, "weeklyOndo", t.weeklyOndo);
        string memory json = vm.serializeAddress(k, "liveWeth", t.liveWeth);
        vm.createDir("deployments", true);
        vm.writeJson(json, "deployments/swap-fork.json");
    }

    function _params(
        string memory name,
        string memory symbol,
        address quote,
        int24 startTick,
        uint24 baseFee,
        uint24 sniperStart,
        uint32 sniperDecay,
        string memory label,
        uint256 salt
    ) internal pure returns (IVaradaFactory.DeployParams memory) {
        return IVaradaFactory.DeployParams({
            name: name,
            symbol: symbol,
            metadataURI: "ipfs://swap-fork",
            salt: bytes32(salt),
            baseFeeBps: baseFee,
            sniperFeeStartBps: sniperStart,
            sniperDecaySeconds: sniperDecay,
            startTick: startTick,
            quoteAsset: quote,
            label: label,
            logoRef: bytes32(0),
            categoryMask: CatalogPublish.CATEGORIES,
            regionMask: CatalogPublish.REGIONS,
            donationAsset: DonationAsset.Usdc
        });
    }

    function _launch(
        Deployment memory d,
        string memory name,
        string memory symbol,
        address quote,
        int24 startTick,
        uint24 baseFee,
        uint24 sniperStart,
        uint32 sniperDecay,
        string memory label,
        uint256 salt
    ) internal returns (address token) {
        (token,) = VaradaFactory(d.factory)
            .deployToken(_params(name, symbol, quote, startTick, baseFee, sniperStart, sniperDecay, label, salt));
    }

    function _launchLive(
        Deployment memory d,
        string memory name,
        string memory symbol,
        address quote,
        int24 startTick,
        uint24 baseFee,
        uint24 sniperStart,
        uint32 sniperDecay,
        string memory label,
        uint256 salt
    ) internal returns (address token) {
        (token,) = VaradaFactory(d.factory)
            .deployLiveToken(
                _params(name, symbol, quote, startTick, baseFee, sniperStart, sniperDecay, label, salt),
                IVaradaFactory.LiveParams(WIKI_CAUSE, RotationPeriod.OneDay, 0)
            );
    }
}
