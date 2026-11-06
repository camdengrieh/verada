"use client";

import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { Button } from "@varada/ui/components/ui/button";
import { Field, FieldControl, FieldError, FieldHint, FieldLabel } from "@varada/ui/components/ui/field";
import { Input, InputAddon, InputGroup } from "@varada/ui/components/ui/input";
import { Coins } from "@varada/ui/components/ui/icons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@varada/ui/components/ui/tabs";
import { QuoteAssetList } from "@varada/ui/components/varada/quote-asset-list";
import { formatQuoteAmount } from "@/lib/launch-format";
import { marketCapFromTick, priceFromTick, startTickFromMarketCap, TOKEN_SUPPLY } from "@/lib/launch";
import { findQuote, type AppQuoteAsset } from "@/lib/quote-assets";
import type { StepProps } from "./types";

/** The current time, refreshed every minute (market sessions depend on it). */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Market caps offered as one-tap choices, in units of the quote asset. */
const CAP_PRESETS = ["1", "10", "100", "1000"] as const;

export function PairStep({
  state,
  err,
  touch,
  setInput,
  patch,
  assets,
  loading,
  marketsLoading = false,
  failed,
  retry,
}: StepProps & { assets: AppQuoteAsset[]; loading: boolean; marketsLoading?: boolean; failed: boolean; retry(): void }) {
  const now = useNow();
  const selected = findQuote(assets, state.input.quoteAsset);
  const [tab, setTab] = useState<"crypto" | "stock">(selected && selected.kind !== "crypto" ? "stock" : "crypto");
  const crypto = useMemo(() => assets.filter((a) => a.kind === "crypto"), [assets]);
  const tokenized = useMemo(() => assets.filter((a) => a.kind !== "crypto"), [assets]);
  const symbol = selected?.symbol ?? "quote";

  const choose = (list: AppQuoteAsset[]) => (sym: string) => {
    const a = list.find((x) => x.symbol === sym);
    if (a) setInput({ quoteAsset: a.address });
  };

  const tick = startTickFromMarketCap(Number(state.marketCap));
  const price = tick === null ? null : priceFromTick(tick);
  const cap = tick === null ? null : marketCapFromTick(tick);

  return (
    <div className="flex flex-col gap-6">
      {loading ? <p role="status" className="m-0 text-sm text-ink-soft">Loading the quote registry&rsquo;s allowlist</p> : null}
      {failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 bg-paper-card p-4 text-sm text-destructive">
          <span>Could not load the allowed quote assets from the indexer.</span>
          <Button size="sm" variant="outline" onClick={retry}>
            Try again
          </Button>
        </div>
      ) : null}
      {err("quoteAsset") ? (
        <p role="alert" className="m-0 text-sm font-medium text-destructive">
          {err("quoteAsset")}
        </p>
      ) : null}

      {assets.length > 0 ? (
        <Tabs value={tab} onValueChange={(v) => setTab(v as "crypto" | "stock")} variant="segmented">
          <TabsList aria-label="Asset family">
            <TabsTrigger value="crypto">Crypto ({crypto.length})</TabsTrigger>
            <TabsTrigger value="stock">Stocks & RWA ({tokenized.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="crypto">
            {crypto.length === 0 ? (
              <EmptyState size="compact" icon={<Coins />} title="No crypto pairs allowed" body="The quote registry has no active crypto asset right now." />
            ) : (
              <QuoteAssetList
                mode="select"
                assets={crypto}
                now={now}
                value={selected?.kind === "crypto" ? selected.symbol : null}
                onValueChange={choose(crypto)}
                title="Crypto pairs"
                headingLevel={3}
                hideControls={crypto.length < 6}
                coinSymbol={state.input.symbol || undefined}
              />
            )}
          </TabsContent>
          <TabsContent value="stock">
            {marketsLoading && tokenized.length > 0 ? (
              // Depth is read from the chain; until it answers every RWA would look unrouted, so show placeholders instead.
              <QuoteAssetList mode="select" assets={[]} loading now={now} value={null} onValueChange={() => undefined} title="Stocks, ETFs and tokenized assets" headingLevel={3} hideControls />
            ) : tokenized.length === 0 ? (
              <EmptyState size="compact" icon={<Coins />} title="No tokenized assets allowed" body="The quote registry has no active Ondo stock, ETF or tokenized asset right now." />
            ) : (
              <QuoteAssetList
                mode="select"
                assets={tokenized}
                now={now}
                value={selected && selected.kind !== "crypto" ? selected.symbol : null}
                onValueChange={choose(tokenized)}
                title="Stocks, ETFs and tokenized assets"
                headingLevel={3}
                hideControls={tokenized.length < 6}
                recommendedSymbol={null}
                defaultSort="liquidity"
                coinSymbol={state.input.symbol || undefined}
                searchPlaceholder="Search NVDAon, Tesla, SPY…"
              />
            )}
          </TabsContent>
        </Tabs>
      ) : null}

      <Field invalid={!!err("marketCap")}>
        <FieldLabel>Starting market cap</FieldLabel>
        <InputGroup>
          <FieldControl>
            <Input
              inputMode="decimal"
              className="num"
              value={state.marketCap}
              onChange={(e) => patch({ marketCap: e.target.value.trim() })}
              onBlur={() => touch("marketCap")}
            />
          </FieldControl>
          <InputAddon>{symbol}</InputAddon>
        </InputGroup>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Market cap presets">
          {CAP_PRESETS.map((p) => (
            <Button key={p} size="sm" variant={state.marketCap === p ? "primary" : "outline"} onClick={() => patch({ marketCap: p })}>
              <span className="num">{Number(p).toLocaleString("en-US")}</span> {symbol}
            </Button>
          ))}
        </div>
        <FieldHint>
          Every coin has a fixed supply of <span className="num">{TOKEN_SUPPLY.toLocaleString("en-US")}</span> tokens, all placed in the pool as one-sided liquidity. The cap is in units of {symbol}: the app has no
          price oracle, so it never converts to dollars.
        </FieldHint>
        <FieldError>{err("marketCap")}</FieldError>
        {tick !== null && price !== null && cap !== null ? (
          <div className="flex flex-col gap-3 rounded-xl border border-line bg-paper-card p-4 text-sm">
          <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-2 @sm:grid-cols-3" aria-label="Starting price">
            <div>
              <dt className="text-ink-muted">Start price</dt>
              <dd className="num m-0 font-semibold">
                {formatQuoteAmount(price)} {symbol}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">Start market cap</dt>
              <dd className="num m-0 font-semibold">
                {formatQuoteAmount(cap)} {symbol}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">Start tick</dt>
              <dd className="num m-0 font-semibold">{tick.toLocaleString("en-US")}</dd>
            </div>
          </dl>
          <p className="m-0 text-[13px] text-ink-muted">The pool rounds the price to a step of about 2%, so the market cap lands on the nearest step to what you typed.</p>
          </div>
        ) : null}
      </Field>
    </div>
  );
}
