// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IEndaomentOrgFundFactory} from "./interfaces/external/IEndaomentOrgFundFactory.sol";
import {
    IAddrResolver,
    IAddressResolver,
    IContentHashResolver,
    IExtendedResolver,
    ITextResolver
} from "./interfaces/external/ens/IEnsResolverProfiles.sol";
import {OffchainLookup} from "./vendor/unruggable/GatewayFetchTarget.sol";
import {GatewayFetcher} from "./vendor/unruggable/GatewayFetcher.sol";
import {GatewayRequest} from "./vendor/unruggable/GatewayRequest.sol";
import {IGatewayProtocol} from "./vendor/unruggable/IGatewayProtocol.sol";
import {IGatewayVerifier} from "./vendor/unruggable/IGatewayVerifier.sol";

/// @title VaradaOrgResolver
/// @notice ENSIP-10 wildcard resolver for `<label>.org.varada.eth`, one name per Endaoment org
///         in the Varada cause catalogue. A name resolves to the org's Endaoment entity on
///         Ethereum, Optimism and Base.
/// @dev Endaoment's OrgFundFactory and org implementation have the same addresses on all three
///      chains, so `computeOrgAddress(orgId)` gives the same CREATE2 address everywhere. An org's
///      entity can still sit under a different org id on one chain (NPR on Base was created as
///      "52-0907625", not "520907625"), so the tree records one org id per chain, and each
///      chain's address is computed from its own id with the factory on this chain.
///
///      Resolution is hybrid. The names are ERC-721 tokens in `VaradaOrgNames` on Optimism
///      (`l2Registry`), and the source of truth is that registry's records, read with Unruggable
///      storage proofs (EIP-3668) checked by `verifier` against finalized Optimism state on this
///      chain. Optimism state is only final here about 7 days after it is written. A name minted
///      more recently reads as empty, and the resolver then falls back to the catalogue's Merkle
///      root (below). Both sources come from the same label ledger, so they agree on which org
///      a label belongs to, and the finalized Optimism record wins once it exists.
///
///      The Optimism read never blocks resolution. If the verifier cannot give a context, or the
///      response does not verify (for example the last URL in `l2Gateways`, our own gateway,
///      answers `0x` whenever the public proof gateways are down), the resolver falls back to the
///      Merkle root too. Forcing the fallback gains an attacker nothing: it is still checked
///      against the on-chain root.
///
///      Merkle fallback: the label-to-org mapping is also published off-chain in a Merkle tree (OpenZeppelin standard tree,
///      leaf `(bytes32 labelhash, bytes32 orgIdEth, bytes32 orgIdOptimism, bytes32 orgIdBase)`),
///      and the owner publishes its root here. `resolve` reverts with an EIP-3668
///      `OffchainLookup`. The gateway answers with the root, the three ids and a proof, and
///      `resolveCallback` checks the proof against the current or previous root before computing
///      the addresses. A dishonest gateway therefore cannot map a name to another address. It can only
///      refuse to answer, or claim the label is unknown, which resolves to empty records.
///
///      Coin types: ETH (60), Optimism (0x80000000 | 10) and Base (0x80000000 | 8453). There is
///      deliberately no ENSIP-19 default (0x80000000) and no other EVM chain. On a chain without
///      Endaoment's factory nobody can deploy the org's address, so funds sent there would be
///      stuck.
///
///      In ENSv2 this resolver sits on the `org` entry of the `varada.eth` subregistry. Labels
///      registered as tokens in the `org` subregistry (claimed names) keep this resolver unless
///      their owner sets another one. Every other label falls through to the wildcard.
contract VaradaOrgResolver is IExtendedResolver, IERC165, Ownable2Step {
    using GatewayFetcher for GatewayRequest;

    uint256 public constant COIN_TYPE_ETH = 60;
    uint256 public constant COIN_TYPE_OPTIMISM = 0x80000000 | 10;
    uint256 public constant COIN_TYPE_BASE = 0x80000000 | 8453;
    /// @notice Text key answered with the org's 32-byte Endaoment org id (hex).
    string public constant ORG_ID_TEXT_KEY = "varada.orgId";

    /// @notice Endaoment OrgFundFactory on this chain (mainnet: 0x10fD…A589).
    IEndaomentOrgFundFactory public immutable factory;

    /// @notice `VaradaOrgNames` on Optimism.
    address public immutable l2Registry;
    /// @notice Unruggable verifier for Optimism (mainnet: 0x7f49…604c, the one ENS's Optimism
    ///         reverse resolver uses). Owner-settable because rollup upgrades retire verifiers.
    IGatewayVerifier public verifier;
    string[] internal _l2Urls;

    /// @dev Must equal `VaradaOrgNames.DEFAULT_IDS_SLOT` / `CHAIN_IDS_SLOT` / `NONE`.
    bytes32 public constant L2_DEFAULT_IDS_SLOT = keccak256("varada.orgnames.defaultOrgId");
    bytes32 public constant L2_CHAIN_IDS_SLOT = keccak256("varada.orgnames.chainOrgId");
    bytes32 internal constant L2_NONE = bytes32(type(uint256).max);

    /// @notice Current names root and the one before it. A proof against either is accepted, so
    ///         resolution keeps working while gateways switch to a new build.
    bytes32 public root;
    bytes32 public previousRoot;

    string[] internal _urls;
    /// @notice Prefix of the `url` text record; the label is appended.
    string public siteUrlPrefix;

    bytes32 internal immutable _namespaceDnsHash;
    uint256 internal immutable _namespaceDnsLength;

    /// @dev Same name and signature the ENS Universal Resolver passes through to clients.
    error UnsupportedResolverProfile(bytes4 selector);
    error InvalidDnsName(bytes name);
    error UnknownRoot(bytes32 root);
    error InvalidProof(bytes32 labelhash, bytes32 idEth, bytes32 idOp, bytes32 idBase);

    /// @dev Per-chain org ids and their addresses, indexed Ethereum, Optimism, Base.
    struct Org {
        bool exists;
        bytes32[3] ids;
        address[3] addrs;
    }
    error NoGateways();

    event VerifierUpdated(address verifier, string[] urls);
    event RootUpdated(bytes32 indexed root, bytes32 indexed previousRoot);
    event GatewaysUpdated(string[] urls);
    event SiteUrlPrefixUpdated(string prefix);

    /// @param factory_ Endaoment OrgFundFactory.
    /// @param namespaceDnsName DNS wire format of the namespace, `\x03org\x06varada\x03eth\x00`.
    /// @param l2Registry_ `VaradaOrgNames` on Optimism.
    /// @param verifier_ Unruggable Optimism verifier on this chain.
    /// @param l2Urls Unruggable Optimism gateway URLs (the verifier's own list may be empty).
    constructor(
        address owner_,
        IEndaomentOrgFundFactory factory_,
        bytes memory namespaceDnsName,
        bytes32 root_,
        string[] memory urls_,
        string memory siteUrlPrefix_,
        address l2Registry_,
        IGatewayVerifier verifier_,
        string[] memory l2Urls
    ) Ownable(owner_) {
        factory = factory_;
        l2Registry = l2Registry_;
        _setVerifier(verifier_, l2Urls);
        _namespaceDnsHash = keccak256(namespaceDnsName);
        _namespaceDnsLength = namespaceDnsName.length;
        root = root_;
        emit RootUpdated(root_, bytes32(0));
        _setGateways(urls_);
        siteUrlPrefix = siteUrlPrefix_;
        emit SiteUrlPrefixUpdated(siteUrlPrefix_);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Publishes a new names root; the current one becomes `previousRoot`.
    function setRoot(bytes32 newRoot) external onlyOwner {
        bytes32 old = root;
        previousRoot = old;
        root = newRoot;
        emit RootUpdated(newRoot, old);
    }

    function setGateways(string[] calldata urls_) external onlyOwner {
        _setGateways(urls_);
    }

    function setSiteUrlPrefix(string calldata prefix) external onlyOwner {
        siteUrlPrefix = prefix;
        emit SiteUrlPrefixUpdated(prefix);
    }

    function setVerifier(IGatewayVerifier verifier_, string[] calldata l2Urls) external onlyOwner {
        _setVerifier(verifier_, l2Urls);
    }

    function gateways() external view returns (string[] memory) {
        return _urls;
    }

    function l2Gateways() external view returns (string[] memory) {
        return _l2Urls;
    }

    // ------------------------------------------------------------------ ENSIP-10 / EIP-3668

    /// @inheritdoc IExtendedResolver
    /// @dev The namespace itself and names outside it answer empty records directly. A child
    ///      `<label>.<namespace>` first reads its Optimism record through the verifier.
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        returns (bytes memory)
    {
        (bool isChild, bytes calldata label) = _parse(name);
        if (!isChild) {
            Org memory none;
            return _answer(none, "", data);
        }
        bytes32 labelhash = keccak256(label);
        bytes memory carry = abi.encode(labelhash, label, data);
        bytes memory context;
        try verifier.getLatestContext() returns (bytes memory c) {
            context = c;
        } catch {
            _merkleLookup(labelhash, carry);
        }
        revert OffchainLookup(
            address(this),
            _l2Urls,
            abi.encodeCall(IGatewayProtocol.proveRequest, (context, l2Request(labelhash))),
            this.l2Callback.selector,
            abi.encode(context, carry)
        );
    }

    /// @notice Unruggable request for the name's records on Optimism: output 0 is the default
    ///         org id, outputs 1-3 the overrides for chains 1, 10 and 8453.
    function l2Request(bytes32 labelhash) public view returns (GatewayRequest memory req) {
        req = GatewayFetcher.newRequest(4);
        req.setTarget(l2Registry);
        req.setSlot(uint256(L2_DEFAULT_IDS_SLOT)).push(labelhash).follow().read().setOutput(0);
        uint256[3] memory chains = [uint256(1), 10, 8453];
        for (uint256 i; i < 3; ++i) {
            req.setSlot(uint256(L2_CHAIN_IDS_SLOT)).push(labelhash).follow().push(chains[i])
                .follow().read().setOutput(uint8(i + 1));
        }
    }

    /// @notice EIP-3668 callback for the Optimism read. `response` is the gateway's proof. The
    ///         verifier checks it, and a name without a finalized Optimism record, or a response
    ///         that does not verify, falls back to the Merkle gateway.
    function l2Callback(bytes calldata response, bytes calldata extraData)
        external
        view
        returns (bytes memory)
    {
        (bytes memory context, bytes memory carry) = abi.decode(extraData, (bytes, bytes));
        (bytes32 labelhash, bytes memory label, bytes memory data) =
            abi.decode(carry, (bytes32, bytes, bytes));
        bytes[] memory values;
        try verifier.getStorageValues(context, l2Request(labelhash), response) returns (
            bytes[] memory v, uint8
        ) {
            values = v;
        } catch {
            _merkleLookup(labelhash, carry);
        }
        bytes32 d = bytes32(values[0]);
        if (d == bytes32(0)) _merkleLookup(labelhash, carry);
        Org memory org;
        org.exists = true;
        for (uint256 i; i < 3; ++i) {
            bytes32 o = bytes32(values[i + 1]);
            bytes32 id = o == bytes32(0) ? d : (o == L2_NONE ? bytes32(0) : o);
            org.ids[i] = id;
            if (id != bytes32(0)) org.addrs[i] = factory.computeOrgAddress(id);
        }
        return _answer(org, label, data);
    }

    function _merkleLookup(bytes32 labelhash, bytes memory carry) internal view {
        revert OffchainLookup(
            address(this), _urls, abi.encode(labelhash), this.resolveCallback.selector, carry
        );
    }

    /// @notice EIP-3668 callback. `response` is `abi.encode(bytes32 root, bytes32 orgIdEth,
    ///         bytes32 orgIdOptimism, bytes32 orgIdBase, bytes32[] proof)`. A zero org id means
    ///         no record on that chain; all three zero means the gateway does not know the label.
    function resolveCallback(bytes calldata response, bytes calldata extraData)
        external
        view
        returns (bytes memory)
    {
        (bytes32 labelhash, bytes memory label, bytes memory data) =
            abi.decode(extraData, (bytes32, bytes, bytes));
        (bytes32 r, bytes32 idEth, bytes32 idOp, bytes32 idBase, bytes32[] memory proof) =
            abi.decode(response, (bytes32, bytes32, bytes32, bytes32, bytes32[]));
        if (r == bytes32(0) || (r != root && r != previousRoot)) revert UnknownRoot(r);
        Org memory org;
        if (idEth != bytes32(0) || idOp != bytes32(0) || idBase != bytes32(0)) {
            if (!verifyName(r, labelhash, idEth, idOp, idBase, proof)) {
                revert InvalidProof(labelhash, idEth, idOp, idBase);
            }
            org.ids = [idEth, idOp, idBase];
            for (uint256 i; i < 3; ++i) {
                if (org.ids[i] != bytes32(0)) org.addrs[i] = factory.computeOrgAddress(org.ids[i]);
            }
            org.exists = true;
        }
        return _answer(org, label, data);
    }

    /// @notice Whether `proof` places `(labelhash, idEth, idOp, idBase)` under `root_`.
    function verifyName(
        bytes32 root_,
        bytes32 labelhash,
        bytes32 idEth,
        bytes32 idOp,
        bytes32 idBase,
        bytes32[] memory proof
    ) public pure returns (bool) {
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(labelhash, idEth, idOp, idBase)))
        );
        return MerkleProof.verify(proof, root_, leaf);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId
            || interfaceId == type(IExtendedResolver).interfaceId;
    }

    // ------------------------------------------------------------------ internals

    /// @dev `isChild` when the name is exactly `<label>.<namespace>`. Deeper names, the namespace
    ///      itself and other parents are not children. Malformed first labels revert.
    function _parse(bytes calldata name)
        internal
        view
        returns (bool isChild, bytes calldata label)
    {
        if (name.length == 0) {
            revert InvalidDnsName(name);
        }
        if (name.length == _namespaceDnsLength && keccak256(name) == _namespaceDnsHash) {
            return (false, name[0:0]);
        }
        uint256 len = uint8(name[0]);
        if (len == 0 || len > 63 || 1 + len >= name.length) revert InvalidDnsName(name);
        bytes calldata suffix = name[1 + len:];
        if (suffix.length != _namespaceDnsLength || keccak256(suffix) != _namespaceDnsHash) {
            return (false, name[0:0]);
        }
        return (true, name[1:1 + len]);
    }

    function _answer(Org memory org, bytes memory label, bytes memory data)
        internal
        view
        returns (bytes memory)
    {
        bytes4 selector = _selector(data);
        if (selector == IAddrResolver.addr.selector) return abi.encode(org.addrs[0]);
        if (selector == IAddressResolver.addr.selector) {
            (, uint256 coinType) = abi.decode(_args(data), (bytes32, uint256));
            return abi.encode(_coinAddress(org, coinType));
        }
        if (selector == ITextResolver.text.selector) {
            (, string memory key) = abi.decode(_args(data), (bytes32, string));
            return abi.encode(_text(org, label, key));
        }
        if (selector == IContentHashResolver.contenthash.selector) return abi.encode(bytes(""));
        if (selector == _MULTICALL) {
            bytes[] memory calls = abi.decode(_args(data), (bytes[]));
            bytes[] memory results = new bytes[](calls.length);
            for (uint256 i; i < calls.length; ++i) {
                bytes4 s = _selector(calls[i]);
                if (
                    s == IAddrResolver.addr.selector || s == IAddressResolver.addr.selector
                        || s == ITextResolver.text.selector
                        || s == IContentHashResolver.contenthash.selector
                ) results[i] = _answer(org, label, calls[i]);
            }
            return abi.encode(results);
        }
        revert UnsupportedResolverProfile(selector);
    }

    /// @dev `multicall(bytes[])`.
    bytes4 internal constant _MULTICALL = 0xac9650d8;

    function _coinAddress(Org memory org, uint256 coinType) internal pure returns (bytes memory) {
        address a;
        if (coinType == COIN_TYPE_ETH) a = org.addrs[0];
        else if (coinType == COIN_TYPE_OPTIMISM) a = org.addrs[1];
        else if (coinType == COIN_TYPE_BASE) a = org.addrs[2];
        return a == address(0) ? bytes("") : abi.encodePacked(a);
    }

    /// @dev `varada.orgId` is the Ethereum org id, or the first per-chain id when it has none.
    function _text(Org memory org, bytes memory label, string memory key)
        internal
        view
        returns (string memory)
    {
        if (!org.exists) return "";
        bytes32 k = keccak256(bytes(key));
        if (k == keccak256("url")) return string.concat(siteUrlPrefix, string(label));
        if (k == keccak256(bytes(ORG_ID_TEXT_KEY))) {
            for (uint256 i; i < 3; ++i) {
                if (org.ids[i] != bytes32(0)) return _hex32(org.ids[i]);
            }
        }
        return "";
    }

    function _setVerifier(IGatewayVerifier verifier_, string[] memory l2Urls) internal {
        if (l2Urls.length == 0) revert NoGateways();
        verifier = verifier_;
        delete _l2Urls;
        for (uint256 i; i < l2Urls.length; ++i) {
            _l2Urls.push(l2Urls[i]);
        }
        emit VerifierUpdated(address(verifier_), l2Urls);
    }

    function _setGateways(string[] memory urls_) internal {
        if (urls_.length == 0) revert NoGateways();
        delete _urls;
        for (uint256 i; i < urls_.length; ++i) {
            _urls.push(urls_[i]);
        }
        emit GatewaysUpdated(urls_);
    }

    function _selector(bytes memory data) internal pure returns (bytes4 s) {
        if (data.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            s := mload(add(data, 32))
        }
    }

    function _args(bytes memory data) internal pure returns (bytes memory args) {
        uint256 n = data.length - 4;
        args = new bytes(n);
        assembly ("memory-safe") {
            mcopy(add(args, 32), add(data, 36), n)
        }
    }

    function _hex32(bytes32 word) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(66);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i; i < 32; ++i) {
            out[2 + i * 2] = alphabet[uint8(word[i]) >> 4];
            out[3 + i * 2] = alphabet[uint8(word[i]) & 0x0f];
        }
        return string(out);
    }
}
