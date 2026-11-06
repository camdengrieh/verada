import { decodeAbiParameters, decodeFunctionData, hexToBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_BALANCE,
  DEFAULT_ENVIRONMENT,
  NATIVE_CURRENCY,
  OPEN_DELTA,
  ROUTER_ADDRESS_THIS,
  ROUTER_MSG_SENDER,
  SwapError,
  UR_COMMAND,
  USDC,
  V4_ACTION,
  WETH,
  buildSwapCalldata,
  enumerateRoutes,
  universalRouterAbi,
  type PoolState,
  type Route,
} from "../../src/index.js";
import { HOOK, TOKEN, fakePool } from "./helpers.js";

const weth = WETH.address;
const tokenPool = fakePool(TOKEN, weth, 0x800000, 200, 10n ** 18n, { hooks: HOOK });
const ethUsdc = fakePool(NATIVE_CURRENCY, USDC.address, 500, 10, 10n ** 15n);
const wethUsdc = fakePool(weth, USDC.address, 500, 10, 10n ** 14n);
const pools: PoolState[] = [tokenPool, ethUsdc, wethUsdc];

const route = (from: `0x${string}`, to: `0x${string}`, pick: (r: Route) => boolean = () => true) => enumerateRoutes(pools, from, to, { weth }).find(pick)!;
const kinds = (r: Route) => r.steps.map((s) => s.kind).join(",");

function decode(data: Hex) {
  const { args } = decodeFunctionData({ abi: universalRouterAbi, data });
  const [commands, inputs, deadline] = args as [Hex, Hex[], bigint];
  return { commands: [...hexToBytes(commands)], inputs, deadline };
}
function decodeV4(input: Hex) {
  const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], input);
  return { actions: [...hexToBytes(actions)], params: params as Hex[] };
}

const deadline = 1_900_000_000;

describe("buildSwapCalldata exact-in", () => {
  it("ERC-20 in, single hop: V4_SWAP [swap, settle all, take all] with the minimum out", () => {
    const r = route(weth, TOKEN);
    const tx = buildSwapCalldata({ route: r, mode: "exactIn", amountIn: 10n ** 18n, amountOut: 123n, deadline });
    expect(tx.to).toBe(DEFAULT_ENVIRONMENT.universalRouter);
    expect(tx.value).toBe(0n);
    const { commands, inputs, deadline: d } = decode(tx.data);
    expect(d).toBe(BigInt(deadline));
    expect(commands).toEqual([UR_COMMAND.V4_SWAP]);
    const v4 = decodeV4(inputs[0]!);
    expect(v4.actions).toEqual([V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE_ALL]);
    const [swap] = decodeAbiParameters(
      [{ type: "tuple", components: [{ name: "poolKey", type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] }, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" }] }],
      v4.params[0]!,
    );
    expect(swap.poolKey.fee).toBe(0x800000);
    expect(swap.poolKey.hooks.toLowerCase()).toBe(HOOK);
    expect(swap.amountIn).toBe(10n ** 18n);
    expect(swap.amountOutMinimum).toBe(123n);
    expect(swap.zeroForOne).toBe(weth.toLowerCase() < TOKEN.toLowerCase());
    const [settleCur, max] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], v4.params[1]!);
    expect([settleCur, max]).toEqual([weth, 10n ** 18n]);
    const [takeCur, min] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], v4.params[2]!);
    expect(takeCur.toLowerCase()).toBe(TOKEN);
    expect(min).toBe(123n);
  });

  it("native ETH into a WETH pool: WRAP_ETH to the router, then settle from the router balance", () => {
    const r = route(NATIVE_CURRENCY, TOKEN);
    expect(kinds(r)).toBe("wrap,pool");
    const tx = buildSwapCalldata({ route: r, mode: "exactIn", amountIn: 5n * 10n ** 17n, amountOut: 77n, deadline });
    expect(tx.value).toBe(5n * 10n ** 17n);
    const { commands, inputs } = decode(tx.data);
    expect(commands).toEqual([UR_COMMAND.WRAP_ETH, UR_COMMAND.V4_SWAP]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }], inputs[0]!)).toEqual([ROUTER_ADDRESS_THIS, 5n * 10n ** 17n]);
    const v4 = decodeV4(inputs[1]!);
    expect(v4.actions).toEqual([V4_ACTION.SETTLE, V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.TAKE_ALL]);
    const [cur, amount, payerIsUser] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], v4.params[0]!);
    expect([cur, amount, payerIsUser]).toEqual([weth, CONTRACT_BALANCE, false]);
  });

  it("native ETH into a hub pool settles with SETTLE_ALL and msg.value", () => {
    const r = route(NATIVE_CURRENCY, USDC.address, (x) => kinds(x) === "pool");
    const tx = buildSwapCalldata({ route: r, mode: "exactIn", amountIn: 10n ** 18n, amountOut: 1n, deadline });
    expect(tx.value).toBe(10n ** 18n);
    const v4 = decodeV4(decode(tx.data).inputs[0]!);
    expect(v4.actions).toEqual([V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE_ALL]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }], v4.params[1]!)[0]).toBe(NATIVE_CURRENCY);
  });

  it("USDC into the token: two v4 hops in one SWAP_EXACT_IN with the minimum on the last take", () => {
    const r = route(USDC.address, TOKEN, (x) => kinds(x) === "pool,pool");
    const tx = buildSwapCalldata({ route: r, mode: "exactIn", amountIn: 1_000_000n, amountOut: 55n, deadline });
    const { commands, inputs } = decode(tx.data);
    expect(commands).toEqual([UR_COMMAND.V4_SWAP]);
    const v4 = decodeV4(inputs[0]!);
    expect(v4.actions).toEqual([V4_ACTION.SWAP_EXACT_IN, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE_ALL]);
    const [multi] = decodeAbiParameters(
      [{ type: "tuple", components: [{ name: "currencyIn", type: "address" }, { name: "path", type: "tuple[]", components: [{ name: "intermediateCurrency", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }, { name: "hookData", type: "bytes" }] }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }] }],
      v4.params[0]!,
    );
    expect(multi.currencyIn).toBe(USDC.address);
    expect(multi.path).toHaveLength(2);
    expect(multi.path[0]!.intermediateCurrency).toBe(weth);
    expect(multi.path[1]!.intermediateCurrency.toLowerCase()).toBe(TOKEN);
    expect(multi.amountOutMinimum).toBe(55n);
  });

  it("USDC through ETH and a wrap: two V4_SWAP commands with the middle value kept in the router", () => {
    const r = route(USDC.address, TOKEN, (x) => kinds(x) === "pool,wrap,pool");
    const tx = buildSwapCalldata({ route: r, mode: "exactIn", amountIn: 2_000_000n, amountOut: 9n, deadline });
    const { commands, inputs } = decode(tx.data);
    expect(commands).toEqual([UR_COMMAND.V4_SWAP, UR_COMMAND.WRAP_ETH, UR_COMMAND.V4_SWAP]);
    const first = decodeV4(inputs[0]!);
    expect(first.actions).toEqual([V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE]);
    const [cur, recipient, amount] = decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], first.params[2]!);
    expect([cur, recipient, amount]).toEqual([NATIVE_CURRENCY, ROUTER_ADDRESS_THIS, OPEN_DELTA]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }], inputs[1]!)).toEqual([ROUTER_ADDRESS_THIS, CONTRACT_BALANCE]);
    expect(decodeV4(inputs[2]!).actions).toEqual([V4_ACTION.SETTLE, V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.TAKE_ALL]);
  });

  it("selling to ETH unwraps the router's WETH to the sender with the minimum", () => {
    const r = route(TOKEN, NATIVE_CURRENCY, (x) => kinds(x) === "pool,unwrap");
    const tx = buildSwapCalldata({ route: r, mode: "exactIn", amountIn: 10n ** 20n, amountOut: 31n, deadline });
    const { commands, inputs } = decode(tx.data);
    expect(commands).toEqual([UR_COMMAND.V4_SWAP, UR_COMMAND.UNWRAP_WETH]);
    const v4 = decodeV4(inputs[0]!);
    expect(v4.actions).toEqual([V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }], inputs[1]!)).toEqual([ROUTER_MSG_SENDER, 31n]);
  });

  it("a trailing wrap sweeps the WETH with the minimum", () => {
    const r = route(USDC.address, weth, (x) => kinds(x) === "pool,wrap");
    const tx = buildSwapCalldata({ route: r, mode: "exactIn", amountIn: 1_000_000n, amountOut: 5n, deadline });
    const { commands, inputs } = decode(tx.data);
    expect(commands).toEqual([UR_COMMAND.V4_SWAP, UR_COMMAND.WRAP_ETH, UR_COMMAND.SWEEP]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], inputs[2]!)).toEqual([weth, ROUTER_MSG_SENDER, 5n]);
  });

  it("prefixes a signed Permit2 permit for ERC-20 inputs but not for ETH", () => {
    const permit = { details: { token: weth, amount: 10n ** 18n, expiration: deadline, nonce: 3 }, spender: DEFAULT_ENVIRONMENT.universalRouter, sigDeadline: BigInt(deadline) };
    const signature = `0x${"ab".repeat(65)}` as Hex;
    const withPermit = buildSwapCalldata({ route: route(weth, TOKEN), mode: "exactIn", amountIn: 10n ** 18n, amountOut: 1n, deadline, permit: { permit, signature } });
    const d = decode(withPermit.data);
    expect(d.commands).toEqual([UR_COMMAND.PERMIT2_PERMIT, UR_COMMAND.V4_SWAP]);
    const [decoded, sig] = decodeAbiParameters(
      [{ type: "tuple", components: [{ name: "details", type: "tuple", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }] }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }] }, { type: "bytes" }],
      d.inputs[0]!,
    );
    expect(decoded.details.nonce).toBe(3);
    expect(decoded.spender).toBe(DEFAULT_ENVIRONMENT.universalRouter);
    expect(sig).toBe(signature);
    const eth = buildSwapCalldata({ route: route(NATIVE_CURRENCY, TOKEN), mode: "exactIn", amountIn: 1n, amountOut: 1n, deadline, permit: { permit, signature } });
    expect(decode(eth.data).commands).toEqual([UR_COMMAND.WRAP_ETH, UR_COMMAND.V4_SWAP]);
  });

  it("rejects empty routes and zero amounts", () => {
    expect(() => buildSwapCalldata({ route: { steps: [], currencyIn: weth, currencyOut: TOKEN }, mode: "exactIn", amountIn: 1n, amountOut: 1n, deadline })).toThrow(SwapError);
    expect(() => buildSwapCalldata({ route: route(weth, TOKEN), mode: "exactIn", amountIn: 0n, amountOut: 1n, deadline })).toThrow(/Enter an amount/);
  });

  it("rejects amounts above uint128", () => {
    expect(() => buildSwapCalldata({ route: route(weth, TOKEN), mode: "exactIn", amountIn: 1n << 128n, amountOut: 1n, deadline })).toThrow(RangeError);
  });
});

describe("buildSwapCalldata exact-out", () => {
  it("ERC-20 in: swap, settle up to the maximum, take the exact output", () => {
    const tx = buildSwapCalldata({ route: route(weth, TOKEN), mode: "exactOut", amountIn: 2n * 10n ** 18n, amountOut: 10n ** 21n, deadline });
    const v4 = decodeV4(decode(tx.data).inputs[0]!);
    expect(v4.actions).toEqual([V4_ACTION.SWAP_EXACT_OUT_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE_ALL]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }], v4.params[1]!)).toEqual([weth, 2n * 10n ** 18n]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }], v4.params[2]!)[1]).toBe(10n ** 21n);
  });

  it("ETH in through a wrap: wraps the maximum, settles the debt, unwraps the leftover", () => {
    const tx = buildSwapCalldata({ route: route(NATIVE_CURRENCY, TOKEN), mode: "exactOut", amountIn: 10n ** 18n, amountOut: 5n, deadline });
    expect(tx.value).toBe(10n ** 18n);
    const { commands, inputs } = decode(tx.data);
    expect(commands).toEqual([UR_COMMAND.WRAP_ETH, UR_COMMAND.V4_SWAP, UR_COMMAND.UNWRAP_WETH]);
    const v4 = decodeV4(inputs[1]!);
    expect(v4.actions).toEqual([V4_ACTION.SWAP_EXACT_OUT_SINGLE, V4_ACTION.SETTLE, V4_ACTION.TAKE_ALL]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], v4.params[1]!)).toEqual([weth, OPEN_DELTA, false]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }], inputs[2]!)).toEqual([ROUTER_MSG_SENDER, 0n]);
  });

  it("ETH in a hub pool sweeps the unused ETH back", () => {
    const tx = buildSwapCalldata({ route: route(NATIVE_CURRENCY, USDC.address, (x) => kinds(x) === "pool"), mode: "exactOut", amountIn: 10n ** 18n, amountOut: 1_000_000n, deadline });
    expect(decode(tx.data).commands).toEqual([UR_COMMAND.V4_SWAP, UR_COMMAND.SWEEP]);
  });

  it("encodes multi-hop exact-out paths with the currency paid into each pool", () => {
    const r = route(USDC.address, TOKEN, (x) => kinds(x) === "pool,pool");
    const tx = buildSwapCalldata({ route: r, mode: "exactOut", amountIn: 3_000_000n, amountOut: 10n ** 18n, deadline });
    const v4 = decodeV4(decode(tx.data).inputs[0]!);
    expect(v4.actions[0]).toBe(V4_ACTION.SWAP_EXACT_OUT);
    const [p] = decodeAbiParameters(
      [{ type: "tuple", components: [{ name: "currencyOut", type: "address" }, { name: "path", type: "tuple[]", components: [{ name: "intermediateCurrency", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }, { name: "hookData", type: "bytes" }] }, { name: "amountOut", type: "uint128" }, { name: "amountInMaximum", type: "uint128" }] }],
      v4.params[0]!,
    );
    expect(p.currencyOut.toLowerCase()).toBe(TOKEN);
    expect(p.path[0]!.intermediateCurrency).toBe(USDC.address);
    expect(p.path[1]!.intermediateCurrency).toBe(weth);
  });

  it("rejects exact-out shapes it cannot make safe", () => {
    const r = route(USDC.address, TOKEN, (x) => kinds(x) === "pool,wrap,pool");
    expect(() => buildSwapCalldata({ route: r, mode: "exactOut", amountIn: 1n, amountOut: 1n, deadline })).toThrow(expect.objectContaining({ reason: "exact-out-unsupported" }));
  });
});
