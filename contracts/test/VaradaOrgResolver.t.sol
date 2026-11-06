// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

import {VaradaOrgResolver} from "../src/VaradaOrgResolver.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {
    IAddrResolver,
    IAddressResolver,
    IContentHashResolver,
    IExtendedResolver,
    ITextResolver
} from "../src/interfaces/external/ens/IEnsResolverProfiles.sol";
import {VaradaOrgNames} from "../src/l2/VaradaOrgNames.sol";
import {DnsNameLib} from "../src/libraries/DnsNameLib.sol";
import {OffchainLookup} from "../src/vendor/unruggable/GatewayFetchTarget.sol";
import {GatewayRequest} from "../src/vendor/unruggable/GatewayRequest.sol";
import {IGatewayProtocol} from "../src/vendor/unruggable/IGatewayProtocol.sol";
import {IGatewayVerifier} from "../src/vendor/unruggable/IGatewayVerifier.sol";

contract StubOrgFactory {
    function computeOrgAddress(bytes32 orgId) external pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("org", orgId)))));
    }
}

/// @notice Stands in for the Unruggable verifier plus gateway. A "proof" is
///         `abi.encode(keccak256(req.ops), bytes[] values)`; the verifier checks the request
///         hash so a test cannot answer a different request than the resolver built.
contract MockGatewayVerifier is IGatewayVerifier {
    bytes public constant CONTEXT = "ctx";

    error WrongRequest();

    function getLatestContext() external pure returns (bytes memory) {
        return CONTEXT;
    }

    function gatewayURLs() external pure returns (string[] memory) {
        return new string[](0);
    }

    function getStorageValues(bytes memory context, GatewayRequest memory req, bytes memory proof)
        external
        pure
        returns (bytes[] memory values, uint8 exitCode)
    {
        require(keccak256(context) == keccak256(CONTEXT), "context");
        (bytes32 reqHash, bytes[] memory v) = abi.decode(proof, (bytes32, bytes[]));
        if (reqHash != keccak256(req.ops)) revert WrongRequest();
        return (v, 0);
    }
}

/// @notice OpenZeppelin standard tree helpers, shared with the fork test.
library OrgNamesTree {
    /// @dev Same org id on Ethereum, Optimism and Base.
    function leaf(bytes32 labelhash, bytes32 orgId) internal pure returns (bytes32) {
        return leaf(labelhash, orgId, orgId, orgId);
    }

    function leaf(bytes32 labelhash, bytes32 idEth, bytes32 idOp, bytes32 idBase)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(labelhash, idEth, idOp, idBase))));
    }

    function pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }
}

/// @notice Minimal EIP-3668 client: follows OffchainLookup reverts, answering Unruggable
///         `proveRequest` calls from `l2` state and everything else from the Merkle tree.
abstract contract CcipHarness is Test {
    struct L2Record {
        bool set;
        bytes32 defaultId;
        bytes32[3] overrides; // chains 1, 10, 8453
    }

    mapping(bytes32 => L2Record) internal l2;
    mapping(bytes32 => bytes32[4]) internal merkleIds; // labelhash => ids + marker
    mapping(bytes32 => bytes32[]) internal merkleProof;
    bytes32 internal merkleRoot;
    uint256 internal l2Lookups;
    uint256 internal merkleLookups;

    function _ccip(address target, bytes memory call) internal returns (bytes memory) {
        for (uint256 hop; hop < 6; ++hop) {
            (bool ok, bytes memory ret) = target.staticcall(call);
            if (ok) return ret;
            if (bytes4(ret) != OffchainLookup.selector) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            (address sender,, bytes memory req, bytes4 cb, bytes memory carry) =
                abi.decode(_tail(ret), (address, string[], bytes, bytes4, bytes));
            target = sender;
            call = abi.encodeWithSelector(cb, _gateway(req), carry);
        }
        revert("too many hops");
    }

    function _gateway(bytes memory req) internal virtual returns (bytes memory) {
        if (bytes4(req) == IGatewayProtocol.proveRequest.selector) {
            ++l2Lookups;
            (, GatewayRequest memory r) = abi.decode(_tail(req), (bytes, GatewayRequest));
            bytes32 lh = _labelhashFor(r);
            L2Record storage rec = l2[lh];
            bytes[] memory values = new bytes[](4);
            values[0] = abi.encode(rec.set ? rec.defaultId : bytes32(0));
            for (uint256 i; i < 3; ++i) {
                values[i + 1] = abi.encode(rec.overrides[i]);
            }
            return abi.encode(keccak256(r.ops), values);
        }
        ++merkleLookups;
        bytes32 lh2 = abi.decode(req, (bytes32));
        bytes32[4] storage ids = merkleIds[lh2];
        if (ids[3] == bytes32(0)) {
            return abi.encode(merkleRoot, bytes32(0), bytes32(0), bytes32(0), new bytes32[](0));
        }
        return abi.encode(merkleRoot, ids[0], ids[1], ids[2], merkleProof[lh2]);
    }

    /// @dev Tests know every labelhash they ask about; find the one whose request matches.
    function _labelhashFor(GatewayRequest memory r) internal view virtual returns (bytes32);

    function _tail(bytes memory b) internal pure returns (bytes memory out) {
        out = new bytes(b.length - 4);
        for (uint256 i; i < out.length; ++i) {
            out[i] = b[i + 4];
        }
    }
}

contract VaradaOrgResolverTest is CcipHarness {
    bytes internal constant NS = hex"036f7267067661726164610365746800"; // org.varada.eth
    uint256 internal constant OP = 0x80000000 | 10;
    uint256 internal constant BASE = 0x80000000 | 8453;

    StubOrgFactory internal factory;
    MockGatewayVerifier internal mockVerifier;
    VaradaOrgResolver internal resolver;
    address internal owner = makeAddr("owner");
    address internal l2Registry = makeAddr("l2-registry");

    bytes32 internal redCross = bytes32("530196605");
    bytes32 internal crossroads = bytes32("237093881");
    bytes32 internal lhRed = keccak256("american-red-cross");
    bytes32 internal lhCross = keccak256("crossroads-harmony");
    bytes32 internal lhNpr = keccak256("national-public-radio");
    bytes32 internal npr = bytes32("520907625");
    bytes32 internal nprBase = bytes32("52-0907625");
    bytes32[] internal known;

    function setUp() public {
        factory = new StubOrgFactory();
        mockVerifier = new MockGatewayVerifier();
        merkleRoot = OrgNamesTree.pair(
            OrgNamesTree.leaf(lhRed, redCross), OrgNamesTree.leaf(lhCross, crossroads)
        );
        merkleIds[lhRed] = [redCross, redCross, redCross, bytes32(uint256(1))];
        merkleProof[lhRed].push(OrgNamesTree.leaf(lhCross, crossroads));
        merkleIds[lhCross] = [crossroads, crossroads, crossroads, bytes32(uint256(1))];
        merkleProof[lhCross].push(OrgNamesTree.leaf(lhRed, redCross));
        known.push(lhRed);
        known.push(lhCross);
        known.push(lhNpr);
        known.push(keccak256("nobody"));
        resolver = _deploy(merkleRoot);
    }

    function _deploy(bytes32 root_) internal returns (VaradaOrgResolver) {
        string[] memory urls = new string[](1);
        urls[0] = "https://gw.example/ccip/{sender}/{data}.json";
        string[] memory l2Urls = new string[](1);
        l2Urls[0] = "https://optimism.gateway.unruggable.com";
        return new VaradaOrgResolver(
            owner,
            IEndaomentOrgFundFactory(address(factory)),
            NS,
            root_,
            urls,
            "https://varada.eth.limo/org/",
            l2Registry,
            mockVerifier,
            l2Urls
        );
    }

    function _labelhashFor(GatewayRequest memory r) internal view override returns (bytes32) {
        for (uint256 i; i < known.length; ++i) {
            if (keccak256(resolver.l2Request(known[i]).ops) == keccak256(r.ops)) return known[i];
        }
        revert("unknown request");
    }

    function _resolve(string memory dotted, bytes memory data) internal returns (bytes memory) {
        bytes memory ret = _ccip(
            address(resolver),
            abi.encodeCall(IExtendedResolver.resolve, (DnsNameLib.encode(dotted), data))
        );
        return abi.decode(ret, (bytes));
    }

    function _node(string memory dotted) internal pure returns (bytes32) {
        return DnsNameLib.namehash(DnsNameLib.encode(dotted), 0);
    }

    function _addr(string memory n, uint256 coinType) internal returns (bytes memory) {
        return abi.decode(
            _resolve(n, abi.encodeCall(IAddressResolver.addr, (_node(n), coinType))), (bytes)
        );
    }

    // ------------------------------------------------------------------ L2 path

    function test_finalizedL2RecordResolvesWithoutTheMerkleGateway() public {
        l2[lhRed].set = true;
        l2[lhRed].defaultId = redCross;
        string memory n = "american-red-cross.org.varada.eth";
        bytes memory want = abi.encodePacked(factory.computeOrgAddress(redCross));
        assertEq(_addr(n, 60), want);
        assertEq(_addr(n, OP), want);
        assertEq(_addr(n, BASE), want);
        assertEq(merkleLookups, 0, "no fallback");
        assertEq(l2Lookups, 3);
    }

    function test_l2RecordWinsOverTheMerkleTree() public {
        // The registrar repointed the name on Optimism after the tree was built.
        bytes32 newer = bytes32("999999999");
        l2[lhRed].set = true;
        l2[lhRed].defaultId = newer;
        assertEq(
            _addr("american-red-cross.org.varada.eth", 60),
            abi.encodePacked(factory.computeOrgAddress(newer))
        );
        assertEq(merkleLookups, 0);
    }

    function test_l2PerChainOverridesAndNone() public {
        l2[lhNpr].set = true;
        l2[lhNpr].defaultId = npr;
        l2[lhNpr].overrides[2] = nprBase; // Base
        string memory n = "national-public-radio.org.varada.eth";
        assertEq(_addr(n, 60), abi.encodePacked(factory.computeOrgAddress(npr)));
        assertEq(_addr(n, OP), abi.encodePacked(factory.computeOrgAddress(npr)));
        assertEq(_addr(n, BASE), abi.encodePacked(factory.computeOrgAddress(nprBase)));

        l2[lhNpr].overrides[1] = bytes32(type(uint256).max); // NONE on Optimism
        assertEq(_addr(n, OP).length, 0);
        assertEq(_addr(n, 60), abi.encodePacked(factory.computeOrgAddress(npr)));
    }

    function _l2Lookup(string memory n, bytes memory data)
        internal
        view
        returns (bytes memory extra)
    {
        try resolver.resolve(DnsNameLib.encode(n), data) {
            revert("expected lookup");
        } catch (bytes memory err) {
            bytes4 cb;
            (,,, cb, extra) = abi.decode(_tail(err), (address, string[], bytes, bytes4, bytes));
            assertEq(cb, resolver.l2Callback.selector);
        }
    }

    function _expectMerkleLookup(bytes memory err) internal view {
        assertEq(bytes4(err), OffchainLookup.selector, "not a lookup");
        (address sender, string[] memory urls,, bytes4 cb,) =
            abi.decode(_tail(err), (address, string[], bytes, bytes4, bytes));
        assertEq(sender, address(resolver));
        assertEq(urls[0], "https://gw.example/ccip/{sender}/{data}.json");
        assertEq(cb, resolver.resolveCallback.selector);
    }

    function test_proofForAnotherRequestFallsBackToTheMerkleRoot() public {
        l2[lhRed].set = true;
        l2[lhRed].defaultId = crossroads;
        string memory n = "american-red-cross.org.varada.eth";
        bytes memory extra = _l2Lookup(n, abi.encodeCall(IAddrResolver.addr, (_node(n))));
        // Values proven for crossroads' request, replayed for red cross: the verifier rejects
        // them, so the resolver falls back to the Merkle root instead of trusting them.
        bytes[] memory values = new bytes[](4);
        values[0] = abi.encode(crossroads);
        for (uint256 i = 1; i < 4; ++i) {
            values[i] = abi.encode(bytes32(0));
        }
        bytes memory proof = abi.encode(keccak256(resolver.l2Request(lhCross).ops), values);
        try resolver.l2Callback(proof, extra) {
            revert("expected fallback");
        } catch (bytes memory err) {
            _expectMerkleLookup(err);
        }
    }

    function test_emptyProofFromOurLastResortGatewayFallsBackAndResolves() public {
        // Public Optimism gateways are down; our own last URL answers "0x".
        string memory n = "american-red-cross.org.varada.eth";
        bytes memory extra = _l2Lookup(n, abi.encodeCall(IAddrResolver.addr, (_node(n))));
        try resolver.l2Callback("", extra) {
            revert("expected fallback");
        } catch (bytes memory err) {
            _expectMerkleLookup(err);
            (,,,, bytes memory carry) =
                abi.decode(_tail(err), (address, string[], bytes, bytes4, bytes));
            bytes memory out = resolver.resolveCallback(
                abi.encode(merkleRoot, redCross, redCross, redCross, merkleProof[lhRed]), carry
            );
            assertEq(abi.decode(out, (address)), factory.computeOrgAddress(redCross));
        }
    }

    function test_verifierDownGoesStraightToTheMerkleRoot() public {
        vm.mockCallRevert(
            address(mockVerifier),
            abi.encodeWithSelector(IGatewayVerifier.getLatestContext.selector),
            "rollup upgraded"
        );
        string memory n = "american-red-cross.org.varada.eth";
        try resolver.resolve(DnsNameLib.encode(n), abi.encodeCall(IAddrResolver.addr, (_node(n)))) {
            revert("expected lookup");
        } catch (bytes memory err) {
            _expectMerkleLookup(err);
        }
        assertEq(_addr(n, BASE), abi.encodePacked(factory.computeOrgAddress(redCross)));
        assertEq(l2Lookups, 0);
    }

    function test_l2LookupUsesTheConfiguredGatewaysAndVerifierContext() public {
        bytes memory data = abi.encodeCall(IAddrResolver.addr, (bytes32(0)));
        try resolver.resolve(DnsNameLib.encode("american-red-cross.org.varada.eth"), data) {
            revert("expected lookup");
        } catch (bytes memory err) {
            assertEq(bytes4(err), OffchainLookup.selector);
            (address sender, string[] memory urls, bytes memory req, bytes4 cb,) =
                abi.decode(_tail(err), (address, string[], bytes, bytes4, bytes));
            assertEq(sender, address(resolver));
            assertEq(urls.length, 1);
            assertEq(urls[0], "https://optimism.gateway.unruggable.com");
            assertEq(cb, resolver.l2Callback.selector);
            (bytes memory ctx, GatewayRequest memory r) =
                abi.decode(_tail(req), (bytes, GatewayRequest));
            assertEq(ctx, mockVerifier.CONTEXT());
            assertEq(keccak256(r.ops), keccak256(resolver.l2Request(lhRed).ops));
        }
    }

    function test_slotConstantsMatchTheL2Registry() public {
        VaradaOrgNames reg = new VaradaOrgNames(owner, "");
        assertEq(resolver.L2_DEFAULT_IDS_SLOT(), reg.DEFAULT_IDS_SLOT());
        assertEq(resolver.L2_CHAIN_IDS_SLOT(), reg.CHAIN_IDS_SLOT());
        assertEq(bytes32(type(uint256).max), reg.NONE());
    }

    // ------------------------------------------------------------------ Merkle fallback

    function test_freshNameFallsBackToTheMerkleRoot() public {
        string memory n = "american-red-cross.org.varada.eth";
        bytes memory want = abi.encodePacked(factory.computeOrgAddress(redCross));
        assertEq(_addr(n, 60), want);
        assertEq(_addr(n, OP), want);
        assertEq(_addr(n, BASE), want);
        assertEq(l2Lookups, 3);
        assertEq(merkleLookups, 3);
    }

    function test_noDefaultAndNoOtherChains() public {
        string memory n = "american-red-cross.org.varada.eth";
        uint256[4] memory coins = [uint256(0x80000000), 0x80000000 | 42_161, 0x80000000 | 137, 0];
        for (uint256 i; i < 4; ++i) {
            assertEq(_addr(n, coins[i]).length, 0);
        }
    }

    function test_textRecords() public {
        string memory n = "american-red-cross.org.varada.eth";
        bytes32 node = _node(n);
        assertEq(
            abi.decode(_resolve(n, abi.encodeCall(ITextResolver.text, (node, "url"))), (string)),
            "https://varada.eth.limo/org/american-red-cross"
        );
        assertEq(
            abi.decode(
                _resolve(n, abi.encodeCall(ITextResolver.text, (node, "varada.orgId"))), (string)
            ),
            vm.toString(redCross)
        );
        assertEq(
            abi.decode(_resolve(n, abi.encodeCall(ITextResolver.text, (node, "avatar"))), (string)),
            ""
        );
    }

    function test_multicall() public {
        string memory n = "american-red-cross.org.varada.eth";
        bytes32 node = _node(n);
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(IAddressResolver.addr, (node, BASE));
        calls[1] = abi.encodeCall(ITextResolver.text, (node, "url"));
        calls[2] = abi.encodeWithSelector(bytes4(0xdeadbeef), node);
        bytes[] memory out =
            abi.decode(_resolve(n, abi.encodeWithSelector(bytes4(0xac9650d8), calls)), (bytes[]));
        assertEq(abi.decode(out[0], (bytes)), abi.encodePacked(factory.computeOrgAddress(redCross)));
        assertEq(abi.decode(out[1], (string)), "https://varada.eth.limo/org/american-red-cross");
        assertEq(out[2].length, 0);
    }

    function test_unknownLabelResolvesEmpty() public {
        string memory n = "nobody.org.varada.eth";
        assertEq(
            abi.decode(_resolve(n, abi.encodeCall(IAddrResolver.addr, (_node(n)))), (address)),
            address(0)
        );
    }

    function _carry(bytes32 lh, string memory label, bytes memory data)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(lh, bytes(label), data);
    }

    function test_merkle_rejectsAProofForAnotherOrg() public {
        bytes memory carry = _carry(lhRed, "american-red-cross", "");
        vm.expectRevert(
            abi.encodeWithSelector(
                VaradaOrgResolver.InvalidProof.selector, lhRed, crossroads, crossroads, crossroads
            )
        );
        resolver.resolveCallback(
            abi.encode(merkleRoot, crossroads, crossroads, crossroads, merkleProof[lhRed]), carry
        );
    }

    function test_merkle_perChainIdsCannotBeDropped() public {
        // Single-leaf tree holding NPR with its Base override.
        VaradaOrgResolver single = _deploy(OrgNamesTree.leaf(lhNpr, npr, npr, nprBase));
        bytes32 node = _node("national-public-radio.org.varada.eth");
        bytes32 sr = single.root();
        bytes memory carry = _carry(
            lhNpr, "national-public-radio", abi.encodeCall(IAddressResolver.addr, (node, BASE))
        );
        bytes memory out =
            single.resolveCallback(abi.encode(sr, npr, npr, nprBase, new bytes32[](0)), carry);
        assertEq(abi.decode(out, (bytes)), abi.encodePacked(factory.computeOrgAddress(nprBase)));
        vm.expectRevert(
            abi.encodeWithSelector(VaradaOrgResolver.InvalidProof.selector, lhNpr, npr, npr, npr)
        );
        single.resolveCallback(abi.encode(sr, npr, npr, npr, new bytes32[](0)), carry);
    }

    function test_merkle_rejectsUnknownRoots() public {
        bytes memory carry = _carry(lhRed, "american-red-cross", "");
        bytes32 fake = keccak256("fake");
        vm.expectRevert(abi.encodeWithSelector(VaradaOrgResolver.UnknownRoot.selector, fake));
        resolver.resolveCallback(
            abi.encode(fake, redCross, redCross, redCross, merkleProof[lhRed]), carry
        );
        vm.expectRevert(abi.encodeWithSelector(VaradaOrgResolver.UnknownRoot.selector, bytes32(0)));
        resolver.resolveCallback(
            abi.encode(bytes32(0), bytes32(0), bytes32(0), bytes32(0), new bytes32[](0)), carry
        );
    }

    function test_merkle_acceptsThePreviousRootAfterRotation() public {
        bytes32 old = merkleRoot;
        vm.prank(owner);
        resolver.setRoot(keccak256("next"));
        assertEq(resolver.previousRoot(), old);
        assertEq(
            _addr("american-red-cross.org.varada.eth", 60),
            abi.encodePacked(factory.computeOrgAddress(redCross))
        );
        vm.prank(owner);
        resolver.setRoot(keccak256("third"));
        vm.expectRevert(abi.encodeWithSelector(VaradaOrgResolver.UnknownRoot.selector, old));
        resolver.resolveCallback(
            abi.encode(old, redCross, redCross, redCross, merkleProof[lhRed]),
            _carry(lhRed, "american-red-cross", "")
        );
    }

    // ------------------------------------------------------------------ names and admin

    function test_namespaceDeeperAndForeignNamesAnswerEmptyWithoutLookup() public view {
        string[3] memory names = ["org.varada.eth", "a.b.org.varada.eth", "x.varada.eth"];
        for (uint256 i; i < 3; ++i) {
            bytes32 node = _node(names[i]);
            bytes memory r = resolver.resolve(
                DnsNameLib.encode(names[i]), abi.encodeCall(IAddrResolver.addr, (node))
            );
            assertEq(abi.decode(r, (address)), address(0));
            bytes memory c = resolver.resolve(
                DnsNameLib.encode(names[i]),
                abi.encodeCall(IContentHashResolver.contenthash, (node))
            );
            assertEq(abi.decode(c, (bytes)).length, 0);
        }
    }

    function test_unsupportedProfileReverts() public {
        bytes memory data = abi.encodeWithSelector(bytes4(0x12345678), bytes32(0));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaradaOrgResolver.UnsupportedResolverProfile.selector, bytes4(0x12345678)
            )
        );
        resolver.resolve(DnsNameLib.encode("org.varada.eth"), data);
    }

    function test_malformedNameReverts() public {
        bytes memory bad = hex"40";
        vm.expectRevert(abi.encodeWithSelector(VaradaOrgResolver.InvalidDnsName.selector, bad));
        resolver.resolve(bad, abi.encodeCall(IAddrResolver.addr, (bytes32(0))));
    }

    function test_adminIsOwnerOnly() public {
        address stranger = makeAddr("stranger");
        string[] memory urls = new string[](1);
        urls[0] = "https://evil";
        vm.startPrank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        resolver.setRoot(bytes32(uint256(1)));
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        resolver.setGateways(urls);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        resolver.setVerifier(IGatewayVerifier(address(1)), urls);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        resolver.setSiteUrlPrefix("x");
        vm.stopPrank();

        vm.startPrank(owner);
        vm.expectRevert(VaradaOrgResolver.NoGateways.selector);
        resolver.setGateways(new string[](0));
        vm.expectRevert(VaradaOrgResolver.NoGateways.selector);
        resolver.setVerifier(mockVerifier, new string[](0));
        resolver.setVerifier(IGatewayVerifier(address(7)), urls);
        vm.stopPrank();
        assertEq(address(resolver.verifier()), address(7));
        assertEq(resolver.l2Gateways()[0], "https://evil");
    }

    function test_supportsExtendedResolver() public view {
        assertTrue(resolver.supportsInterface(type(IExtendedResolver).interfaceId));
        assertTrue(resolver.supportsInterface(0x01ffc9a7));
        assertFalse(resolver.supportsInterface(0xffffffff));
    }
}
