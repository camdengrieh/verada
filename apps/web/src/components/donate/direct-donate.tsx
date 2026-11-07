"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { Stepper, type StepperStep } from "@varada/ui/components/data/stepper";
import { Button } from "@varada/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@varada/ui/components/ui/dialog";
import { HandHeart } from "@varada/ui/components/ui/icons";
import { usdcText } from "@/components/agent-common";
import { DepositAddress } from "@/components/donate/deposit-address";
import { useWalletGate } from "@/components/governance/use-wallet-gate";
import { useAppConfig, useDeps, usePrivateRpc } from "@/components/providers";
import { errorText, TxStatus, useTx } from "@/components/use-tx";
import { createAccountClient } from "@/lib/account-reads";
import { approveSpenderRequest, ethOrgIdOf, orgEnsName, orgGiftRequest, orgRoute, readOrgTarget, type OrgTarget } from "@/lib/org-donate";
import { allowanceRequest, needsApproval, usdcAddress, usdcBalanceRequest } from "@/lib/vault";

export interface DirectOrg {
  orgId: string;
  ethOrgId?: string | null;
  name: string;
  label?: string | null;
}

interface Plan {
  key: string;
  target: OrgTarget;
  spender: Address;
  amount: bigint;
  steps: ("approve" | "give")[];
}

/**
 * Gives USDC straight to one Endaoment charity. Its deposit address and state are read on chain
 * (`lib/org-donate`), shown with its ENS name and copy buttons, and the gift runs in a dialog:
 * approve when the allowance is short, then donate (or deploy-and-donate for an org with no
 * contract yet). The plan is fixed when the dialog opens.
 */
export function DirectDonate({ org, amount, invalid }: { org: DirectOrg; amount: bigint | null; invalid?: string }) {
  const config = useAppConfig();
  const deps = useDeps();
  const rpc = usePrivateRpc();
  const gate = useWalletGate();
  const { address: account } = useAccount();
  const usdc = usdcAddress(config.chainId);
  const orgId = ethOrgIdOf(org);
  const ens = orgEnsName(org.label, config.ensParentName);

  const target = useQuery({ queryKey: ["org-target", orgId], queryFn: () => readOrgTarget(deps.chain(), orgId), retry: false, staleTime: 60_000 });
  const route = target.data ? orgRoute(target.data) : null;
  const spender = route && route.kind !== "blocked" ? route.spender : null;

  const accountClient = useMemo(() => (account ? createAccountClient(rpc, account) : null), [rpc, account]);
  const funds = useQuery({
    queryKey: ["org-funds", account, spender],
    queryFn: async () => {
      const owner = account!;
      const [balance, allowance] = await Promise.all([
        accountClient!.readContract(usdcBalanceRequest({ usdc: usdc!, owner, chainId: config.chainId })),
        accountClient!.readContract(allowanceRequest({ usdc: usdc!, owner, vault: spender!, chainId: config.chainId })),
      ]);
      return { balance, allowance };
    },
    enabled: Boolean(accountClient && usdc && spender),
    retry: false,
  });

  const blocker =
    target.error
      ? { text: `Could not read this charity's address on chain: ${errorText(target.error)}`, alert: true, retry: () => void target.refetch() }
      : !target.data
        ? { text: "Reading this charity's address on chain" }
        : route?.kind === "blocked"
          ? { text: route.reason, alert: true }
          : !usdc
            ? { text: `USDC is not available on chain ${config.chainId}.` }
            : !account
              ? { text: "Connect a wallet to donate." }
              : gate.wrongChain
                ? { text: "Your wallet is on a different network than Varada. Switch to Ethereum mainnet to donate." }
                : !funds.data
                  ? funds.error
                    ? { text: `Could not read your USDC balance: ${errorText(funds.error)}`, alert: true, retry: () => void funds.refetch() }
                    : { text: "Reading your USDC balance" }
                  : amount !== null && funds.data.balance < amount
                    ? { text: `Your USDC balance (${usdcText(funds.data.balance)}) is less than ${usdcText(amount)}.`, alert: true }
                    : null;

  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [done, setDone] = useState(0);
  const [sentHash, setSentHash] = useState<string>();
  const step = plan?.steps[done];
  const complete = Boolean(plan && done >= plan.steps.length);
  const tx = useTx(
    step === "approve"
      ? { kind: "transaction", description: `Approve ${plan ? usdcText(plan.amount) : ""} for ${org.name}`, titles: { pending: "Approving USDC…", success: "USDC approved", error: "Approval failed" } }
      : { kind: "donation", description: plan ? `${usdcText(plan.amount)} to ${org.name}` : undefined, confetti: "donation" },
  );

  const handled = useRef<string | undefined>(undefined);
  const { refetch: refetchFunds } = funds;
  const { refetch: refetchTarget } = target;
  useEffect(() => {
    const r = tx.receipt;
    if (!r || r.status !== "success" || r.transactionHash !== sentHash || handled.current === sentHash) return;
    handled.current = sentHash;
    setDone((d) => d + 1);
    tx.reset();
    void refetchFunds();
    void refetchTarget();
  }, [tx, sentHash, refetchFunds, refetchTarget]);

  const busy = tx.isPending || Boolean(tx.hash && !tx.receipt && !tx.receiptError);
  // The outgoing step panel stays on screen while it slides out: send what is current now.
  const live = useRef({ step, plan, busy });
  live.current = { step, plan, busy };

  function start() {
    if (blocker || invalid || amount === null || !target.data || !spender || !funds.data) return;
    const key = `${orgId}:${amount}`;
    if (!plan || plan.key !== key || complete) {
      setPlan({ key, target: target.data, spender, amount, steps: needsApproval(funds.data.allowance, amount) ? ["approve", "give"] : ["give"] });
      setDone(0);
      setSentHash(undefined);
      tx.reset();
    }
    setOpen(true);
  }

  function send() {
    const { step: now, plan: p, busy: sending } = live.current;
    if (!now || !p || !usdc || sending) return;
    const request =
      now === "approve"
        ? approveSpenderRequest({ usdc, spender: p.spender, amount: p.amount, chainId: config.chainId })
        : orgGiftRequest({ target: p.target, amount: p.amount, chainId: config.chainId });
    tx.reset();
    void tx
      .send(request as never)
      .then((hash) => setSentHash(hash))
      .catch(() => {});
  }

  const deploying = plan ? !plan.target.deployed : target.data ? !target.data.deployed : false;
  const steps: StepperStep[] = (plan?.steps ?? []).map((s, i) => ({
    id: s,
    label: s === "approve" ? "Approve USDC" : deploying ? "Donate and open the account" : "Donate",
    description:
      s === "approve"
        ? `Lets ${deploying ? "Endaoment's factory" : org.name} take ${plan ? usdcText(plan.amount) : ""}. Nothing moves yet.`
        : deploying
          ? `This is ${org.name}'s first on-chain gift: it opens their Endaoment account at the address below and credits it.`
          : `Sends the USDC to ${org.name}'s Endaoment account.`,
    content:
      i === done ? (
        <div className="grid grid-cols-1 gap-3">
          <Button variant="cause" onClick={send} disabled={busy}>
            {s === "give" && <HandHeart aria-hidden="true" />}
            {s === "approve" ? `Approve ${plan ? usdcText(plan.amount) : ""}` : `Donate ${plan ? usdcText(plan.amount) : ""}`}
          </Button>
          <TxStatus tx={tx} label={s === "approve" ? "Approval" : "Donation"} />
        </div>
      ) : (
        <p className="m-0 text-sm text-ink-soft">{i < done ? "Confirmed." : "Waiting for the step before it."}</p>
      ),
  }));
  const shown = invalid ? { text: invalid, alert: true } : blocker;

  return (
    <div className="flex flex-col gap-3">
      {target.data ? (
        <div className="flex flex-col gap-1.5">
          <DepositAddress address={target.data.address} name={ens} chainId={config.chainId} label={`${org.name} deposit address`} />
          <p className="m-0 text-[13px] text-ink-muted">
            {target.data.deployed
              ? "Endaoment account on Ethereum, read from Endaoment's factory."
              : "Not opened yet: the first gift through this page opens the account at this address. Don't send tokens here from elsewhere until it has been."}
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="cause" size="lg" effect="wash" onClick={start} disabled={Boolean(blocker) || Boolean(invalid) || busy}>
          <HandHeart aria-hidden="true" />
          {amount ? `Donate ${usdcText(amount)}` : "Donate"}
        </Button>
        {plan && !complete && done > 0 && !open && (
          <Button type="button" variant="ghost" onClick={() => setOpen(true)}>
            Continue
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
              Donate {plan ? usdcText(plan.amount) : ""} to {org.name}
            </DialogTitle>
            <DialogDescription>Straight to the charity&apos;s Endaoment account. Endaoment takes its platform fee from the gift. Your address is visible on chain, like any transaction.</DialogDescription>
          </DialogHeader>
          {plan && (
            <>
              <DepositAddress address={plan.target.address} name={ens} chainId={config.chainId} label={`${org.name} deposit address`} />
              <Stepper
                steps={steps}
                index={Math.min(done, steps.length - 1)}
                complete={complete}
                label="Donation steps"
                headingLevel={3}
                footer={<></>}
                completeContent={
                  <p role="status" className="m-0 text-[15px] text-ink-soft">
                    Thank you. {usdcText(plan.amount)} is with {org.name}.
                  </p>
                }
              />
            </>
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
