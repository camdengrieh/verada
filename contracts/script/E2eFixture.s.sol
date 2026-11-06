// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// LOCAL ANVIL FORK ONLY. Never broadcast this to a live network: it deploys the whole system with
// the sender as owner/treasury, swaps the epoch governor to the plaintext MockVotingScheme and
// launches a throwaway token. It is the fixture behind apps/web/test/fork (see its harness header):
//   anvil --fork-url <mainnet rpc> --chain-id 1 --auto-impersonate
//   forge script script/E2eFixture.s.sol:E2eFixture --sig "phase1()" --rpc-url <anvil> \
//     --sender <funded fresh address> --unlocked --broadcast --skip 'test/**'
// then move the node's clock one epoch ahead of the launch (the catalogue is published after epoch 0
// began, so epoch 0 has no pool; the web tests expect epoch 1, 2 hours in). Writes
// deployments/e2e.json (the file the web tests read as VARADA_FORK_FIXTURE).
// Full deployment + one launched token (held by the sender) + a curator agent + a two-org catalogue.
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {Deploy} from "./Deploy.s.sol";
import {CauseCatalog} from "../src/CauseCatalog.sol";
import {CauseRegistry} from "../src/CauseRegistry.sol";
import {CuratorRegistry} from "../src/CuratorRegistry.sol";
import {DonationDistributor} from "../src/DonationDistributor.sol";
import {EpochGovernor} from "../src/EpochGovernor.sol";
import {FeeConsolidator} from "../src/FeeConsolidator.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {TakeoverGovernor} from "../src/TakeoverGovernor.sol";
import {TokenProfileRegistry} from "../src/TokenProfileRegistry.sol";
import {VaradaFactory} from "../src/VaradaFactory.sol";
import {ZamaVotingScheme} from "../src/governance/ZamaVotingScheme.sol";
import {IQuoteRegistry} from "../src/interfaces/IQuoteRegistry.sol";
import {IVaradaFactory} from "../src/interfaces/IVaradaFactory.sol";
import {IVotingScheme} from "../src/interfaces/IVotingScheme.sol";
import {MockVotingScheme} from "../test/mocks/GovernanceMocks.sol";
import {CatalogPublish} from "../test/utils/CatalogFixture.sol";
import {DonationAsset} from "src/interfaces/IDonationAsset.sol";

interface IWETH9 is IERC20 {
    function deposit() external payable;
}

contract E2eFixture is Deploy {
    bytes32 internal constant ORG_A = bytes32("999000111");
    bytes32 internal constant ORG_B = bytes32("200049703");

    function _accept(address c, address me) internal {
        (bool ok, bytes memory out) = c.staticcall(abi.encodeWithSignature("owner()"));
        if (ok && abi.decode(out, (address)) == me) return;
        (bool ok2, bytes memory out2) = c.staticcall(abi.encodeWithSignature("pendingOwner()"));
        if (ok2 && abi.decode(out2, (address)) == me) {
            (bool done,) = c.call(abi.encodeWithSignature("acceptOwnership()"));
            require(done, "accept");
        }
    }

    function phase1() external {
        vm.startBroadcast();
        (, address me,) = vm.readCallers();
        Deployment memory d = deploy(Config({owner: me, platformTreasury: me, siteSwarmRef: bytes32(0)}), me);

        _accept(d.causeRegistry, me);
        _accept(d.epochGovernor, me);
        _accept(d.donationDistributor, me);
        _accept(d.feeVault, me);
        _accept(d.quoteRegistry, me);
        _accept(d.feeConsolidator, me);
        _accept(d.profileRegistry, me);
        _accept(d.votingScheme, me);
        _accept(d.takeoverGovernor, me);
        _accept(d.causeCatalog, me);
        _accept(d.curatorRegistry, me);

        bytes32[] memory orgs = new bytes32[](2);
        orgs[0] = ORG_A;
        orgs[1] = ORG_B;
        CatalogPublish.publish(CauseCatalog(d.causeCatalog), orgs);

        MockVotingScheme mock = new MockVotingScheme();
        mock.setGovernor(d.epochGovernor, true);
        mock.setGovernor(d.takeoverGovernor, true);
        EpochGovernor(d.epochGovernor).setScheme(IVotingScheme(address(mock)));

        PoolKey memory ethKey =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(USDC), 500, 10, IHooks(address(0)));
        PoolKey[] memory route = new PoolKey[](1);
        route[0] = ethKey;
        QuoteRegistry(d.quoteRegistry).addQuoteAssetWithRoute(WETH, IQuoteRegistry.Kind.Native, route);
        FeeConsolidator(payable(d.feeConsolidator)).seedReferences(route);

        (uint256 agentId, address vault) = CuratorRegistry(d.curatorRegistry)
            .registerAgent(2, "hunger", me, "data:application/json;base64,e30=", "Hunger and famine curator");

        IVaradaFactory.DeployParams memory p = IVaradaFactory.DeployParams({
            name: "Fork Coin",
            symbol: "FORK",
            metadataURI: "bzz://1111111111111111111111111111111111111111111111111111111111111111",
            salt: bytes32(uint256(1)),
            baseFeeBps: 300,
            sniperFeeStartBps: 0,
            sniperDecaySeconds: 0,
            startTick: -230_200,
            quoteAsset: WETH,
            label: "fork-coin",
            logoRef: bytes32(uint256(0xabc)),
            categoryMask: CatalogPublish.CATEGORIES,
            regionMask: CatalogPublish.REGIONS,
            donationAsset: DonationAsset.Usdc
        });
        (address token,) = VaradaFactory(d.factory).deployToken(p);

        PoolSwapTest router = new PoolSwapTest(IPoolManager(POOL_MANAGER));
        IWETH9(WETH).deposit{value: 1 ether}();
        IERC20(WETH).approve(address(router), type(uint256).max);
        (address c0, address c1) = token < WETH ? (token, WETH) : (WETH, token);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 0x800000,
            tickSpacing: 200,
            hooks: IHooks(d.hook)
        });
        bool zeroForOne = c0 == WETH;
        router.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(1 ether),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopBroadcast();

        string memory k = "e2e";
        vm.serializeAddress(k, "me", me);
        vm.serializeAddress(k, "factory", d.factory);
        vm.serializeAddress(k, "epochGovernor", d.epochGovernor);
        vm.serializeAddress(k, "takeoverGovernor", d.takeoverGovernor);
        vm.serializeAddress(k, "profileRegistry", d.profileRegistry);
        vm.serializeAddress(k, "curatorRegistry", d.curatorRegistry);
        vm.serializeAddress(k, "causeCatalog", d.causeCatalog);
        vm.serializeAddress(k, "mockScheme", address(mock));
        vm.serializeAddress(k, "token", token);
        vm.serializeAddress(k, "vault", vault);
        vm.serializeUint(k, "agentId", agentId);
        string memory json = vm.serializeUint(k, "deployBlock", d.deployBlock);
        vm.writeJson(json, "deployments/e2e.json");
    }
}
