// Adapted from 21st.dev @wensity/drawer (id 31360) via ui/drawer.tsx, like the vote sheet: a tall
// bottom sheet with a header, segmented tabs and a scrolling body. It holds the coin page's
// activity on a phone: the live trade tape, and the holders table with its insight card.
"use client";

import { useState, type ReactNode } from "react";
import { Drawer, DrawerBody, DrawerContent, DrawerHeader } from "@verada/ui/components/ui/drawer";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@verada/ui/components/ui/tabs";
import { HolderInsights, type HolderInsightsProps } from "@verada/ui/components/varada/holder-insights";
import { HoldersTable, type HolderItem } from "@verada/ui/components/varada/holders-table";
import { TradeFeed, type TradeItem } from "@verada/ui/components/varada/trade-feed";
import { cn } from "@verada/ui/lib/utils";
import { CONTAINED_SHEET, InlineSheet, sheetParts, type MobileSheetBaseProps } from "./sheet-shared";

export type MobileTradesTab = "trades" | "holders";

export interface MobileTradesSheetProps extends MobileSheetBaseProps {
  /** "$HARAMBE" */
  symbol: string;
  /** "Harambe's Wish", for the title. */
  name?: string;
  trades: readonly TradeItem[];
  tradesLoading?: boolean;
  /** The trade tape's "Large" threshold in USD. */
  largeUsd?: number;
  holders: readonly HolderItem[];
  totalHolders?: number;
  /** The insight card above the holders table (omit to show the table alone). */
  insights?: Omit<HolderInsightsProps, "headingLevel">;
  /** Tab (controlled) … */
  tab?: MobileTradesTab;
  /** … or the starting tab. */
  defaultTab?: MobileTradesTab;
  onTabChange?: (tab: MobileTradesTab) => void;
  /** At the end of the body, e.g. "Open on Etherscan". */
  footer?: ReactNode;
}

const FLAT = "rounded-none border-0 bg-transparent p-0 @md:p-0";

/** Trades and holders for one coin, as a phone sheet with two tabs. */
export function MobileTradesSheet({
  open,
  onOpenChange,
  container,
  modal = true,
  inline,
  symbol,
  name,
  trades,
  tradesLoading,
  largeUsd,
  holders,
  totalHolders,
  insights,
  tab: tabProp,
  defaultTab = "trades",
  onTabChange,
  footer,
}: MobileTradesSheetProps) {
  const [innerTab, setInnerTab] = useState<MobileTradesTab>(defaultTab);
  const tab = tabProp ?? innerTab;
  const setTab = (t: string) => {
    if (tabProp === undefined) setInnerTab(t as MobileTradesTab);
    onTabChange?.(t as MobileTradesTab);
  };
  const { Title, Description } = sheetParts(inline);

  const content = (
    <Tabs value={tab} onValueChange={setTab} variant="segmented" className="flex min-h-0 flex-1 flex-col gap-0">
      <DrawerHeader className="gap-2 pb-3">
        <Title className="text-2xl leading-tight">{name ? `${name} activity` : `${symbol} activity`}</Title>
        <Description className="sr-only">Recent trades and the largest holders of {symbol}.</Description>
        <TabsList aria-label={`${symbol} activity`} className="w-full [&>*]:flex-1">
          <TabsTrigger value="trades">Trades</TabsTrigger>
          <TabsTrigger value="holders">Holders</TabsTrigger>
        </TabsList>
      </DrawerHeader>
      <DrawerBody className="@container min-h-0 flex-1 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <TabsContent value="trades" className="mt-0">
          <TradeFeed trades={trades} loading={tradesLoading} largeUsd={largeUsd} title="Latest trades" maxRows={20} className={FLAT} />
        </TabsContent>
        <TabsContent value="holders" className="mt-0 flex flex-col gap-4">
          {insights ? <HolderInsights {...insights} className={cn(FLAT, insights.className)} /> : null}
          <HoldersTable holders={holders} symbol={symbol} totalHolders={totalHolders} initialRows={8} defaultHideContracts className={FLAT} />
        </TabsContent>
        {footer}
      </DrawerBody>
    </Tabs>
  );

  if (inline) {
    return open ? (
      <InlineSheet data-slot="mobile-trades-sheet" onClose={() => onOpenChange(false)} className="h-[88%]">
        {content}
      </InlineSheet>
    ) : null;
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} container={container} modal={modal} noBodyStyles={!!container}>
      <DrawerContent data-slot="mobile-trades-sheet" className={cn("h-[88dvh]", container && "h-[88%]", container && CONTAINED_SHEET)}>
        {content}
      </DrawerContent>
    </Drawer>
  );
}
