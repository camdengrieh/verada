"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { parseEventLogs, zeroAddress, type Address } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { isValidLabel } from "@varada/sdk";
import { Stepper } from "@varada/ui/components/data/stepper";
import { StickyActionBar } from "@varada/ui/components/mobile/sticky-action-bar";
import { BOTTOM_TAB_BAR_HEIGHT } from "@varada/ui/components/mobile/bottom-tab-bar";
import { factoryAbi } from "@/lib/abis";
import { chainLabelStatus } from "@/lib/chain-reads";
import { loadCauses } from "@/lib/data";
import { buildMetadataDocument, parseLaunchInput, randomSalt, type LaunchInput } from "@/lib/launch";
import { ESTIMATE_METADATA_URI, launchCall } from "@/lib/launch-tx";
import {
  canAdvance,
  firstInvalidStep,
  initialWizardState,
  STEPS,
  toLaunchInput,
  validateStep,
  type WizardState,
} from "@/lib/launch-steps";
import { PublisherClient } from "@/lib/publisher";
import { findQuote } from "@/lib/quote-assets";
import { useQuoteAssets } from "@/lib/use-quote-assets";
import { useAppConfig, useDeps } from "@/components/providers";
import { errorText, useTx } from "@/components/use-tx";
import { FeesStep } from "./fees-step";
import { FocusStep } from "./focus-step";
import { IdentityStep } from "./identity-step";
import { LaunchSuccess } from "./launch-success";
import { ModeStep, type ActiveCause } from "./mode-step";
import { PairStep } from "./pair-step";
import { ReviewStep, type GasEstimate } from "./review-step";
import type { StepProps } from "./types";

const LAST = STEPS.length - 1;
const shortId = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`;

/** The stepped launch flow: identity, giving mode, pair, cause focus, fees, review and sign. */
export function LaunchWizard() {
  const config = useAppConfig();
  const deps = useDeps();
  const { address: account } = useAccount();
  const publicClient = usePublicClient({ chainId: config.chainId });
  const tx = useTx();

  const [local, setLocal] = useState<WizardState>(() => initialWizardState(randomSalt()));
  const [index, setIndex] = useState(0);
  const [labelEdited, setLabelEdited] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [attempted, setAttempted] = useState<ReadonlySet<number>>(new Set());
  const [stage, setStage] = useState<"idle" | "metadata" | "wallet">("idle");
  const [launchError, setLaunchError] = useState<string>();
  const [launchedAs, setLaunchedAs] = useState<{ name: string; symbol: string; label: string; live: boolean; rotation?: string }>();

  // ---- reads (public data only: nothing here is keyed by the visitor)

  const label = local.input.label.trim();
  const [debouncedLabel, setDebouncedLabel] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedLabel(label), 400);
    return () => clearTimeout(t);
  }, [label]);
  const labelQuery = useQuery({
    queryKey: ["label-status", config.profileRegistryAddress, debouncedLabel],
    queryFn: () => chainLabelStatus(deps.chain(), config, debouncedLabel),
    enabled: isValidLabel(debouncedLabel),
    retry: false,
    staleTime: 15_000,
  });

  const poolQuery = useQuery({
    queryKey: ["catalog-pool", local.input.categories.join(","), local.input.regions.join(",")],
    queryFn: () => deps.indexer.catalogPool(local.input.categories, local.input.regions),
    retry: false,
    staleTime: 300_000,
  });
  const summaryQuery = useQuery({ queryKey: ["catalog-summary"], queryFn: () => deps.indexer.catalog(), retry: false, staleTime: 300_000 });
  const quotes = useQuoteAssets();

  const live = local.input.mode === "live";
  const liveQuery = useQuery({
    queryKey: ["factory-live-hook", config.factoryAddress],
    queryFn: async () => {
      const hook = await deps.chain().readContract({ address: config.factoryAddress!, abi: factoryAbi, functionName: "liveHook" });
      return hook !== zeroAddress;
    },
    enabled: live && Boolean(config.factoryAddress),
    retry: false,
    staleTime: 60_000,
  });

  const causesQuery = useQuery({
    queryKey: ["live-start-causes"],
    queryFn: async (): Promise<ActiveCause[]> => {
      const all = [...(await loadCauses(deps)).values()].filter((c) => c.isDeployed);
      const names = all.length ? await deps.indexer.catalogCauses(all.map((c) => c.causeId)).catch(() => new Map()) : new Map();
      return all
        .map((c) => ({ causeId: c.causeId.toLowerCase(), name: names.get(c.causeId.toLowerCase())?.name ?? (c.name !== c.causeId ? c.name : shortId(c.causeId)) }))
        .sort((a, b) => a.name.localeCompare(b.name, "en"));
    },
    enabled: live,
    retry: false,
    staleTime: 120_000,
  });

  const ws: WizardState = useMemo(
    () => ({
      ...local,
      account,
      labelStatus: debouncedLabel === label ? labelQuery.data : undefined,
      pool: poolQuery.isLoading ? undefined : (poolQuery.data ?? null),
      allowedQuotes: quotes.isLoading || quotes.error ? undefined : quotes.assets.map((a) => a.address),
      liveReady: liveQuery.data,
      causeActive: causesQuery.data && local.input.initialCause ? causesQuery.data.some((c) => c.causeId === local.input.initialCause!.toLowerCase()) : undefined,
    }),
    [local, account, debouncedLabel, label, labelQuery.data, poolQuery.isLoading, poolQuery.data, quotes.isLoading, quotes.error, quotes.assets, liveQuery.data, causesQuery.data],
  );

  // ---- step plumbing

  const patch = useCallback((change: Partial<WizardState>) => setLocal((s) => ({ ...s, ...change })), []);
  const setInput = useCallback((change: Partial<LaunchInput>) => setLocal((s) => ({ ...s, input: { ...s.input, ...change } })), []);
  const touch = useCallback((field: string) => setTouched((t) => (t.has(field) ? t : new Set(t).add(field))), []);

  const stepId = STEPS[index]!.id;
  const errors = validateStep(stepId, ws);
  const stepProps = (at: number): StepProps => {
    const id = STEPS[at]!.id;
    const errs = id === stepId ? errors : validateStep(id, ws);
    const show = attempted.has(at);
    return { state: ws, errors: errs, err: (f) => (show || touched.has(f) ? errs[f] : undefined), touch, patch, setInput };
  };

  const goTo = (to: number) => setIndex(Math.max(0, Math.min(LAST, to)));
  const next = () => {
    if (!canAdvance(stepId, ws)) {
      setAttempted((a) => new Set(a).add(index));
      return;
    }
    goTo(index + 1);
  };

  // ---- launch

  const quote = findQuote(quotes.assets, local.input.quoteAsset);
  const parsed = useMemo(() => parseLaunchInput(toLaunchInput(ws)), [ws]);
  const factory = config.factoryAddress;
  const call = useMemo(() => {
    if (!factory || !parsed.ok) return null;
    return launchCall(factory, parsed.params, parsed.params.metadataURI || ESTIMATE_METADATA_URI, parsed.live);
  }, [factory, parsed]);

  const estimateKey = call ? JSON.stringify(call.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : "";
  const estimate = useQuery({
    queryKey: ["launch-estimate", factory, account, estimateKey],
    queryFn: async () => {
      const client = publicClient!;
      const gas = await client.estimateContractGas({ ...call!, account: account! } as never);
      const gasPrice = await client.getGasPrice().catch(() => null);
      return { gas, gasPrice };
    },
    enabled: index === LAST && Boolean(account && publicClient && call) && firstInvalidStep(ws) === -1,
    retry: false,
    staleTime: 30_000,
  });
  const gas: GasEstimate = estimate.isLoading
    ? { status: "loading" }
    : estimate.data
      ? { status: "ready", gas: estimate.data.gas, gasPrice: estimate.data.gasPrice }
      : estimate.error
        ? { status: "error", message: errorText(estimate.error) }
        : { status: "idle" };

  const launched = useMemo(() => {
    if (!tx.receipt || tx.receipt.status !== "success") return undefined;
    const [log] = parseEventLogs({ abi: factoryAbi, eventName: "TokenCreated", logs: tx.receipt.logs });
    return { token: ((log?.args as { token?: Address } | undefined)?.token ?? null) as string | null };
  }, [tx.receipt]);

  const [parseError, setParseError] = useState<string>();
  async function launch() {
    setParseError(undefined);
    setLaunchError(undefined);
    tx.reset();
    const bad = firstInvalidStep(ws);
    if (bad !== -1) {
      setAttempted((a) => new Set(a).add(bad));
      return goTo(bad);
    }
    if (!factory) return setParseError("factoryAddress is not configured (config.json)");
    if (!parsed.ok) return setParseError(parsed.error);
    let metadataURI = parsed.params.metadataURI;
    try {
      if (!metadataURI) {
        if (!config.publisherUrl) return setParseError("publisherUrl is not configured (config.json), so the metadata document cannot be stored. Set a metadata URI under Advanced on the Identity step.");
        const doc = buildMetadataDocument(parsed.params, ws.logoRef ?? "", ws.fields);
        if (!doc.ok) return setParseError(doc.error);
        setStage("metadata");
        metadataURI = (await new PublisherClient(config.publisherUrl).uploadMetadata(doc.doc)).uri;
      }
      setStage("wallet");
      setLaunchedAs({ name: parsed.params.name, symbol: parsed.params.symbol, label: parsed.params.label, live: Boolean(parsed.live), rotation: ws.input.rotation });
      const c = launchCall(factory, parsed.params, metadataURI, parsed.live);
      await tx.send({ ...c, chainId: config.chainId } as never);
    } catch (e) {
      setLaunchError(errorText(e));
    } finally {
      setStage("idle");
    }
  }

  const rerollSalt = () => {
    setInput({ salt: randomSalt() });
    tx.reset();
    setLaunchError(undefined);
  };

  const again = () => {
    tx.reset();
    setLocal(initialWizardState(randomSalt()));
    setIndex(0);
    setTouched(new Set());
    setAttempted(new Set());
    setLabelEdited(false);
    setLaunchedAs(undefined);
  };

  if (launched && launchedAs) {
    return <LaunchSuccess {...launchedAs} token={launched.token} txHash={tx.hash} onAgain={again} />;
  }

  const sending = stage !== "idle" || tx.isPending || Boolean(tx.hash && !tx.receipt && !tx.receiptError);
  const txError = launchError ?? (tx.error ? errorText(tx.error) : tx.receiptError ? `Could not read the receipt: ${errorText(tx.receiptError)}` : tx.receipt?.status === "reverted" ? `The launch reverted (${tx.hash})${tx.revertReason ? `: ${tx.revertReason}` : ""}` : undefined);
  const causeName = causesQuery.data?.find((c) => c.causeId === local.input.initialCause?.toLowerCase())?.name;

  const steps = [
    {
      ...STEPS[0],
      content: (
        <IdentityStep
          {...stepProps(0)}
          labelLoading={labelQuery.isFetching}
          labelFailed={Boolean(labelQuery.error)}
          labelEdited={labelEdited}
          setLabelEdited={setLabelEdited}
          onLogo={(ref) => patch({ logoRef: ref })}
          onLogoBusy={(busy) => patch({ logoUploading: busy })}
        />
      ),
    },
    {
      ...STEPS[1],
      content: <ModeStep {...stepProps(1)} causes={causesQuery.data} causesLoading={causesQuery.isLoading} causesFailed={Boolean(causesQuery.error)} liveReady={liveQuery.data} />,
    },
    {
      ...STEPS[2],
      content: <PairStep {...stepProps(2)} assets={quotes.assets} loading={quotes.isLoading} marketsLoading={quotes.marketsLoading} failed={Boolean(quotes.error)} retry={quotes.refetch} />,
    },
    { ...STEPS[3], content: <FocusStep {...stepProps(3)} summary={summaryQuery.data} /> },
    { ...STEPS[4], content: <FeesStep {...stepProps(4)} /> },
    {
      ...STEPS[5],
      content: <ReviewStep state={ws} quote={quote} causeName={causeName} gas={gas} onEdit={goTo} parseError={parseError} txError={txError} onRerollSalt={rerollSalt} />,
    },
  ];

  const firstError = Object.values(errors).find(Boolean);
  const isLast = index === LAST;
  const primaryLabel = isLast
    ? stage === "metadata"
      ? "Uploading metadata"
      : stage === "wallet" || tx.isPending
        ? "Confirm in your wallet"
        : sending
          ? "Waiting for confirmation"
          : "Launch coin"
    : "Continue";
  const primary = {
    label: primaryLabel,
    onClick: isLast ? () => void launch() : next,
    disabled: isLast ? sending || !account || firstInvalidStep(ws) !== -1 : false,
  };
  const secondary = index > 0 ? { label: "Back", onClick: () => goTo(index - 1) } : undefined;
  const note = isLast
    ? !account
      ? "Connect a wallet to launch."
      : tx.hash && !tx.receipt
        ? `Submitted ${tx.hash.slice(0, 10)}…, waiting for the block.`
        : undefined
    : firstError && attempted.has(index)
      ? firstError
      : undefined;

  return (
    <div className="pb-44 md:pb-0" style={{ "--bar-h": `${BOTTOM_TAB_BAR_HEIGHT}px` } as React.CSSProperties}>
      <Stepper steps={steps} index={index} onIndexChange={goTo} orientation="vertical" label="Launch progress" footer={null} headingLevel={2} />
      <div className="mt-6 hidden border-t border-line pt-4 md:block">
        <StickyActionBar position="static" primary={primary} secondary={secondary} note={note} className="border-0 bg-transparent p-0 backdrop-blur-none [&>div]:px-0 md:max-w-xl md:ml-auto" />
      </div>
      <div className="md:hidden">
        <StickyActionBar aboveTabBar primary={primary} secondary={secondary} note={note} />
      </div>
    </div>
  );
}
