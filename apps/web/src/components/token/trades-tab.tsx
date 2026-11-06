"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { Badge } from "@varada/ui/components/ui/badge";
import { Button } from "@varada/ui/components/ui/button";
import { Switch } from "@varada/ui/components/ui/switch";
import { TradeFeed } from "@varada/ui/components/varada/trade-feed";
import { errorText } from "@/components/use-tx";
import type { UsdQuote } from "@varada/sdk";
import type { MarketTrade } from "@/lib/indexer";
import type { QuoteInfo } from "@/lib/quote-info";
import { mine, tradeItems } from "@/lib/token-market";
import type { useTradeTape } from "./use-token-data";

const ROWS = 15;

export function TradesTab({ symbol, quote, quoteDecimals, tape, onTrade, usd }: { symbol: string; quote: QuoteInfo | null; quoteDecimals: number | null; tape: ReturnType<typeof useTradeTape>; onTrade?: () => void; /** USD per quote asset. */ usd?: UsdQuote | null }) {
  const { address: account } = useAccount();
  const [onlyMine, setOnlyMine] = useState(false);
  const [rows, setRows] = useState(ROWS);
  const switchId = useId();
  useEffect(() => {
    if (!account) setOnlyMine(false);
  }, [account]);

  // "My trades" is a filter over what the browser already has: the address never reaches a server.
  const source: readonly MarketTrade[] = useMemo(() => (onlyMine ? mine(tape.trades, account) : tape.trades), [onlyMine, tape.trades, account]);
  const items = useMemo(() => tradeItems(source, { tokenSymbol: `$${symbol}`, quoteSymbol: quote?.symbol ?? "", quoteDecimals, usdQuote: Boolean(quote?.usd), usd: quote?.usd ? null : usd }), [source, symbol, quote, quoteDecimals, usd]);

  if (tape.error && tape.trades.length === 0) {
    return (
      <div role="alert" className="rounded-2xl border border-line bg-card">
        <EmptyState size="compact" title="Could not load trades" body={errorText(tape.error)} action={<Button variant="outline" size="sm" onClick={tape.refetch}>Try again</Button>} />
      </div>
    );
  }
  if (!tape.loading && tape.trades.length === 0) {
    return (
      <div className="rounded-2xl border border-line bg-card">
        <EmptyState
          title="Swaps will be listed here"
          body="Each one appears as it happens, with who traded, how much and a link to the transaction. Every trade pays a fee, and 90% of it goes to the token's cause."
          action={onTrade ? <Button onClick={onTrade}>Make the first trade</Button> : undefined}
        />
      </div>
    );
  }

  const canShowMore = items.length > rows || (!onlyMine && tape.hasMore) || (onlyMine && tape.hasMore);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2.5">
          <Switch id={switchId} checked={onlyMine} onCheckedChange={setOnlyMine} disabled={!account} tone="cause" />
          <label htmlFor={switchId} className="text-sm text-ink-soft">
            {account ? "My trades" : "My trades (connect a wallet)"}
          </label>
        </span>
        <span className="text-xs text-ink-muted">
          {onlyMine ? "Filtered in your browser from the swaps loaded here; your address is never sent." : "Newest first. The wallet shown is the transaction sender."}
        </span>
      </div>
      <TradeFeed
        trades={items}
        loading={tape.loading}
        maxRows={rows}
        headingLevel={2}
        title="Trades"
        emptyText={onlyMine ? "None of the loaded trades are yours. Older trades may be, so load more." : undefined}
        action={
          tape.mode ? (
            <Badge tone="cause" dot>
              {tape.mode === "sse" ? "Live" : "Updating"}
            </Badge>
          ) : undefined
        }
        footer={
          <div className="flex flex-col items-center gap-2">
            {tape.moreError ? (
              <p role="alert" className="m-0 text-sm text-destructive">
                {tape.moreError}
              </p>
            ) : null}
            {canShowMore ? (
              <Button
                variant="outline"
                size="sm"
                disabled={tape.loadingMore}
                onClick={() => {
                  if (items.length > rows) setRows((r) => r + ROWS);
                  else void tape.loadMore().then(() => setRows((r) => r + ROWS));
                }}
              >
                {tape.loadingMore ? "Loading" : "Show older trades"}
              </Button>
            ) : null}
          </div>
        }
      />
    </div>
  );
}
