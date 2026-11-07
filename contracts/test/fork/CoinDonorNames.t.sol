// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {SetupCoinDonorNames} from "../../script/SetupCoinDonorNames.s.sol";
import {VaradaCoinResolver} from "../../src/VaradaCoinResolver.sol";
import {VaradaDonorNames} from "../../src/VaradaDonorNames.sol";
import {ITokenProfileRegistry} from "../../src/interfaces/ITokenProfileRegistry.sol";
import {
    IAddrResolver,
    IAddressResolver,
    IContentHashResolver
} from "../../src/interfaces/external/ens/IEnsResolverProfiles.sol";
import {IEnsV2StandardRegistry} from "../../src/interfaces/external/ens/IEnsV2Subregistry.sol";
import {DnsNameLib} from "../../src/libraries/DnsNameLib.sol";
import {LabelLib} from "../../src/libraries/LabelLib.sol";

interface IUR {
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        returns (bytes memory, address);
    function findResolver(bytes calldata name) external view returns (address, bytes32, uint256);
}

interface IFactoryOf {
    function factory() external view returns (address);
}

/// @notice coin.varada.eth and donor.varada.eth on the LIVE mainnet deployment (VaradaResolver
///         0x4E95…, TokenProfileRegistry 0x5B24…, varada.eth's ENSv2 registry from SetupOrgNames),
///         resolved through the live Universal Resolver V2. Skipped when ETH_RPC_URL is unset.
contract CoinDonorNamesForkTest is Test {
    IEnsV2StandardRegistry internal constant ETH_REGISTRY =
        IEnsV2StandardRegistry(0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2);
    IUR internal constant UR = IUR(0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe);
    ITokenProfileRegistry internal constant PROFILES =
        ITokenProfileRegistry(0x5B24531Db75E1cc630CFFdFc64b9A437fEdAD7b0);
    uint256 internal constant OP = 0x80000000 | 10;
    uint256 internal constant BASE = 0x80000000 | 8453;

    SetupCoinDonorNames internal script;
    SetupCoinDonorNames.Result internal r;
    address internal nameOwner;
    address internal parentResolver;
    address internal token = address(uint160(uint256(keccak256("harambefund token"))));
    address internal donor = address(uint160(uint256(keccak256("camden donor wallet"))));

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        nameOwner = ETH_REGISTRY.ownerOf(ETH_REGISTRY.getTokenId(uint256(keccak256("varada"))));
        parentResolver = ETH_REGISTRY.getResolver("varada");
        script = new SetupCoinDonorNames();
        r = script.execute(nameOwner, address(PROFILES));
        // A coin launch: the factory registers the label in the profile registry.
        vm.prank(IFactoryOf(address(PROFILES)).factory());
        PROFILES.register(token, "harambefund", address(this), bytes32(0));
    }

    function _resolve(string memory n, bytes memory data)
        internal
        view
        returns (bytes memory res, address used)
    {
        return UR.resolve(DnsNameLib.encode(n), data);
    }

    function _found(string memory n) internal view returns (address f) {
        (f,,) = UR.findResolver(DnsNameLib.encode(n));
    }

    function test_fork_coinNameResolvesToTheToken() public view {
        (bytes memory a, address used) = _resolve(
            "harambefund.coin.varada.eth", abi.encodeCall(IAddrResolver.addr, (bytes32(0)))
        );
        assertEq(used, r.coinResolver);
        assertEq(abi.decode(a, (address)), token);
        (bytes memory legacy,) =
            _resolve("harambefund.varada.eth", abi.encodeCall(IAddrResolver.addr, (bytes32(0))));
        assertEq(abi.decode(legacy, (address)), token, "same coin under varada.eth");
        (bytes memory ch,) = _resolve(
            "harambefund.coin.varada.eth",
            abi.encodeCall(IContentHashResolver.contenthash, (bytes32(0)))
        );
        (bytes memory site,) =
            _resolve("varada.eth", abi.encodeCall(IContentHashResolver.contenthash, (bytes32(0))));
        assertEq(abi.decode(ch, (bytes)), abi.decode(site, (bytes)), "coin page is the site");
        (bytes memory unknown,) = _resolve(
            "not-a-coin-xyz.coin.varada.eth", abi.encodeCall(IAddrResolver.addr, (bytes32(0)))
        );
        assertEq(abi.decode(unknown, (address)), address(0));
    }

    function test_fork_coinCopycatsAndReservedLabelsCannotLaunch() public {
        address factory = IFactoryOf(address(PROFILES)).factory();
        vm.prank(factory);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITokenProfileRegistry.LabelTaken.selector, keccak256("harambefund"), token
            )
        );
        PROFILES.register(address(0xBEEF), "harambefund", address(this), bytes32(0));
        string[5] memory reserved = ["coin", "donor", "org", "agent", "names"];
        for (uint256 i; i < 5; ++i) {
            vm.prank(factory);
            vm.expectRevert(
                abi.encodeWithSelector(
                    ITokenProfileRegistry.LabelReserved.selector, keccak256(bytes(reserved[i]))
                )
            );
            PROFILES.register(address(uint160(0xC0DE + i)), reserved[i], address(this), bytes32(0));
        }
    }

    function test_fork_donorNameClaimResolveRelease() public {
        VaradaDonorNames d = VaradaDonorNames(r.donorNames);
        vm.prank(donor);
        d.claim("camden");
        assertEq(d.nameOf(donor), "camden");
        uint256[3] memory coins = [uint256(60), OP, BASE];
        for (uint256 i; i < 3; ++i) {
            (bytes memory a, address used) = _resolve(
                "camden.donor.varada.eth",
                abi.encodeCall(IAddressResolver.addr, (bytes32(0), coins[i]))
            );
            assertEq(used, r.donorNames);
            assertEq(abi.decode(a, (bytes)), abi.encodePacked(donor));
        }
        // Legacy direct lookup by node works too.
        assertEq(
            d.addr(DnsNameLib.namehash(DnsNameLib.encode("camden.donor.varada.eth"), 0)), donor
        );

        address other = address(uint160(uint256(keccak256("someone else"))));
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(VaradaDonorNames.Taken.selector, "camden", donor));
        d.claim("camden");
        vm.prank(donor);
        vm.expectRevert(
            abi.encodeWithSelector(VaradaDonorNames.AlreadyHasName.selector, donor, "camden")
        );
        d.claim("camden2");

        vm.prank(donor);
        d.release();
        (bytes memory gone,) =
            _resolve("camden.donor.varada.eth", abi.encodeCall(IAddrResolver.addr, (bytes32(0))));
        assertEq(abi.decode(gone, (address)), address(0));
        vm.prank(other);
        d.claim("camden");
        assertEq(d.holderOf(keccak256("camden")), other);
    }

    function test_fork_donorRulesAndOwnerLimits() public {
        VaradaDonorNames d = VaradaDonorNames(r.donorNames);
        vm.startPrank(donor);
        vm.expectRevert(abi.encodeWithSelector(VaradaDonorNames.Reserved.selector, "coin"));
        d.claim("coin");
        vm.expectRevert(abi.encodeWithSelector(VaradaDonorNames.TooShort.selector, "ab"));
        d.claim("ab");
        vm.expectRevert(abi.encodeWithSelector(LabelLib.InvalidLabel.selector, "Camden"));
        d.claim("Camden");
        vm.stopPrank();
        assertFalse(d.available("coin"));
        assertTrue(d.available("harambe-fan"));
        // The owner can reserve only unclaimed labels and has no power over a claimed one.
        vm.prank(donor);
        d.claim("taken-name");
        vm.prank(nameOwner);
        vm.expectRevert(
            abi.encodeWithSelector(VaradaDonorNames.Taken.selector, "taken-name", donor)
        );
        d.setReserved("taken-name", true);
    }

    function test_fork_restOfTheTreeIsUntouched() public view {
        assertEq(
            ETH_REGISTRY.getResolver("varada"), parentResolver, "varada.eth keeps VaradaResolver"
        );
        assertEq(_found("varada.eth"), parentResolver);
        assertEq(_found("something.varada.eth"), parentResolver);
        assertEq(_found("coin.varada.eth"), r.coinResolver);
        assertEq(_found("donor.varada.eth"), r.donorNames);
        assertTrue(_found("x.org.varada.eth") != address(0), "org branch still set");
        assertEq(
            VaradaCoinResolver(r.coinResolver).toParentName(DnsNameLib.encode("a.coin.varada.eth")),
            DnsNameLib.encode("a.varada.eth")
        );
    }

    function test_fork_rerunIsANoOp() public {
        SetupCoinDonorNames.Result memory again = script.execute(nameOwner, address(PROFILES));
        assertEq(again.coinResolver, r.coinResolver);
        assertEq(again.donorNames, r.donorNames);
    }
}
