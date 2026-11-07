// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Script, console2} from "forge-std/Script.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {CauseRegistry} from "../src/CauseRegistry.sol";
import {EpochGovernor} from "../src/EpochGovernor.sol";
import {FeeConsolidator} from "../src/FeeConsolidator.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {IQuoteRegistry} from "../src/interfaces/IQuoteRegistry.sol";

/// @title ConfigureRoutes
/// @notice The owner's post-deployment configuration, driven by files: accepts ownership of every
///         owned contract, registers each quote asset with its route to USDC, seeds the price
///         reference of every route pool, and (when given) adds the fallback cause and makes it
///         the default. Dry run unless forge is given `--broadcast`.
/// @dev Run as `OWNER` (the account that will own the contracts), with a keystore or a Ledger:
///        forge script script/ConfigureRoutes.s.sol --sig "run()" --rpc-url $ETH_RPC_URL \
///          --account varada-owner [--broadcast]
///      Environment (all optional):
///        DEPLOYMENTS_DIR   directory holding `<chainid>.json` and `<chainid>-live.json`
///                          (default "deployments")
///        ROUTES_FILE       quote assets and routes (default "script/config/mainnet-routes.json")
///        FALLBACK_CAUSE_ID, FALLBACK_ORG_ID (bytes32), FALLBACK_ORG_ADDRESS, FALLBACK_METADATA_URI
///                          when all of the first three are set the cause is added and made the
///                          default cause of the epoch governor
///      Re-running is safe: an owned contract that is already accepted, an asset that is already
///      registered and a cause that already exists are skipped.
///
///      Routes file schema: `{"assets":[{"symbol","asset","kind":0|1,"route":[{"currency0",
///      "currency1","fee","tickSpacing","hooks"}]}]}` with `kind` 0 = Native (WETH and other
///      standard ERC-20s) and 1 = Ondo. Hops are Uniswap v4 pool keys, in order from the quote
///      asset to USDC (at most `QuoteRegistry.MAX_ROUTE_LENGTH`); native ETH is the zero address.
///      Uniswap v3 hops use the route format of the v3 `QuoteRegistry` once it lands on main:
///      extend `_hop` here (and nothing else) to read the extra field.
contract ConfigureRoutes is Script {
    struct Targets {
        address causeRegistry;
        address epochGovernor;
        address quoteRegistry;
        address feeConsolidator;
        address[] owned;
    }

    function run() external {
        string memory dir = vm.envOr("DEPLOYMENTS_DIR", string("deployments"));
        Targets memory t = _targets(dir);

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        console2.log("sender", sender);

        _acceptOwnerships(t.owned, sender);
        _routes(t, vm.envOr("ROUTES_FILE", string("script/config/mainnet-routes.json")));
        _fallbackCause(t);
        vm.stopBroadcast();

        console2.log(
            "MANUAL: publish the catalogue (CauseCatalog.setVersion, calldata from varada-catalog calldata)"
        );
        console2.log(
            "MANUAL: SetParentResolver.s.sol (ENS owner), curator agents, Zama fee account, site contenthash"
        );
    }

    // ------------------------------------------------------------------ steps

    function _acceptOwnerships(address[] memory owned, address sender) internal {
        for (uint256 i; i < owned.length; ++i) {
            if (Ownable2Step(owned[i]).owner() == sender) continue;
            if (Ownable2Step(owned[i]).pendingOwner() != sender) {
                console2.log("WARNING: not owner and not pending owner of", owned[i]);
                continue;
            }
            Ownable2Step(owned[i]).acceptOwnership();
        }
    }

    function _routes(Targets memory t, string memory file) internal {
        string memory json = vm.readFile(file);
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".assets[", vm.toString(n), "]"))) {
            ++n;
        }
        QuoteRegistry quotes = QuoteRegistry(t.quoteRegistry);
        FeeConsolidator cons = FeeConsolidator(payable(t.feeConsolidator));

        for (uint256 i; i < n; ++i) {
            string memory p = string.concat(".assets[", vm.toString(i), "]");
            address asset = vm.parseJsonAddress(json, string.concat(p, ".asset"));
            uint8 kind = uint8(vm.parseJsonUint(json, string.concat(p, ".kind")));
            PoolKey[] memory route = _route(json, p);
            console2.log(vm.parseJsonString(json, string.concat(p, ".symbol")), asset);
            console2.log("  hops", route.length);

            if (quotes.getQuoteAsset(asset).decimals == 0) {
                quotes.addQuoteAssetWithRoute(asset, IQuoteRegistry.Kind(kind), route);
            } else {
                console2.log("  already registered, route left as is");
            }
            // Seed after the route is stored; seeding twice only re-anchors at the current spot.
            cons.seedReferences(route);
        }
    }

    function _route(string memory json, string memory p)
        internal
        view
        returns (PoolKey[] memory r)
    {
        uint256 hops;
        while (vm.keyExistsJson(json, string.concat(p, ".route[", vm.toString(hops), "]"))) {
            ++hops;
        }
        r = new PoolKey[](hops);
        for (uint256 h; h < hops; ++h) {
            r[h] = _hop(json, string.concat(p, ".route[", vm.toString(h), "]"));
        }
    }

    function _hop(string memory json, string memory p) internal pure returns (PoolKey memory k) {
        k = PoolKey({
            currency0: Currency.wrap(vm.parseJsonAddress(json, string.concat(p, ".currency0"))),
            currency1: Currency.wrap(vm.parseJsonAddress(json, string.concat(p, ".currency1"))),
            // forge-lint: disable-next-line(unsafe-typecast)
            fee: uint24(vm.parseJsonUint(json, string.concat(p, ".fee"))),
            // forge-lint: disable-next-line(unsafe-typecast)
            tickSpacing: int24(vm.parseJsonInt(json, string.concat(p, ".tickSpacing"))),
            hooks: IHooks(vm.parseJsonAddress(json, string.concat(p, ".hooks")))
        });
    }

    function _fallbackCause(Targets memory t) internal {
        bytes32 causeId = vm.envOr("FALLBACK_CAUSE_ID", bytes32(0));
        bytes32 orgId = vm.envOr("FALLBACK_ORG_ID", bytes32(0));
        address orgAddr = vm.envOr("FALLBACK_ORG_ADDRESS", address(0));
        if (causeId == 0 || orgId == 0 || orgAddr == address(0)) {
            console2.log(
                "fallback cause not configured (FALLBACK_* unset): MANUAL, required before payouts"
            );
            return;
        }
        CauseRegistry reg = CauseRegistry(t.causeRegistry);
        if (!reg.exists(causeId)) {
            reg.addCause(causeId, orgId, orgAddr, vm.envOr("FALLBACK_METADATA_URI", string("")));
        }
        EpochGovernor gov = EpochGovernor(t.epochGovernor);
        if (gov.defaultCause() != causeId) gov.setDefaultCause(causeId);
    }

    // ------------------------------------------------------------------ inputs

    function _targets(string memory dir) internal view returns (Targets memory t) {
        string memory chain = vm.toString(block.chainid);
        string memory w = vm.readFile(string.concat(dir, "/", chain, ".json"));
        string memory l = vm.readFile(string.concat(dir, "/", chain, "-live.json"));
        t.causeRegistry = vm.parseJsonAddress(w, ".causeRegistry");
        t.epochGovernor = vm.parseJsonAddress(w, ".epochGovernor");
        t.quoteRegistry = vm.parseJsonAddress(w, ".quoteRegistry");
        t.feeConsolidator = vm.parseJsonAddress(w, ".feeConsolidator");
        t.owned = new address[](13);
        t.owned[0] = t.causeRegistry;
        t.owned[1] = vm.parseJsonAddress(w, ".causeCatalog");
        t.owned[2] = vm.parseJsonAddress(w, ".curatorRegistry");
        t.owned[3] = t.epochGovernor;
        t.owned[4] = vm.parseJsonAddress(w, ".donationDistributor");
        t.owned[5] = vm.parseJsonAddress(w, ".feeVault");
        t.owned[6] = t.quoteRegistry;
        t.owned[7] = t.feeConsolidator;
        t.owned[8] = vm.parseJsonAddress(w, ".profileRegistry");
        t.owned[9] = vm.parseJsonAddress(w, ".votingScheme");
        t.owned[10] = vm.parseJsonAddress(w, ".takeoverGovernor");
        t.owned[11] = vm.parseJsonAddress(l, ".rotationGovernor");
        t.owned[12] = vm.parseJsonAddress(l, ".liveVault");
    }
}
