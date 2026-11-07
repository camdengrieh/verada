// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetupOrgNames} from "../../script/SetupOrgNames.s.sol";
import {VaradaFactory} from "../../src/VaradaFactory.sol";
import {ITokenProfileRegistry} from "../../src/interfaces/ITokenProfileRegistry.sol";
import {IVaradaFactory} from "../../src/interfaces/IVaradaFactory.sol";
import {IEnsV2StandardRegistry} from "../../src/interfaces/external/ens/IEnsV2Subregistry.sol";
import {DnsNameLib} from "../../src/libraries/DnsNameLib.sol";
import {CatalogPublish} from "../utils/CatalogFixture.sol";
import {EnsResolutionForkTest} from "./EnsResolution.t.sol";

interface IUniversalResolverFind {
    function findResolver(bytes calldata name) external view returns (address, bytes32, uint256);
}

/// @notice The whole varada.eth tree on ENSv2, on a mainnet fork, in the order the owner runs it:
///         `Deploy`, then varada.eth's resolver set to `VaradaResolver` (as `SetParentResolver`
///         does), then `SetupOrgNames`, which gives varada.eth an ENSv2 subregistry holding
///         `org`. Every `EnsResolutionForkTest` assertion is inherited and re-run with the
///         subregistry in place: token subnames (addr, text, logo, contenthash), varada.eth
///         itself, unknown and deeper names, and direct resolver calls. Those names must not
///         notice `SetupOrgNames`. The tests added here check the org branch and that varada.eth's
///         resolver is never changed. Skipped when ETH_RPC_URL is unset.
contract VaradaNamesV2ForkTest is EnsResolutionForkTest {
    IUniversalResolverFind internal constant UR_FIND =
        IUniversalResolverFind(0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe);
    IEnsV2StandardRegistry internal constant ETH_REGISTRY_V2 =
        IEnsV2StandardRegistry(0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2);

    SetupOrgNames.Result internal org;

    function setUp() public override {
        super.setUp(); // Deploy, varada.eth -> VaradaResolver, launch `pepe`
        address nameOwner = ETH_REGISTRY.ownerOf(ETH_REGISTRY.getTokenId(PARENT_LABEL_ID));
        SetupOrgNames script = new SetupOrgNames();
        string[] memory urls = new string[](1);
        urls[0] = "https://names.varada.eth.limo/ccip/{data}.json";
        org = script.execute(
            nameOwner,
            address(0),
            keccak256("names root"),
            12,
            urls,
            "https://varada.eth.limo/causes?org=",
            address(uint160(uint256(keccak256("VaradaOrgNames on OP"))))
        );
    }

    function _found(string memory name) internal view returns (address r) {
        (r,,) = UR_FIND.findResolver(DnsNameLib.encode(name));
    }

    function test_varadaEthResolverIsUntouched() public view {
        assertEq(ETH_REGISTRY.getResolver("varada"), d.resolver, "still VaradaResolver");
        assertEq(ETH_REGISTRY_V2.getSubregistry("varada"), org.varadaRegistry, "subregistry set");
        assertEq(_found("varada.eth"), d.resolver);
        assertEq(_found("pepe.varada.eth"), d.resolver, "token names fall through");
        assertEq(_found("agent.varada.eth"), d.resolver, "agent names fall through");
        assertEq(_found("x.agent.varada.eth"), d.resolver);
    }

    function test_orgBranchUsesTheOrgResolver() public view {
        assertEq(_found("org.varada.eth"), org.resolver);
        assertEq(_found("american-red-cross.org.varada.eth"), org.resolver);
        assertEq(_found("deeper.american-red-cross.org.varada.eth"), org.resolver);
    }

    function test_tokensCannotTakeTheReservedLabels() public {
        string[3] memory labels = ["org", "names", "agent"];
        for (uint256 i; i < 3; ++i) {
            IVaradaFactory.DeployParams memory p = IVaradaFactory.DeployParams({
                name: "Squat",
                symbol: "SQT",
                metadataURI: "",
                salt: bytes32(uint256(100 + i)),
                baseFeeBps: 300,
                sniperFeeStartBps: 0,
                sniperDecaySeconds: 0,
                startTick: -230_200,
                quoteAsset: WETH,
                label: labels[i],
                logoRef: bytes32(0),
                categoryMask: CatalogPublish.CATEGORIES,
                regionMask: CatalogPublish.REGIONS
            });
            vm.prank(creator);
            vm.expectRevert(
                abi.encodeWithSelector(
                    ITokenProfileRegistry.LabelReserved.selector, keccak256(bytes(labels[i]))
                )
            );
            VaradaFactory(d.factory).deployToken(p);
        }
    }
}
