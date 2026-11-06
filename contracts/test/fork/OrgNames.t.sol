// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {SetupOrgNames} from "../../script/SetupOrgNames.s.sol";
import {VaradaOrgResolver} from "../../src/VaradaOrgResolver.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {
    IAddrResolver,
    IAddressResolver,
    ITextResolver
} from "../../src/interfaces/external/ens/IEnsResolverProfiles.sol";
import {
    EnsV2Roles,
    IEnsV2StandardRegistry
} from "../../src/interfaces/external/ens/IEnsV2Subregistry.sol";
import {DnsNameLib} from "../../src/libraries/DnsNameLib.sol";
import {OffchainLookup} from "../../src/vendor/unruggable/GatewayFetchTarget.sol";
import {IGatewayProtocol} from "../../src/vendor/unruggable/IGatewayProtocol.sol";
import {IGatewayVerifier} from "../../src/vendor/unruggable/IGatewayVerifier.sol";
import {ShardTree} from "../VaradaOrgResolver.t.sol";

interface IUniversalResolverV2Lite {
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        returns (bytes memory, address);
    function findResolver(bytes calldata name) external view returns (address, bytes32, uint256);
}

/// @notice Mainnet-fork rehearsal of the ENSv2 org names: `SetupOrgNames` runs as the real
///         owner of varada.eth against the live ETHRegistry, VerifiableFactory and UserRegistry
///         implementation. Names are then resolved through the live Universal Resolver V2, with
///         this test playing the CCIP-Read client and gateway (the batch gateway included).
///         Skipped when ETH_RPC_URL is unset.
contract OrgNamesForkTest is Test {
    IEnsV2StandardRegistry internal constant ETH_REGISTRY =
        IEnsV2StandardRegistry(0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2);
    IUniversalResolverV2Lite internal constant UR =
        IUniversalResolverV2Lite(0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe);
    IEndaomentOrgFundFactory internal constant ENDAOMENT_FACTORY =
        IEndaomentOrgFundFactory(0x10fD9348136dCea154F752fe0B6dB45Fc298A589);

    IGatewayVerifier internal constant OP_VERIFIER =
        IGatewayVerifier(0x7F49A74D264e48E64e76E136b2a4BA1310C3604c);
    address internal l2Registry = address(uint160(uint256(keccak256("VaradaOrgNames on OP"))));
    uint256 internal constant OP = 0x80000000 | 10;
    uint256 internal constant BASE = 0x80000000 | 8453;
    bytes4 internal constant BATCH_QUERY = bytes4(keccak256("query((address,string[],bytes)[])"));

    struct Lookup {
        address sender;
        string[] urls;
        bytes data;
    }

    SetupOrgNames internal script;
    SetupOrgNames.Result internal r;
    address internal nameOwner;
    address internal parentResolverBefore;

    bytes32 internal redCross = bytes32("530196605"); // American Red Cross
    bytes32 internal npr = bytes32("520907625"); // National Public Radio
    /// @dev NPR's live Base entity 0x69D6…a1d2 was created under the hyphenated EIN.
    bytes32 internal nprBase = bytes32("52-0907625");
    bytes32 internal lhRed = keccak256("american-red-cross");
    bytes32 internal lhNpr = keccak256("national-public-radio");
    bytes32 internal root;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        script = new SetupOrgNames();
        nameOwner = ETH_REGISTRY.ownerOf(ETH_REGISTRY.getTokenId(script.parentId()));
        (parentResolverBefore,,) = UR.findResolver(DnsNameLib.encode("varada.eth"));
        root = ShardTree.root(_all(), BITS);
        string[] memory urls = new string[](1);
        urls[0] = "https://org-gateway.varada.example/ccip/{sender}/{data}.json";
        uint256 g = gasleft();
        r = script.execute(
            nameOwner, address(0), root, BITS, urls, "https://varada.eth.limo/org/", l2Registry
        );
        // Names are fresh on Optimism: the verifier proves empty records (mocked here; the live
        // gateway run is in services/org-gateway). getLatestContext stays live.
        _mockL2(bytes32(0), bytes32(0));
        emit log_named_uint("setup gas (all steps)", g - gasleft());
    }

    // ------------------------------------------------------------------ CCIP-Read client

    /// @dev What the Optimism verifier "proves" for any request: default id and Base override.
    function _mockL2(bytes32 defaultId, bytes32 baseOverride) internal {
        bytes[] memory values = new bytes[](4);
        values[0] = abi.encode(defaultId);
        values[1] = abi.encode(bytes32(0));
        values[2] = abi.encode(bytes32(0));
        values[3] = abi.encode(baseOverride);
        vm.mockCall(
            address(OP_VERIFIER),
            abi.encodeWithSelector(IGatewayVerifier.getStorageValues.selector),
            abi.encode(values, uint8(0))
        );
    }

    /// @dev One shard bit: two shards, so the test can build the tree (the catalogue uses 12).
    uint8 internal constant BITS = 1;

    function _all() internal view returns (VaradaOrgResolver.Entry[] memory all) {
        all = new VaradaOrgResolver.Entry[](2);
        all[0] = ShardTree.entry(lhRed, redCross);
        all[1] = VaradaOrgResolver.Entry(lhNpr, npr, npr, nprBase);
    }

    function _gateway(bytes memory callData) internal view returns (bytes memory) {
        if (bytes4(callData) == IGatewayProtocol.proveRequest.selector) return "";
        if (bytes4(callData) == BATCH_QUERY) {
            Lookup[] memory reqs = abi.decode(_tail(callData), (Lookup[]));
            bool[] memory failures = new bool[](reqs.length);
            bytes[] memory responses = new bytes[](reqs.length);
            for (uint256 i; i < reqs.length; ++i) {
                assertEq(reqs[i].sender, r.resolver, "only our resolver goes offchain");
                responses[i] = _gateway(reqs[i].data);
            }
            return abi.encode(failures, responses);
        }
        return ShardTree.answer(_all(), abi.decode(callData, (uint256)), BITS);
    }

    function _ccipCall(address target, bytes memory call) internal view returns (bytes memory) {
        for (uint256 hop; hop < 4; ++hop) {
            (bool ok, bytes memory ret) = target.staticcall(call);
            if (ok) return ret;
            require(bytes4(ret) == OffchainLookup.selector, "not OffchainLookup");
            (address sender,, bytes memory callData, bytes4 cb, bytes memory extra) =
                abi.decode(_tail(ret), (address, string[], bytes, bytes4, bytes));
            target = sender;
            call = abi.encodeWithSelector(cb, _gateway(callData), extra);
        }
        revert("too many hops");
    }

    function _resolve(string memory dotted, bytes memory data)
        internal
        view
        returns (bytes memory result, address resolver)
    {
        bytes memory ret = _ccipCall(
            address(UR),
            abi.encodeCall(IUniversalResolverV2Lite.resolve, (DnsNameLib.encode(dotted), data))
        );
        return abi.decode(ret, (bytes, address));
    }

    function _tail(bytes memory b) internal pure returns (bytes memory out) {
        out = new bytes(b.length - 4);
        for (uint256 i; i < out.length; ++i) {
            out[i] = b[i + 4];
        }
    }

    function _node(string memory dotted) internal pure returns (bytes32) {
        return DnsNameLib.namehash(DnsNameLib.encode(dotted), 0);
    }

    // ------------------------------------------------------------------ tests

    function test_fork_orgNameResolvesOnEthOptimismAndBase() public view {
        string memory n = "american-red-cross.org.varada.eth";
        address expected = ENDAOMENT_FACTORY.computeOrgAddress(redCross);
        assertEq(expected, 0xD3deD803b6a80ab9E6745a8De4fB962f2904749F, "same CREATE2 on 1/10/8453");
        uint256[3] memory coins = [uint256(60), OP, BASE];
        for (uint256 i; i < 3; ++i) {
            (bytes memory res, address used) =
                _resolve(n, abi.encodeCall(IAddressResolver.addr, (_node(n), coins[i])));
            assertEq(used, r.resolver, "UR picked the org resolver");
            assertEq(abi.decode(res, (bytes)), abi.encodePacked(expected));
        }
        (bytes memory url,) = _resolve(n, abi.encodeCall(ITextResolver.text, (_node(n), "url")));
        assertEq(abi.decode(url, (string)), "https://varada.eth.limo/org/american-red-cross");
    }

    function test_fork_baseOverrideResolvesToTheLiveBaseEntity() public view {
        string memory n = "national-public-radio.org.varada.eth";
        address main = ENDAOMENT_FACTORY.computeOrgAddress(npr);
        address base = ENDAOMENT_FACTORY.computeOrgAddress(nprBase);
        assertEq(main, 0x58EC5c93991d900ff4Ed4FA102F816B9120F752A);
        assertEq(base, 0x69D68d5118Fc6FAC79d5D1c9c1EF5515dd4aa1d2);
        uint256[3] memory coins = [uint256(60), OP, BASE];
        address[3] memory want = [main, main, base];
        for (uint256 i; i < 3; ++i) {
            (bytes memory res,) =
                _resolve(n, abi.encodeCall(IAddressResolver.addr, (_node(n), coins[i])));
            assertEq(abi.decode(res, (bytes)), abi.encodePacked(want[i]));
        }
    }

    function test_fork_finalizedOptimismRecordWinsWithoutTheMerkleGateway() public {
        // Once the name is in finalized Optimism state, its record answers directly. Here the
        // registrar has repointed Base to the hyphenated id, which the Merkle tree does not have.
        _mockL2(redCross, nprBase);
        string memory n = "american-red-cross.org.varada.eth";
        (bytes memory eth,) = _resolve(n, abi.encodeCall(IAddressResolver.addr, (_node(n), 60)));
        (bytes memory base,) = _resolve(n, abi.encodeCall(IAddressResolver.addr, (_node(n), BASE)));
        assertEq(
            abi.decode(eth, (bytes)),
            abi.encodePacked(ENDAOMENT_FACTORY.computeOrgAddress(redCross))
        );
        assertEq(
            abi.decode(base, (bytes)),
            abi.encodePacked(ENDAOMENT_FACTORY.computeOrgAddress(nprBase))
        );
    }

    function test_fork_unknownOrgResolvesEmpty() public view {
        string memory n = "not-a-charity.org.varada.eth";
        (bytes memory res, address used) =
            _resolve(n, abi.encodeCall(IAddrResolver.addr, (_node(n))));
        assertEq(used, r.resolver);
        assertEq(abi.decode(res, (address)), address(0));
    }

    function test_fork_restOfVaradaEthIsUntouched() public view {
        (address now_,,) = UR.findResolver(DnsNameLib.encode("varada.eth"));
        assertEq(now_, parentResolverBefore, "varada.eth keeps its resolver");
        (address token,,) = UR.findResolver(DnsNameLib.encode("some-token.varada.eth"));
        assertEq(token, parentResolverBefore, "other labels fall through to varada.eth's resolver");
        (address ns,,) = UR.findResolver(DnsNameLib.encode("org.varada.eth"));
        assertEq(ns, r.resolver);
        assertEq(ETH_REGISTRY.getSubregistry("varada"), r.varadaRegistry);
        (address parent, string memory label) = IEnsV2StandardRegistry(r.orgRegistry).getParent();
        assertEq(parent, r.varadaRegistry);
        assertEq(label, "org");
    }

    function test_fork_claimedNameIsAnOwnedV2TokenThatKeepsResolving() public {
        address claimant = address(uint160(uint256(keccak256("red-cross-claim-wallet"))));
        uint256 roles = EnsV2Roles.withAdmin(EnsV2Roles.ROLE_SET_RESOLVER);
        IEnsV2StandardRegistry orgReg = IEnsV2StandardRegistry(r.orgRegistry);
        vm.prank(nameOwner);
        uint256 g = gasleft();
        uint256 tokenId = orgReg.register(
            "american-red-cross", claimant, address(0), r.resolver, roles, type(uint64).max
        );
        emit log_named_uint("claim register gas", g - gasleft());
        assertEq(orgReg.ownerOf(tokenId), claimant);

        string memory n = "american-red-cross.org.varada.eth";
        (bytes memory res, address used) =
            _resolve(n, abi.encodeCall(IAddressResolver.addr, (_node(n), BASE)));
        assertEq(used, r.resolver);
        assertEq(
            abi.decode(res, (bytes)),
            abi.encodePacked(ENDAOMENT_FACTORY.computeOrgAddress(redCross))
        );

        // The owner controls its name: pointing it at another resolver takes effect in the UR.
        address own = makeAddr("claimant-resolver");
        vm.prank(claimant);
        orgReg.setResolver(tokenId, own);
        (address found,,) = UR.findResolver(DnsNameLib.encode(n));
        assertEq(found, own);
        // Unclaimed siblings still use the wildcard.
        (address sibling,,) =
            UR.findResolver(DnsNameLib.encode("national-public-radio.org.varada.eth"));
        assertEq(sibling, r.resolver);
    }

    function test_fork_rerunIsANoOp() public {
        string[] memory urls = new string[](0);
        SetupOrgNames.Result memory again =
            script.execute(nameOwner, r.resolver, bytes32(0), 0, urls, "", address(0));
        assertEq(again.varadaRegistry, r.varadaRegistry);
        assertEq(again.orgRegistry, r.orgRegistry);
        assertEq(again.resolver, r.resolver);
    }

    function test_fork_refusesASignerWhoIsNotTheOwner() public {
        address stranger = address(uint160(uint256(keccak256("stranger"))));
        vm.expectRevert(
            abi.encodeWithSelector(SetupOrgNames.NotOwner.selector, nameOwner, stranger)
        );
        script.execute(stranger, r.resolver, bytes32(0), 0, new string[](0), "", address(0));
    }
}
