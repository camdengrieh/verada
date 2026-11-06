"use client";

import { txToast } from "@varada/ui/components/varada/tx-toast";
import { useCallback, useRef, useState } from "react";
import type { Hex, TransactionReceipt } from "viem";
import { useAccount, useConfig, useSendTransaction, useSignTypedData } from "wagmi";
import { estimateGas, waitForTransactionReceipt } from "wagmi/actions";
import { buildTradeTransaction, mapSwapError, planExecution, SwapError, type SignedPermit, type TradeQuote } from "@varada/sdk";
import { formatDisplay } from "@/lib/swap/amounts";
import { useSwapClients } from "./use-swap-clients";

export type SwapStepId = "reset" | "approve" | "permit" | "swap";
export type SwapStepStatus = "pending" | "active" | "done" | "skipped" | "error";
export interface SwapStep {
  id: SwapStepId;
  label: string;
  status: SwapStepStatus;
}
export type SwapPhase = "idle" | "planning" | "awaiting-wallet" | "confirming" | "success" | "error";

export interface UseSwapState {
  phase: SwapPhase;
  steps: SwapStep[];
  /** Hash of the swap transaction once sent. */
  hash: Hex | null;
  receipt: TransactionReceipt | null;
  error: SwapError | null;
  busy: boolean;
}

export interface ExecuteOptions {
  /** Cause named in the success toast ("Wildlife rescue"). */
  causeName?: string;
  /** Called once the swap is mined successfully (refresh balances here). */
  onSuccess?: (receipt: TransactionReceipt) => void;
}

/** A quote older than this is refused: the pools have moved. The panel re-quotes every 15 s. */
export const MAX_QUOTE_AGE_MS = 2 * 60_000;
const GAS_MARGIN_NUM = 125n;
const GAS_MARGIN_DEN = 100n;

const INITIAL: UseSwapState = { phase: "idle", steps: [], hash: null, receipt: null, error: null, busy: false };

const explorerTx = (hash: Hex) => `https://etherscan.io/tx/${hash}`;

/**
 * The swap state machine: approve (ERC-20 to Permit2, only when missing) -> sign a Permit2 permit
 * (only when Permit2 does not yet allow the router) -> estimate gas (a free simulation: reverts
 * surface as typed errors before the wallet asks) -> send the Universal Router call -> wait for the
 * receipt. Existing allowances are reused. Reads go through the account client (private RPC);
 * signing and broadcasting go through the wallet (docs/PRIVACY.md).
 */
export function useSwap() {
  const config = useConfig();
  const { address, chainId } = useAccount();
  const clients = useSwapClients();
  const { sendTransactionAsync } = useSendTransaction();
  const { signTypedDataAsync } = useSignTypedData();
  const [state, setState] = useState<UseSwapState>(INITIAL);
  const running = useRef(false);

  const patchStep = useCallback((id: SwapStepId, status: SwapStepStatus) => setState((s) => ({ ...s, steps: s.steps.map((x) => (x.id === id ? { ...x, status } : x)) })), []);

  const reset = useCallback(() => {
    if (!running.current) setState(INITIAL);
  }, []);

  const execute = useCallback(
    async (quote: TradeQuote, opts: ExecuteOptions = {}): Promise<TransactionReceipt | null> => {
      if (running.current) return null;
      running.current = true;
      let toastId: string | number | undefined;
      let active: SwapStepId | null = null;
      try {
        if (!address || !clients.accountClient) throw new SwapError("unknown", "Connect your wallet first");
        if (Date.now() - quote.quotedAt > MAX_QUOTE_AGE_MS) throw new SwapError("deadline-expired");
        if (quote.blockers.length > 0) throw new SwapError(quote.blockers[0]!, quote.compliance.blockers.find((b) => b.reason === quote.blockers[0])?.message);
        setState({ ...INITIAL, phase: "planning", busy: true });

        const plan = await planExecution(clients.accountClient, quote, { account: address, chainId: chainId ?? 1 });
        const steps: SwapStep[] = [];
        if (plan.resetTx) steps.push({ id: "reset", label: `Reset ${quote.payAsset.symbol} approval`, status: "pending" });
        if (plan.approveTx) steps.push({ id: "approve", label: `Approve ${quote.payAsset.symbol}`, status: "pending" });
        if (plan.permit) steps.push({ id: "permit", label: `Sign permit for ${quote.payAsset.symbol}`, status: "pending" });
        steps.push({ id: "swap", label: "Swap", status: "pending" });
        setState((s) => ({ ...s, steps, phase: "awaiting-wallet" }));

        const sendAndWait = async (tx: { to: `0x${string}`; data: Hex }) => {
          const hash = await sendTransactionAsync({ to: tx.to, data: tx.data });
          setState((s) => ({ ...s, phase: "confirming" }));
          const r = await waitForTransactionReceipt(config, { hash });
          setState((s) => ({ ...s, phase: "awaiting-wallet" }));
          if (r.status !== "success") throw new SwapError("unknown", "The approval transaction failed");
        };

        if (plan.resetTx) {
          active = "reset";
          patchStep("reset", "active");
          await sendAndWait(plan.resetTx);
          patchStep("reset", "done");
        }
        if (plan.approveTx) {
          active = "approve";
          patchStep("approve", "active");
          await sendAndWait(plan.approveTx);
          patchStep("approve", "done");
        }
        let signedPermit: SignedPermit | undefined;
        if (plan.permit && plan.typedData) {
          active = "permit";
          patchStep("permit", "active");
          const signature = await signTypedDataAsync({
            domain: plan.typedData.domain,
            types: plan.typedData.types,
            primaryType: plan.typedData.primaryType,
            message: plan.permit,
          });
          signedPermit = { permit: plan.permit, signature };
          patchStep("permit", "done");
        }

        active = "swap";
        patchStep("swap", "active");
        const tx = buildTradeTransaction(quote, { signedPermit });
        // Simulating first turns a doomed swap into a typed error before the wallet is opened.
        let gas: bigint;
        try {
          gas = await estimateGas(config, { account: address, to: tx.to, data: tx.data, value: tx.value });
        } catch (e) {
          throw mapSwapError(e);
        }
        gas = (gas * GAS_MARGIN_NUM) / GAS_MARGIN_DEN;
        const spend = `${formatDisplay(quote.amountIn, quote.payAsset.decimals)} ${quote.payAsset.symbol}`;
        const get = `${formatDisplay(quote.amountOut, quote.receiveAsset.decimals)} ${quote.receiveAsset.symbol}`;
        const hash = await sendTransactionAsync({ to: tx.to, data: tx.data, value: tx.value, gas });
        setState((s) => ({ ...s, hash, phase: "confirming" }));
        toastId = txToast.pending({ kind: "swap", description: `${spend} for ${get}`, explorerHref: explorerTx(hash) });

        const receipt = await waitForTransactionReceipt(config, { hash });
        if (receipt.status !== "success") throw new SwapError("unknown", "The swap transaction reverted", { detail: hash });
        patchStep("swap", "done");
        setState((s) => ({ ...s, receipt, phase: "success", busy: false }));

        const feeOnPay = quote.request.side === "buy" ? (quote.amountIn * BigInt(quote.fee.feeBps)) / 10_000n : 0n;
        const cause = (feeOnPay * BigInt(quote.fee.causeShareBps)) / 10_000n;
        txToast.success(toastId, {
          kind: "swap",
          description: `${spend} for ${get}`,
          explorerHref: explorerTx(hash),
          ...(opts.causeName && cause > 0n ? { donation: { amount: `${formatDisplay(cause, quote.payAsset.decimals)} ${quote.payAsset.symbol}`, cause: opts.causeName } } : {}),
        });
        opts.onSuccess?.(receipt);
        return receipt;
      } catch (e) {
        const err = mapSwapError(e);
        if (active) patchStep(active, "error");
        setState((s) => ({ ...s, phase: "error", error: err, busy: false }));
        // a rejected prompt is the user's choice: no toast for it
        if (err.reason !== "user-rejected" && toastId !== undefined) {
          txToast.error(toastId, { kind: "swap", description: err.message });
        } else if (err.reason !== "user-rejected") {
          txToast.error(undefined, { kind: "swap", description: err.message });
        }
        return null;
      } finally {
        running.current = false;
      }
    },
    [address, chainId, clients.accountClient, config, patchStep, sendTransactionAsync, signTypedDataAsync],
  );

  return { ...state, execute, reset };
}
