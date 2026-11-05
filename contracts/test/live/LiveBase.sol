// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

import {HookMiner} from "../../script/HookMiner.sol";
import {CauseRegistry} from "../../src/CauseRegistry.sol";
import {FeeConsolidator, IConsolidatorRegistry} from "../../src/FeeConsolidator.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {LiveDonationVault} from "../../src/LiveDonationVault.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {RotationGovernor} from "../../src/RotationGovernor.sol";
import {VeradaLiveHook} from "../../src/VeradaLiveHook.sol";
import {VeradaToken} from "../../src/VeradaToken.sol";
import {ICauseRegistry} from "../../src/interfaces/ICauseRegistry.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {IFeeConsolidator} from "../../src/interfaces/IFeeConsolidator.sol";
import {IFeeVault} from "../../src/interfaces/IFeeVault.sol";
import {ILiveDonationVault} from "../../src/interfaces/ILiveDonationVault.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {IRotationGovernor, RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {ITokenProfileRegistry} from "../../src/interfaces/ITokenProfileRegistry.sol";
import {IVeradaLiveHook} from "../../src/interfaces/IVeradaLiveHook.sol";
import {IVotingScheme} from "../../src/interfaces/IVotingScheme.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {
    MockDistributor,
    MockGovernor,
    MockOndoToken,
    MockWETH
} from "../consolidator/ConsolidatorMocks.sol";
import {MockEndaomentRegistry, MockOrgFactory} from "../mocks/EndaomentMocks.sol";
import {MockProfileRegistryLite, MockVotingScheme} from "../mocks/GovernanceMocks.sol";
import {AdversarialOrg, LiveUSDC} from "./LiveMocks.sol";

/// @dev Live-donation fixture: real PoolManager and routers, real QuoteRegistry and
///      FeeConsolidator with seeded references, real CauseRegistry, RotationGovernor,
///      LiveDonationVault and a mined VeradaLiveHook. Tokens are real VeradaTokens; this test
///      contract plays the factory (configure, register, initialize). Endaoment is mocked
///      (cause A: deployed org, cause B: undeployed org, cause C: deployed org).
///      Route pools (all hookless): quote/USDC; native ETH/USDC (WETH unwraps into it);
///      quote/WETH and ondoB/quote (for a three-hop route ondoB -> quote -> WETH -> ETH -> USDC).
abstract contract LiveBase is Deployers {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint160 internal constant LIVE_FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
        | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    int24 internal constant TOKEN_TICK = 69_060; // 0.001 quote per token
    int24 internal constant QUOTE_TICK = 230_280; // ~100 USDC per quote (raw units)
    int24 internal constant ETH_TICK = 196_260; // ~3000 USDC per ETH (raw units)
    int24 internal constant QUOTE_WETH_TICK = 34_020; // ~1/30 WETH per quote
    int24 internal constant ONDOB_TICK = 6960; // ~0.5 quote per ondoB
    uint256 internal constant MAX_SLIPPAGE_BPS = 300;
    uint256 internal constant MAX_DEVIATION_TICKS = 1000;
    uint24 internal constant BASE_BPS = 300;

    LiveUSDC internal usdc;
    MockOndoToken internal quote;
    MockOndoToken internal ondoB;
    MockWETH internal weth;

    QuoteRegistry internal registry;
    FeeVault internal feeVault;
    FeeConsolidator internal cons;
    MockEndaomentRegistry internal endRegistry;
    MockOrgFactory internal endFactory;
    CauseRegistry internal causes;
    MockVotingScheme internal scheme;
    MockProfileRegistryLite internal profiles;
    RotationGovernor internal rgov;
    LiveDonationVault internal vault;
    VeradaLiveHook internal hook;

    PoolKey internal quoteUsdcKey;
    PoolKey internal ethUsdcKey;
    PoolKey internal quoteWethKey;
    PoolKey internal ondoBQuoteKey;

    bytes32 internal constant CAUSE_A = keccak256("cause-a");
    bytes32 internal constant CAUSE_B = keccak256("cause-b");
    bytes32 internal constant CAUSE_C = keccak256("cause-c");
    bytes32 internal constant ORG_A = bytes32("200049703");
    bytes32 internal constant ORG_B = bytes32("873024488");
    bytes32 internal constant ORG_C = bytes32("131788491");
    address internal orgA;
    address internal orgB;
    address internal orgC;

    address internal treasury = makeAddr("platformTreasury");
    address internal endTreasury = makeAddr("endaomentTreasury");
    address internal trader = makeAddr("trader");
    address internal creator = makeAddr("creator");

    function _defaultParams() internal pure returns (IRotationGovernor.Params memory) {
        return IRotationGovernor.Params({
            votingPeriod: 24 hours,
            executionWindow: 3 days,
            cooldown: 7 days,
            quorumBps: 1000,
            proposalThresholdBps: 50
        });
    }

    function _liveSetUp() internal {
        vm.warp(1_700_000_000);
        deployFreshManagerAndRouters();
        vm.deal(address(this), 1e27);

        usdc = new LiveUSDC();
        quote = new MockOndoToken("AAPLon");
        ondoB = new MockOndoToken("TSLAon");
        weth = new MockWETH();

        registry = new QuoteRegistry(address(this), address(usdc), address(weth));
        feeVault = new FeeVault(
            address(this),
            address(this),
            treasury,
            IEpochGovernor(address(new MockGovernor())),
            address(new MockDistributor()),
            address(usdc)
        );
        cons = new FeeConsolidator(
            address(this),
            manager,
            IConsolidatorRegistry(address(registry)),
            IFeeVault(address(feeVault)),
            address(weth),
            MAX_SLIPPAGE_BPS,
            MAX_DEVIATION_TICKS
        );
        feeVault.setConsolidator(address(cons));

        endRegistry = new MockEndaomentRegistry(address(usdc), endTreasury);
        endFactory = new MockOrgFactory(endRegistry);
        causes = new CauseRegistry(address(this), IEndaomentOrgFundFactory(address(endFactory)));
        orgA = endFactory.computeOrgAddress(ORG_A);
        orgB = endFactory.computeOrgAddress(ORG_B);
        orgC = endFactory.computeOrgAddress(ORG_C);
        endFactory.deployOrg(ORG_A);
        endFactory.deployOrg(ORG_C);
        causes.addCause(CAUSE_A, ORG_A, orgA, "ipfs://a");
        causes.addCause(CAUSE_B, ORG_B, orgB, "ipfs://b");
        causes.addCause(CAUSE_C, ORG_C, orgC, "ipfs://c");

        scheme = new MockVotingScheme();
        profiles = new MockProfileRegistryLite();
        rgov = new RotationGovernor(
            address(this),
            ICauseRegistry(address(causes)),
            ITokenProfileRegistry(address(profiles)),
            address(manager),
            IVotingScheme(address(scheme)),
            _defaultParams()
        );
        scheme.setGovernor(address(rgov), true);
        bytes32[] memory list = new bytes32[](3);
        list[0] = CAUSE_A;
        list[1] = CAUSE_B;
        list[2] = CAUSE_C;
        rgov.setDefaultShortlist(list);

        vault = new LiveDonationVault(
            address(this),
            address(this),
            treasury,
            ICauseRegistry(address(causes)),
            IEndaomentOrgFundFactory(address(endFactory)),
            IRotationGovernor(address(rgov)),
            manager,
            IFeeConsolidator(address(cons))
        );
        rgov.setVault(address(vault));

        hook = _deployHook(address(this));
        vault.setHook(address(hook));
        cons.setSource(address(hook), true);

        _setupRoutePools();
    }

    function _deployHook(address factory_) internal returns (VeradaLiveHook h) {
        bytes memory args = abi.encode(manager, factory_, cons, rgov, vault);
        (, bytes32 salt) =
            HookMiner.find(address(this), LIVE_FLAGS, type(VeradaLiveHook).creationCode, args);
        h = new VeradaLiveHook{salt: salt}(
            manager,
            factory_,
            IFeeConsolidator(address(cons)),
            IRotationGovernor(address(rgov)),
            ILiveDonationVault(address(vault))
        );
    }

    function _setupRoutePools() internal {
        quote.mint(address(this), 1e30);
        ondoB.mint(address(this), 1e30);
        usdc.mint(address(this), 1e30);
        weth.deposit{value: 1e26}();
        _approveRouters(address(quote));
        _approveRouters(address(ondoB));
        _approveRouters(address(usdc));
        _approveRouters(address(weth));

        quoteUsdcKey = _hooklessPool(address(quote), address(usdc), QUOTE_TICK, 3000, 2e19);
        ethUsdcKey = _hooklessPool(address(0), address(usdc), ETH_TICK, 500, 1e18);
        quoteWethKey = _hooklessPool(address(quote), address(weth), QUOTE_WETH_TICK, 3000, 1e22);
        ondoBQuoteKey = _hooklessPool(address(ondoB), address(quote), ONDOB_TICK, 3000, 1e22);

        PoolKey[] memory r1 = new PoolKey[](1);
        r1[0] = quoteUsdcKey;
        registry.addQuoteAssetWithRoute(address(quote), IQuoteRegistry.Kind.Ondo, r1);
        PoolKey[] memory r2 = new PoolKey[](1);
        r2[0] = ethUsdcKey;
        registry.addQuoteAssetWithRoute(address(weth), IQuoteRegistry.Kind.Native, r2);
        PoolKey[] memory r3 = new PoolKey[](3);
        r3[0] = ondoBQuoteKey;
        r3[1] = quoteWethKey;
        r3[2] = ethUsdcKey;
        registry.addQuoteAssetWithRoute(address(ondoB), IQuoteRegistry.Kind.Ondo, r3);

        PoolKey[] memory all = new PoolKey[](4);
        all[0] = quoteUsdcKey;
        all[1] = ethUsdcKey;
        all[2] = quoteWethKey;
        all[3] = ondoBQuoteKey;
        cons.seedReferences(all);
    }

    function _approveRouters(address asset) internal {
        IERC20(asset).approve(address(modifyLiquidityRouter), type(uint256).max);
        IERC20(asset).approve(address(swapRouter), type(uint256).max);
    }

    function _hooklessPool(address a, address b, int24 absTick, uint24 fee, int256 liquidity)
        internal
        returns (PoolKey memory key)
    {
        (Currency c0, Currency c1) = _sorted(a, b);
        key = PoolKey(c0, c1, fee, 60, IHooks(address(0)));
        int24 tick = _orientedTick(a, b, absTick);
        manager.initialize(key, TickMath.getSqrtPriceAtTick(tick));
        _addLiquidity(key, tick, liquidity);
    }

    /// @dev Launches a live token quoted in `quoteAsset` (this contract is the factory).
    function _launch(
        address quoteAsset,
        uint96 threshold,
        RotationPeriod period,
        uint24 surchargeStart,
        uint32 surchargeDecay
    ) internal returns (VeradaToken token, PoolKey memory key) {
        return _launchFull(quoteAsset, threshold, period, surchargeStart, surchargeDecay, CAUSE_A);
    }

    function _launchFull(
        address quoteAsset,
        uint96 threshold,
        RotationPeriod period,
        uint24 surchargeStart,
        uint32 surchargeDecay,
        bytes32 initialCause
    ) internal returns (VeradaToken token, PoolKey memory key) {
        token = new VeradaToken("Live", "LIVE", "ipfs://live", creator, address(this));
        hook.configureToken(
            address(token),
            IVeradaLiveHook.LiveFeeConfig(BASE_BPS, surchargeStart, surchargeDecay, 0)
        );
        vault.registerToken(address(token), threshold, initialCause, period);
        (Currency c0, Currency c1) = _sorted(address(token), quoteAsset);
        key = PoolKey(c0, c1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        int24 tick = _orientedTick(address(token), quoteAsset, TOKEN_TICK);
        manager.initialize(key, TickMath.getSqrtPriceAtTick(tick));
        _approveRouters(address(token));
        _addLiquidity(key, tick, 1e24);
        profiles.register(address(token), creator);
    }

    function _launchDefault(address quoteAsset, uint96 threshold)
        internal
        returns (VeradaToken token, PoolKey memory key)
    {
        return _launch(quoteAsset, threshold, RotationPeriod.OneHour, 0, 0);
    }

    function _fundTrader(address who, VeradaToken token) internal {
        quote.mint(who, 1e27);
        ondoB.mint(who, 1e27);
        vm.deal(who, 1e24);
        vm.startPrank(who);
        weth.deposit{value: 1e23}();
        quote.approve(address(swapRouter), type(uint256).max);
        ondoB.approve(address(swapRouter), type(uint256).max);
        weth.approve(address(swapRouter), type(uint256).max);
        token.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
        token.transfer(who, 1e27);
    }

    // ------------------------------------------------------------------ swaps

    function _quoteIs0(PoolKey memory key, address token) internal pure returns (bool) {
        return Currency.unwrap(key.currency0) != token;
    }

    function _swapAs(address who, PoolKey memory key, bool zeroForOne, int256 amountSpecified)
        internal
        returns (BalanceDelta delta)
    {
        vm.prank(who);
        delta = swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    /// @dev Exact-in buy: `quoteIn` of the quote for the token.
    function _buyExactIn(PoolKey memory key, address token, uint256 quoteIn)
        internal
        returns (BalanceDelta)
    {
        return _swapAs(trader, key, _quoteIs0(key, token), -int256(quoteIn));
    }

    /// @dev Exact-out buy: `tokenOut` of the token for the quote.
    function _buyExactOut(PoolKey memory key, address token, uint256 tokenOut)
        internal
        returns (BalanceDelta)
    {
        return _swapAs(trader, key, _quoteIs0(key, token), int256(tokenOut));
    }

    /// @dev Exact-in sell: `tokenIn` of the token for the quote.
    function _sellExactIn(PoolKey memory key, address token, uint256 tokenIn)
        internal
        returns (BalanceDelta)
    {
        return _swapAs(trader, key, !_quoteIs0(key, token), -int256(tokenIn));
    }

    /// @dev Exact-out sell: `quoteOut` of the quote for the token.
    function _sellExactOut(PoolKey memory key, address token, uint256 quoteOut)
        internal
        returns (BalanceDelta)
    {
        return _swapAs(trader, key, !_quoteIs0(key, token), int256(quoteOut));
    }

    // ------------------------------------------------------------------ helpers

    function _sorted(address a, address b) internal pure returns (Currency c0, Currency c1) {
        (c0, c1) =
            a < b ? (Currency.wrap(a), Currency.wrap(b)) : (Currency.wrap(b), Currency.wrap(a));
    }

    function _orientedTick(address base, address priceCurrency, int24 absTick)
        internal
        pure
        returns (int24)
    {
        return base < priceCurrency ? -absTick : absTick;
    }

    function _addLiquidity(PoolKey memory key, int24 tick, int256 liquidity) internal {
        uint256 value = Currency.unwrap(key.currency0) == address(0) ? 1e25 : 0;
        modifyLiquidityRouter.modifyLiquidity{value: value}(
            key,
            ModifyLiquidityParams({
                tickLower: tick - 6000, tickUpper: tick + 6000, liquidityDelta: liquidity, salt: 0
            }),
            ZERO_BYTES
        );
    }

    function _spotTick(PoolKey memory key) internal view returns (int24 tick) {
        (, tick,,) = manager.getSlot0(key.toId());
    }

    function _claims(address owner, address currency) internal view returns (uint256) {
        return manager.balanceOf(owner, Currency.wrap(currency).toId());
    }

    /// @dev Turns `org` into an AdversarialOrg (keeps its MockOrg storage).
    function _makeAdversarial(address org) internal returns (AdversarialOrg) {
        vm.etch(org, address(new AdversarialOrg()).code);
        return AdversarialOrg(org);
    }

    /// @dev Decodes the last `FeeTaken` event in `logs`.
    function _lastFeeTaken(Vm.Log[] memory logs)
        internal
        pure
        returns (
            bool found,
            bytes32 causeId,
            uint64 rotation,
            uint256 quoteAmount,
            uint256 usdcOut,
            bool converted,
            bytes4 failure
        )
    {
        bytes32 topic0 = IVeradaLiveHook.FeeTaken.selector;
        for (uint256 i = logs.length; i > 0; --i) {
            Vm.Log memory l = logs[i - 1];
            if (l.topics.length != 0 && l.topics[0] == topic0) {
                causeId = l.topics[2];
                rotation = uint64(uint256(l.topics[3]));
                (, quoteAmount, usdcOut, converted, failure) =
                    abi.decode(l.data, (address, uint256, uint256, bool, bytes4));
                return (true, causeId, rotation, quoteAmount, usdcOut, converted, failure);
            }
        }
    }

    /// @dev Number of logs with `topic0` in `logs`.
    function _count(Vm.Log[] memory logs, bytes32 topic0) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length != 0 && logs[i].topics[0] == topic0) ++n;
        }
    }
}
