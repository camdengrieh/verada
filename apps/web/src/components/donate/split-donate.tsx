"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { agentVaultAbi, curatorRegistryAbi } from "@varada/sdk/abis";
import { Stepper, type StepperStep } from "@varada/ui/components/data/stepper";
import { Button } from "@varada/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@varada/ui/components/ui/dialog";
import { HandHeart } from "@varada/ui/components/ui/icons";
import { usdcText } from "@/components/agent-common";
import { useWalletGate } from "@/components/governance/use-wallet-gate";
import { useAppConfig, useDeps, usePrivateRpc } from "@/components/providers";
import { errorText, sameAddress, TxStatus, useTx } from "@/components/use-tx";
import { createAccountClient } from "@/lib/account-reads";
import { allowanceRequest, approveRequest, donateRequest, needsApproval, usdcAddress, usdcBalanceRequest } from "@/lib/vault";

/** One cause of the gift: its agent's category bit, the vault the indexer lists, and its share. */
export interface SplitTarget {
  categoryBit: number;
  vault: string;
  /** Cause name, e.g. "Hunger & famine". */
  name: string;
  amount: bigint;
}

interface Checked extends SplitTarget {
  /** The vault the registry confirmed (and the indexer agrees with). */
  address: Address;
}

interface Step {
  kind: "approve" | "donate";
  target: Checked;
}

interface Blocker {
  text: string;
  alert?: boolean;
  retry?: () => void;
}

/** The wallet steps for a gift: approve where the allowance is short, then donate, cause by cause. */
export function planSteps(targets: readonly Checked[], allowances: readonly bigint[]): Step[] {
  return targets.flatMap((t, i): Step[] => (needsApproval(allowances[i], t.amount) ? [{ kind: "approve", target: t }, { kind: "donate", target: t }] : [{ kind: "donate", target: t }]));
}

const signature = (targets: readonly SplitTarget[], credit: boolean) => `${credit}|${targets.map((t) => `${t.categoryBit}:${t.vault.toLowerCase()}:${t.amount}`).join(",")}`;

/**
 * The gift button and its wallet steps. Every vault is read from `CuratorRegistry.agentOf(bit)` on
 * chain first: a gift only goes to a vault the registry names, that the indexer agrees with, and
 * that is active and not paused. Then, cause by cause, `USDC.approve(vault, share)` when the
 * allowance is short and `AgentVault.donate(share, credit)`. The plan is fixed when the dialog
 * opens, so it never shifts under the visitor; a closed dialog keeps its progress until the gift
 * changes.
 */
export function SplitDonate({ targets, credit, invalid }: { targets: readonly SplitTarget[]; credit: boolean; invalid?: string }) {
  const config = useAppConfig();
  const deps = useDeps();
  const rpc = usePrivateRpc();
  const gate = useWalletGate();
  const { address: account } = useAccount();
  const usdc = usdcAddress(config.chainId);
  const registryAddress = config.curatorRegistryAddress;
  const total = targets.reduce((s, t) => s + t.amount, 0n);
  const key = targets.map((t) => `${t.categoryBit}:${t.vault.toLowerCase()}`).join(",");

  const registry = useQuery({
    queryKey: ["split-registry", registryAddress, key],
    queryFn: () =>
      Promise.all(
        targets.map(async (t) => {
          const a = await deps.chain().readContract({ address: registryAddress!, abi: curatorRegistryAbi, functionName: "agentOf", args: [t.categoryBit] });
          const vault = a.vault === zeroAddress ? null : (getAddress(a.vault) as Address);
          const ok = vault !== null && isAddress(t.vault) && sameAddress(vault, t.vault);
          const paused = ok ? await deps.chain().readContract({ address: vault, abi: agentVaultAbi, functionName: "paused" }).catch(() => false) : false;
          return { vault: ok ? vault : null, onChain: vault, active: a.active, paused };
        }),
      ),
    enabled: Boolean(registryAddress) && targets.length > 0,
    retry: false,
    staleTime: 60_000,
  });

  const checked: Checked[] | null = useMemo(() => {
    const r = registry.data;
    if (!r || r.length !== targets.length || r.some((x) => !x.vault || !x.active || x.paused)) return null;
    return targets.map((t, i) => ({ ...t, address: r[i]!.vault! }));
  }, [registry.data, targets]);

  const accountClient = useMemo(() => (account ? createAccountClient(rpc, account) : null), [rpc, account]);
  const funds = useQuery({
    queryKey: ["split-funds", account, checked?.map((c) => c.address).join(",")],
    queryFn: async () => {
      const owner = account!;
      const [balance, ...allowances] = await Promise.all([
        accountClient!.readContract(usdcBalanceRequest({ usdc: usdc!, owner, chainId: config.chainId })),
        ...checked!.map((c) => accountClient!.readContract(allowanceRequest({ usdc: usdc!, owner, vault: c.address, chainId: config.chainId }))),
      ]);
      return { balance, allowances };
    },
    enabled: Boolean(accountClient && usdc && checked),
    retry: false,
  });

  const firstBad = registry.data?.findIndex((x) => !x.vault || !x.active || x.paused) ?? -1;
  const bad = firstBad >= 0 ? { t: targets[firstBad]!, r: registry.data![firstBad]! } : null;
  const blocker: Blocker | null =
    targets.length === 0
      ? { text: "No cause is taking donations right now." }
      : !registryAddress
        ? { text: "Donations are off on this site: no curator registry is configured, so the vaults cannot be checked on chain." }
        : registry.error
          ? { text: `Could not check the curator vaults on chain: ${errorText(registry.error)}`, alert: true, retry: () => void registry.refetch() }
          : !registry.data
            ? { text: "Checking the curator vaults on chain" }
            : bad && !bad.r.onChain
              ? { text: `${bad.t.name} has no vault yet. Pick another cause.` }
              : bad && !bad.r.vault
                ? { text: `The ${bad.t.name} vault the indexer lists is not the one registered on chain (${bad.r.onChain}), so donations to it are blocked.`, alert: true }
                : bad
                  ? { text: `${bad.t.name} is paused, so it is not taking donations. Pick another cause.` }
                  : !usdc
                    ? { text: `USDC is not available on chain ${config.chainId}.` }
                    : !account
                      ? { text: "Connect a wallet to donate." }
                      : gate.wrongChain
                        ? { text: "Your wallet is on a different network than Varada. Switch to Ethereum mainnet to donate." }
                        : !funds.data
                          ? funds.error
                            ? { text: `Could not read your USDC balance and allowances: ${errorText(funds.error)}`, alert: true, retry: () => void funds.refetch() }
                            : { text: "Reading your USDC balance" }
                          : funds.data.balance < total
                            ? { text: `Your USDC balance (${usdcText(funds.data.balance)}) is less than ${usdcText(total)}.`, alert: true }
                            : null;

  // The plan in the dialog, the steps done, and the gift it was made for.
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<{ sig: string; steps: Step[]; credit: boolean } | null>(null);
  const [done, setDone] = useState(0);
  const [sentHash, setSentHash] = useState<string>();
  const step = plan?.steps[done];
  const complete = Boolean(plan && done >= plan.steps.length);
  const tx = useTx(
    step?.kind === "approve"
      ? { kind: "transaction", description: `Approve ${usdcText(step.target.amount)} for ${step.target.name}`, titles: { pending: "Approving USDC…", success: "USDC approved", error: "Approval failed" } }
      : { kind: "donation", description: step ? `${usdcText(step.target.amount)} to ${step.target.name}` : undefined, confetti: plan && done === plan.steps.length - 1 ? "donation" : false },
  );

  // A confirmed receipt for the step just sent moves the plan on.
  const handled = useRef<string | undefined>(undefined);
  const { refetch: refetchFunds } = funds;
  useEffect(() => {
    const r = tx.receipt;
    if (!r || r.status !== "success" || r.transactionHash !== sentHash || handled.current === sentHash) return;
    handled.current = sentHash;
    setDone((d) => d + 1);
    tx.reset();
    void refetchFunds();
  }, [tx, sentHash, refetchFunds]);

  const busy = tx.isPending || Boolean(tx.hash && !tx.receipt && !tx.receiptError);
  // The step transition keeps the outgoing panel (and its button) on screen while it slides out,
  // so a click there must still send the step that is current now, never the one it was drawn for.
  const live = useRef({ step, plan, busy });
  live.current = { step, plan, busy };

  function start() {
    if (blocker || invalid || !checked || !funds.data) return;
    const sig = signature(targets, credit);
    if (!plan || plan.sig !== sig || complete) {
      setPlan({ sig, steps: planSteps(checked, funds.data.allowances), credit });
      setDone(0);
      setSentHash(undefined);
      tx.reset();
    }
    setOpen(true);
  }

  function send() {
    const { step: now, plan: current, busy: sending } = live.current;
    if (!now || !current || !usdc || sending) return;
    const t = now.target;
    const request =
      now.kind === "approve"
        ? approveRequest({ usdc, vault: t.address, amount: t.amount, chainId: config.chainId })
        : donateRequest({ vault: t.address, amount: t.amount, credit: current.credit, chainId: config.chainId });
    tx.reset();
    void tx
      .send(request as never)
      .then((hash) => setSentHash(hash))
      .catch(() => {});
  }

  const causes = plan ? [...new Set(plan.steps.map((s) => s.target.name))] : [];
  const steps: StepperStep[] = (plan?.steps ?? []).map((s, i) => ({
    id: `${s.kind}-${s.target.categoryBit}`,
    label: s.kind === "approve" ? `Approve for ${s.target.name}` : `Donate to ${s.target.name}`,
    description:
      s.kind === "approve" ? `Lets the ${s.target.name} vault take ${usdcText(s.target.amount)}. Nothing moves yet.` : `Sends ${usdcText(s.target.amount)} to the ${s.target.name} curator's vault.`,
    content:
      i === done ? (
        <div className="grid grid-cols-1 gap-3">
          <Button variant="cause" onClick={send} disabled={busy}>
            {s.kind === "donate" && <HandHeart aria-hidden="true" />}
            {s.kind === "approve" ? `Approve ${usdcText(s.target.amount)}` : `Donate ${usdcText(s.target.amount)}`}
          </Button>
          <TxStatus tx={tx} label={s.kind === "approve" ? "Approval" : "Donation"} />
        </div>
      ) : (
        <p className="m-0 text-sm text-ink-soft">{i < done ? "Confirmed." : "Waiting for the steps before it."}</p>
      ),
  }));
  const shown = invalid ? { text: invalid, alert: true } : blocker;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="cause" size="lg" onClick={start} disabled={Boolean(blocker) || Boolean(invalid) || busy}>
          <HandHeart aria-hidden="true" />
          {total > 0n ? `Donate ${usdcText(total)}` : "Donate"}
        </Button>
        {plan && !complete && done > 0 && !open && (
          <Button type="button" variant="ghost" onClick={() => setOpen(true)}>
            Continue ({done} of {plan.steps.length} done)
          </Button>
        )}
      </div>
      {shown && (
        <div role={shown.alert ? "alert" : "note"} className={`flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-sm ${shown.alert ? "bg-terracotta-tint text-terracotta-strong" : "bg-paper-card text-ink-soft"}`}>
          <span>{shown.text}</span>
          {"retry" in shown && shown.retry && (
            <Button type="button" size="sm" variant="outline" onClick={shown.retry}>
              Retry
            </Button>
          )}
          {!invalid && gate.wrongChain && (
            <Button type="button" size="sm" variant="outline" onClick={gate.switchToApp} disabled={gate.switching}>
              Switch network
            </Button>
          )}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md" onInteractOutside={(e) => busy && e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>
              Donate {plan ? usdcText(plan.steps.filter((s) => s.kind === "donate").reduce((sum, s) => sum + s.target.amount, 0n)) : ""} to {causes.length === 1 ? causes[0] : `${causes.length} causes`}
            </DialogTitle>
            <DialogDescription>
              {causes.length > 1 ? "Split evenly, one cause at a time. " : ""}
              {plan?.credit ? "Your address will be credited on this site." : "Anonymous on this site."} You can stop between causes: what you have donated stays donated.
            </DialogDescription>
          </DialogHeader>
          {plan && (
            <Stepper
              steps={steps}
              index={Math.min(done, steps.length - 1)}
              complete={complete}
              label="Donation steps"
              headingLevel={3}
              footer={<></>}
              completeContent={
                <p role="status" className="m-0 text-[15px] text-ink-soft">
                  Thank you. Your gift is with the {causes.join(" and ")} curator{causes.length === 1 ? "" : "s"}, who give it on to the charities they rank this week.
                </p>
              }
            />
          )}
          {complete && (
            <Button variant="ink" onClick={() => setOpen(false)} className="justify-self-end">
              Done
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
