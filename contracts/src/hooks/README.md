# Generic Uniswap v4 hooks

Feature hooks for Uniswap v4 that any LP or protocol can deploy alone or inherit together into one
hook. Solidity `^0.8.26`, EVM `cancun`, depends only on v4 core (the examples also use OpenZeppelin
`Ownable` / `SafeERC20`). MIT.

Full documentation: [`docs/hooks/README.md`](../../../docs/hooks/README.md).

```
base/         BaseHook (IHooks, merge rules, shared lock), PoolAdminHook (per pool admin)
fee/          DecayingFeeHook (decaying dynamic LP fee), SwapFeeHook (hook fee on the unspecified side)
oracle/       TwapOracleHook (per pool TWAP tick)
access/       PoolInitGateHook (who may create pools), LiquidityGateHook (who may add / remove)
conversion/   FeeConversionHook (in-swap conversion of fee claims, hold and retry)
libraries/    LinearDecay
interfaces/   ITwapOracle
examples/     one deployable hook per feature, ConvertingSwapFeeExample, LaunchpadHook,
              BondingCurveHook (reference only, not audited)
```

Use:

```solidity
import {BaseHook} from "v4-hooks/base/BaseHook.sol";
import {DecayingFeeHook} from "v4-hooks/fee/DecayingFeeHook.sol";
import {SwapFeeHook} from "v4-hooks/fee/SwapFeeHook.sol";
import {TwapOracleHook} from "v4-hooks/oracle/TwapOracleHook.sol";

contract MyPoolHook is TwapOracleHook, DecayingFeeHook, SwapFeeHook {
    address public immutable admin;
    constructor(IPoolManager m, address admin_) BaseHook(m) TwapOracleHook(5 minutes, 24) {
        admin = admin_;
    }
    // choose who administers each pool (no default; see the note below)
    function _initialPoolAdmin(address, PoolKey calldata) internal view override returns (address) {
        return admin;
    }
    // re-declare each shared internal callback with a super-only body
}
```

`PoolAdminHook._initialPoolAdmin` has no default. A pool key is public, so returning the caller
of `PoolManager.initialize` with no check lets anyone who initializes your key first become its
admin. Gate initialization with `PoolInitGateHook` (as every example does) or use a fixed admin:
[`docs/hooks/BaseHook.md`](../../../docs/hooks/BaseHook.md#front-running-the-initializer).

with the remapping `v4-hooks/=lib/varada/contracts/src/hooks/` after
`forge install camdengrieh/varada@<ref>` (needs the repository to be public), or copy this folder
into your project: it imports only itself (relative paths) and `v4-core/` (plus
`@openzeppelin/contracts/` in the examples). Mine the address with
`contracts/script/HookMiner.sol`. Install details:
[`docs/hooks/README.md#installation`](../../../docs/hooks/README.md#installation). Walkthrough:
[`docs/hooks/ComposeYourOwn.md`](../../../docs/hooks/ComposeYourOwn.md).

Build and test only this folder: `cd contracts && FOUNDRY_PROFILE=hooks forge test`.
