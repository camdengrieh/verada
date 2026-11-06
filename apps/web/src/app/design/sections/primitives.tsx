"use client";

import { useState } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@varada/ui/components/ui/accordion";
import { Avatar, AvatarFallback, AvatarGroup } from "@varada/ui/components/ui/avatar";
import { Badge } from "@varada/ui/components/ui/badge";
import { Button } from "@varada/ui/components/ui/button";
import { Checkbox } from "@varada/ui/components/ui/checkbox";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  useCommandShortcut,
} from "@varada/ui/components/ui/command";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@varada/ui/components/ui/dialog";
import {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@varada/ui/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@varada/ui/components/ui/dropdown-menu";
import { Field, FieldControl, FieldError, FieldHint, FieldLabel, FieldLegend, FieldSet } from "@varada/ui/components/ui/field";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@varada/ui/components/ui/hover-card";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Coins,
  Copy,
  Filter,
  HandHeart,
  Info,
  LogOut,
  Menu,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  User,
  Vote,
  Wallet,
} from "@varada/ui/components/ui/icons";
import { Input, InputAddon, InputGroup } from "@varada/ui/components/ui/input";
import { Kbd, KbdGroup } from "@varada/ui/components/ui/kbd";
import { Label } from "@varada/ui/components/ui/label";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@varada/ui/components/ui/popover";
import { Progress } from "@varada/ui/components/ui/progress";
import { RadioCard, RadioGroup, RadioGroupItem } from "@varada/ui/components/ui/radio-group";
import { ScrollArea } from "@varada/ui/components/ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@varada/ui/components/ui/select";
import { Separator } from "@varada/ui/components/ui/separator";
import { Sheet, SheetBody, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@varada/ui/components/ui/sheet";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { Slider } from "@varada/ui/components/ui/slider";
import { Switch } from "@varada/ui/components/ui/switch";
import { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@varada/ui/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@varada/ui/components/ui/tabs";
import { Textarea } from "@varada/ui/components/ui/textarea";
import { Toaster, toast } from "@varada/ui/components/ui/toaster";
import { ToggleGroup, ToggleGroupItem } from "@varada/ui/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@varada/ui/components/ui/tooltip";
import { GallerySection, Specimen } from "../section";

/* Sample values only. */
const CAUSES = [
  { value: "wildlife", label: "Wildlife rescue" },
  { value: "oceans", label: "Ocean clean-up" },
  { value: "water", label: "Clean water" },
  { value: "education", label: "Girls' education" },
  { value: "hunger", label: "Food banks" },
  { value: "climate", label: "Reforestation" },
];

const TOKENS = [
  { symbol: "$HARAMBE", name: "Harambe", kind: "meme", price: "$0.0412", change: "+18.4%", cause: "Wildlife rescue" },
  { symbol: "$GIGACHAD", name: "Gigachad", kind: "meme", price: "$0.0087", change: "-3.1%", cause: "Food banks" },
  { symbol: "$WIFHAT", name: "Tiger wif hat", kind: "meme", price: "$0.1930", change: "+6.2%", cause: "Wildlife rescue" },
  { symbol: "NVDAon", name: "NVIDIA (Ondo)", kind: "stock", price: "$182.40", change: "+1.2%", cause: "Girls' education" },
  { symbol: "TSLAon", name: "Tesla (Ondo)", kind: "stock", price: "$248.15", change: "-0.8%", cause: "Reforestation" },
  { symbol: "SPYon", name: "S&P 500 ETF (Ondo)", kind: "etf", price: "$612.07", change: "+0.4%", cause: "Clean water" },
] as const;

const CAUSE_ROWS = [
  { cause: "Wildlife rescue", tokens: 14, epoch: "4.82 ETH", votes: "38.1%" },
  { cause: "Clean water", tokens: 9, epoch: "3.15 ETH", votes: "24.9%" },
  { cause: "Girls' education", tokens: 7, epoch: "2.40 ETH", votes: "19.0%" },
  { cause: "Reforestation", tokens: 5, epoch: "1.21 ETH", votes: "9.6%" },
];

const ORDER_TYPES = [
  { value: "market", label: "Market" },
  { value: "limit", label: "Limit" },
  { value: "twap", label: "TWAP (soon)", disabled: true },
];

export function PrimitivesSection() {
  return (
    <GallerySection
      id="primitives"
      title="Primitives and overlays"
      intro="Form controls, menus and overlays on Radix, cmdk, vaul and Sonner, themed only through tokens. Every control has a 44px target, a visible focus ring, and motion that stops under reduced motion."
    >
      <FormsBlock />
      <ChoiceBlock />
      <NavigationBlock />
      <OverlayBlock />
      <SheetBlock />
      <CommandBlock />
      <FeedbackBlock />
      <DisplayBlock />
    </GallerySection>
  );
}

/* ---------------------------------------------------------------- forms -- */

function FormsBlock() {
  const [amount, setAmount] = useState("0.25");
  const [symbol, setSymbol] = useState("harambe!");
  const amountInvalid = !(Number(amount) > 0);
  const symbolInvalid = !/^[A-Z]{2,10}$/.test(symbol);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Specimen label="Input and field wiring" source="shadcn · Field: label, hint and error via aria-describedby / aria-invalid">
        <Field invalid={amountInvalid}>
          <FieldLabel>Amount to buy</FieldLabel>
          <InputGroup>
            <FieldControl>
              <Input inputMode="decimal" className="num" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </FieldControl>
            <InputAddon>ETH</InputAddon>
          </InputGroup>
          <FieldHint>90% of the trading fee funds this coin&apos;s cause; 10% runs Varada.</FieldHint>
          <FieldError>Enter an amount above 0.</FieldError>
        </Field>
        <Field invalid={symbolInvalid} required>
          <FieldLabel>Token symbol</FieldLabel>
          <FieldControl>
            <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} autoComplete="off" />
          </FieldControl>
          <FieldHint>2 to 10 capital letters, shown with a $.</FieldHint>
          <FieldError>Use 2 to 10 capital letters (A to Z) only.</FieldError>
        </Field>
        <Field disabled>
          <FieldLabel>Creator wallet</FieldLabel>
          <FieldControl>
            <Input className="num" defaultValue="0x7f3a…c21e" />
          </FieldControl>
          <FieldHint>Connect a wallet to change this.</FieldHint>
        </Field>
      </Specimen>

      <Specimen label="Textarea and select" source="shadcn · Select from 21st.dev @edwinvakayil/r-select (25349)">
        <Field>
          <FieldLabel>Why this cause?</FieldLabel>
          <FieldControl>
            <Textarea placeholder="A sentence or two for holders. Plain words." defaultValue="Every trade of $HARAMBE sends fees to gorilla sanctuaries." />
          </FieldControl>
          <FieldHint>Shown on the coin page. 280 characters.</FieldHint>
        </Field>
        <Field>
          <FieldLabel>Cause</FieldLabel>
          <Select defaultValue="wildlife">
            <FieldControl>
              <SelectTrigger>
                <SelectValue placeholder="Choose a cause" />
              </SelectTrigger>
            </FieldControl>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Launch focus</SelectLabel>
                {CAUSES.slice(0, 3).map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Catalogue</SelectLabel>
                {CAUSES.slice(3).map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
                <SelectItem value="paused" disabled>
                  Arts fund (paused)
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field invalid>
            <FieldLabel>Epoch</FieldLabel>
            <Select>
              <FieldControl>
                <SelectTrigger>
                  <SelectValue placeholder="Pick an epoch" />
                </SelectTrigger>
              </FieldControl>
              <SelectContent>
                <SelectItem value="12">Epoch 12 (open)</SelectItem>
                <SelectItem value="11">Epoch 11</SelectItem>
              </SelectContent>
            </Select>
            <FieldError>Pick an epoch to vote in.</FieldError>
          </Field>
          <Field disabled>
            <FieldLabel>Network</FieldLabel>
            <Select defaultValue="mainnet">
              <FieldControl>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
              </FieldControl>
              <SelectContent>
                <SelectItem value="mainnet">Ethereum mainnet</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </Specimen>
    </div>
  );
}

/* --------------------------------------------------------------- choice -- */

function ChoiceBlock() {
  const [slippage, setSlippage] = useState([0.5]);
  const [cap, setCap] = useState([40, 320]);
  const [range, setRange] = useState("24h");
  const [side, setSide] = useState("buy");

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Specimen label="Checkbox, radio, switch" source="21st.dev @skyleen77/radix-checkbox (1766) · @originui/radio-group (747) · @jshguo/interfaces-switch (11886)">
        <FieldSet>
          <FieldLegend>Before you launch</FieldLegend>
          <div className="flex items-start gap-3">
            <Checkbox id="ack-fees" defaultChecked />
            <Label htmlFor="ack-fees" className="font-normal">
              I understand 90% of trading fees go to the chosen cause
            </Label>
          </div>
          <div className="flex items-start gap-3">
            <Checkbox id="ack-lock" tone="cause" defaultChecked="indeterminate" />
            <Label htmlFor="ack-lock" className="font-normal">
              Lock liquidity in every pool (some chosen)
            </Label>
          </div>
          <div className="flex items-start gap-3">
            <Checkbox id="ack-off" disabled />
            <Label htmlFor="ack-off" className="font-normal">
              Allow creator sell-back (off at launch)
            </Label>
          </div>
        </FieldSet>
        <Separator />
        <RadioGroup defaultValue="pool" aria-label="Giving mode" className="sm:grid-cols-2">
          <RadioCard id="mode-pool" value="pool" tone="cause" title="Weekly pool" description="Holders vote privately each epoch on which causes share the pot." />
          <RadioCard id="mode-direct" value="direct" tone="cause" title="Direct to one cause" description="Every fee goes to the cause you pick now." />
        </RadioGroup>
        <RadioGroup defaultValue="market" aria-label="Order type" className="flex flex-wrap gap-5">
          {ORDER_TYPES.map((o) => (
            <div key={o.value} className="flex items-center gap-2.5">
              <RadioGroupItem id={`ot-${o.value}`} value={o.value} disabled={o.disabled} />
              <Label htmlFor={`ot-${o.value}`} className="font-normal">
                {o.label}
              </Label>
            </div>
          ))}
        </RadioGroup>
        <Separator />
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="sw-private">Private vote (FHE encrypted)</Label>
            <Switch id="sw-private" tone="cause" defaultChecked />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="sw-small">Hide balances under $1</Label>
            <Switch id="sw-small" />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="sw-off">Price alerts (needs notifications)</Label>
            <Switch id="sw-off" disabled />
          </div>
        </div>
      </Specimen>

      <Specimen label="Slider and segmented control" source="21st.dev @jshguo/interfaces-slider (11891) · @ddoemonn/segmented-control (23552)">
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-semibold" id="slip-label">
              Slippage tolerance
            </span>
            <span className="num text-sm text-ink-muted">{slippage[0]?.toFixed(1)}%</span>
          </div>
          <Slider aria-labelledby="slip-label" value={slippage} onValueChange={setSlippage} min={0.1} max={5} step={0.1} formatValue={(v) => `${v.toFixed(1)}%`} />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-semibold">Market cap</span>
            <span className="num text-sm text-ink-muted">
              ${cap[0]}k – ${cap[1]}k
            </span>
          </div>
          <Slider
            value={cap}
            onValueChange={setCap}
            min={0}
            max={500}
            step={10}
            tone="cause"
            thumbLabels={["Minimum market cap", "Maximum market cap"]}
            formatValue={(v) => `$${v}k`}
          />
        </div>
        <Slider aria-label="Disabled slider" defaultValue={[30]} disabled />
        <Separator />
        <div className="flex flex-col gap-3">
          <ToggleGroup aria-label="Order side" value={side} onValueChange={setSide} block>
            <ToggleGroupItem value="buy">Buy</ToggleGroupItem>
            <ToggleGroupItem value="sell">Sell</ToggleGroupItem>
          </ToggleGroup>
          <ToggleGroup aria-label="Chart range" value={range} onValueChange={setRange} size="sm">
            {["1H", "24H", "7D", "30D", "All"].map((r) => (
              <ToggleGroupItem key={r} value={r.toLowerCase()}>
                {r}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <ToggleGroup type="multiple" aria-label="Asset kinds" defaultValue={["meme", "stock"]} size="sm">
            <ToggleGroupItem value="meme">Memecoins</ToggleGroupItem>
            <ToggleGroupItem value="stock">Stocks</ToggleGroupItem>
            <ToggleGroupItem value="etf">ETFs</ToggleGroupItem>
            <ToggleGroupItem value="rwa" disabled>
              RWA
            </ToggleGroupItem>
          </ToggleGroup>
          <p className="text-sm text-muted-foreground">
            Showing <strong className="text-ink">{side}</strong> over <strong className="num text-ink">{range.toUpperCase()}</strong>.
          </p>
        </div>
      </Specimen>
    </div>
  );
}

/* ----------------------------------------------------------- navigation -- */

function NavigationBlock() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Specimen label="Tabs with animated indicator" source="21st.dev @ln-dev7/animated-navigation-tabs (575) on Radix Tabs">
        <Tabs defaultValue="trades">
          <TabsList aria-label="$HARAMBE activity">
            <TabsTrigger value="trades">Trades</TabsTrigger>
            <TabsTrigger value="holders">Holders</TabsTrigger>
            <TabsTrigger value="votes">
              <Vote aria-hidden="true" />
              Votes
            </TabsTrigger>
            <TabsTrigger value="about" disabled>
              About
            </TabsTrigger>
          </TabsList>
          <TabsContent value="trades" className="text-sm text-ink-soft">
            <span className="num">0x91…a2 bought 1.2M $HARAMBE for 0.42 ETH · 2m ago</span>
          </TabsContent>
          <TabsContent value="holders" className="text-sm text-ink-soft">
            1,284 holders · top 10 hold 18.2%
          </TabsContent>
          <TabsContent value="votes" className="text-sm text-ink-soft">
            Epoch 12 voting closes in 2 days. Ballots stay encrypted until the tally.
          </TabsContent>
        </Tabs>
        <Tabs defaultValue="buy" variant="pill">
          <TabsList aria-label="Trade panel">
            <TabsTrigger value="buy">Buy</TabsTrigger>
            <TabsTrigger value="sell">Sell</TabsTrigger>
            <TabsTrigger value="give">Give</TabsTrigger>
          </TabsList>
          <TabsContent value="buy" className="text-sm text-ink-soft">
            Swap NVDAon for $HARAMBE in its Uniswap v4 pool.
          </TabsContent>
          <TabsContent value="sell" className="text-sm text-ink-soft">
            Sell back to the curve; fees still fund the cause.
          </TabsContent>
          <TabsContent value="give" className="text-sm text-ink-soft">
            Donate straight to Wildlife rescue without trading.
          </TabsContent>
        </Tabs>
      </Specimen>

      <Specimen label="Dropdown menu" source="21st.dev @edwinvakayil/r-dropdown (24858), shadcn API">
        <CauseFilterMenu />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="soft" className="num self-start">
              <Wallet aria-hidden="true" />
              0x7f3a…c21e
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>Wallet</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => toast("Address copied", { description: "0x7f3a…c21e" })}>
              <Copy aria-hidden="true" />
              Copy address
              <DropdownMenuShortcut>⌘C</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <User aria-hidden="true" />
              My coins
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <HandHeart aria-hidden="true" />
                Giving history
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>This epoch</DropdownMenuItem>
                <DropdownMenuItem>All time</DropdownMenuItem>
                <DropdownMenuItem disabled>Export CSV (soon)</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive">
              <LogOut aria-hidden="true" />
              Disconnect
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <p className="text-sm text-muted-foreground">Arrow keys move, typing jumps to an item, Escape closes.</p>
      </Specimen>
    </div>
  );
}

function CauseFilterMenu() {
  const [picked, setPicked] = useState<string[]>(["wildlife", "water"]);
  const [sort, setSort] = useState("trending");
  const toggle = (v: string, on: boolean) => setPicked((p) => (on ? [...p, v] : p.filter((x) => x !== v)));
  return (
    <div className="flex flex-wrap items-center gap-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            <Filter aria-hidden="true" />
            Causes
            <Badge tone="cause" shape="pill" className="num px-2 py-0.5">
              {picked.length}
            </Badge>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Filter by cause</DropdownMenuLabel>
          {CAUSES.map((c) => (
            <DropdownMenuCheckboxItem
              key={c.value}
              checked={picked.includes(c.value)}
              onCheckedChange={(on) => toggle(c.value, on === true)}
              onSelect={(e) => e.preventDefault()}
            >
              {c.label}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Sort</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
            <DropdownMenuRadioItem value="trending">Trending</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="newest">Newest</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="raised">Most raised for causes</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="text-sm text-ink-soft">
        {picked.length ? picked.map((v) => CAUSES.find((c) => c.value === v)?.label).join(", ") : "All causes"} · {sort}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------- overlays -- */

function OverlayBlock() {
  const [slip, setSlip] = useState("0.5");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Specimen label="Dialog: connect wallet" source="21st.dev @reshaped/reshaped-modal (17821) rebuilt on Radix Dialog">
        <div className="flex flex-wrap gap-2">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="ink">
                <Wallet aria-hidden="true" />
                Connect wallet
              </Button>
            </DialogTrigger>
            <DialogContent size="sm">
              <DialogHeader>
                <DialogTitle>Connect a wallet</DialogTitle>
                <DialogDescription>Varada never holds your funds. Pick how you sign trades and votes.</DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                {["Browser wallet", "WalletConnect", "Coinbase Wallet"].map((w) => (
                  <DialogClose key={w} asChild>
                    <Button variant="outline" className="justify-between" onClick={() => toast.success(`${w} connected`, { description: "0x7f3a…c21e on Ethereum" })}>
                      {w}
                      <ArrowUpRight aria-hidden="true" />
                    </Button>
                  </DialogClose>
                ))}
              </div>
              <p className="text-sm text-muted-foreground">90% of trading fees fund causes and 10% runs the platform.</p>
            </DialogContent>
          </Dialog>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="cause">
                <Vote aria-hidden="true" />
                Confirm vote
              </Button>
            </DialogTrigger>
            <DialogContent size="sm" position="bottom">
              <DialogHeader>
                <DialogTitle>Cast your private vote?</DialogTitle>
                <DialogDescription>Your ballot is encrypted on-chain. Nobody sees it until the epoch tally.</DialogDescription>
              </DialogHeader>
              <div className="rounded-xl bg-sage-tint p-4 text-sm text-sage-ink">
                <strong>Wildlife rescue</strong> · weight <span className="num">12,480 $HARAMBE</span>
              </div>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="soft">Not yet</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button variant="cause" onClick={() => toast.success("Vote cast privately", { description: "Epoch 12 · Wildlife rescue" })}>
                    <ShieldCheck aria-hidden="true" />
                    Cast vote
                  </Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        <p className="text-sm text-muted-foreground">The vote dialog is a bottom sheet on phones and centred from the sm breakpoint.</p>
      </Specimen>

      <Specimen label="Popover, tooltip, hover card" source="shadcn Popover · 21st.dev @originui/tooltip (208) · @kuratlielia/hover-card (35045)">
        <div className="flex flex-wrap items-center gap-3">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="soft">
                <Settings2 aria-hidden="true" />
                Slippage <span className="num">{slip}%</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start">
              <PopoverHeader>
                <PopoverTitle>Slippage</PopoverTitle>
                <PopoverDescription>Your trade reverts if the price moves more than this.</PopoverDescription>
              </PopoverHeader>
              <div className="flex flex-col gap-3">
                <ToggleGroup aria-label="Preset slippage" value={["0.5", "1", "2"].includes(slip) ? slip : ""} onValueChange={setSlip} size="sm" block>
                  {["0.5", "1", "2"].map((v) => (
                    <ToggleGroupItem key={v} value={v} className="num">
                      {v}%
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <Field invalid={!(Number(slip) > 0) || Number(slip) > 5}>
                  <FieldLabel>Custom</FieldLabel>
                  <InputGroup>
                    <FieldControl>
                      <Input inputMode="decimal" className="num" value={slip} onChange={(e) => setSlip(e.target.value)} />
                    </FieldControl>
                    <InputAddon>%</InputAddon>
                  </InputGroup>
                  <FieldError>Use 0.1% to 5%. Higher invites front-running.</FieldError>
                </Field>
              </div>
            </PopoverContent>
          </Popover>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="How fees are split">
                <Info aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>90% of every trading fee funds causes; 10% runs Varada.</TooltipContent>
          </Tooltip>

          <HoverCard>
            <HoverCardTrigger asChild>
              <a href="#primitives" className="rounded-sm font-semibold text-primary underline underline-offset-4">
                harambe.creator.eth
              </a>
            </HoverCardTrigger>
            <HoverCardContent>
              <div className="flex gap-3">
                <Avatar>
                  <AvatarFallback>HC</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-col gap-1">
                  <strong className="truncate">harambe.creator.eth</strong>
                  <span className="text-sm text-ink-soft">Launched $HARAMBE · Wildlife rescue</span>
                  <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <dt className="text-muted-foreground">Raised for cause</dt>
                      <dd className="num font-semibold text-sage-ink">4.82 ETH</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Coins</dt>
                      <dd className="num font-semibold">3</dd>
                    </div>
                  </dl>
                </div>
              </div>
            </HoverCardContent>
          </HoverCard>
        </div>
        <p className="text-sm text-muted-foreground">Hover or focus the creator link; the card opens after half a second.</p>
      </Specimen>
    </div>
  );
}

/* ---------------------------------------------------------- sheet/drawer -- */

function SheetBlock() {
  const [amount, setAmount] = useState("0.1");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Specimen label="Sheet: side panels" source="21st.dev @kevingirelli/sheet (35214)">
        <div className="flex flex-wrap gap-2">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline">
                <SlidersHorizontal aria-hidden="true" />
                Filters
              </Button>
            </SheetTrigger>
            <SheetContent side="right">
              <SheetHeader>
                <SheetTitle>Filters</SheetTitle>
                <SheetDescription>Narrow the coin list.</SheetDescription>
              </SheetHeader>
              <SheetBody className="flex flex-col gap-5 py-2">
                <FieldSet>
                  <FieldLegend>Causes</FieldLegend>
                  {CAUSES.slice(0, 4).map((c) => (
                    <div key={c.value} className="flex items-center gap-3">
                      <Checkbox id={`sf-${c.value}`} tone="cause" defaultChecked={c.value === "wildlife"} />
                      <Label htmlFor={`sf-${c.value}`} className="font-normal">
                        {c.label}
                      </Label>
                    </div>
                  ))}
                </FieldSet>
                <div className="flex items-center justify-between gap-4">
                  <Label htmlFor="sf-live">Live donation coins only</Label>
                  <Switch id="sf-live" />
                </div>
              </SheetBody>
              <SheetFooter>
                <SheetClose asChild>
                  <Button>Show 42 coins</Button>
                </SheetClose>
              </SheetFooter>
            </SheetContent>
          </Sheet>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open menu">
                <Menu aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left">
              <SheetHeader>
                <SheetTitle>Varada</SheetTitle>
                <SheetDescription className="sr-only">Site navigation</SheetDescription>
              </SheetHeader>
              <SheetBody>
                <nav aria-label="Main">
                  <ul className="flex flex-col gap-1">
                    {["Explore coins", "Launch a coin", "Causes", "Vote", "How giving works"].map((l) => (
                      <li key={l}>
                        <SheetClose asChild>
                          <a href="#primitives" className="flex min-h-11 items-center rounded-lg px-3 font-semibold text-ink hover:bg-sand">
                            {l}
                          </a>
                        </SheetClose>
                      </li>
                    ))}
                  </ul>
                </nav>
              </SheetBody>
            </SheetContent>
          </Sheet>
        </div>
        <p className="text-sm text-muted-foreground">Right: filters with a sticky footer. Left: the phone navigation.</p>
      </Specimen>

      <Specimen label="Drawer: bottom sheet with handle" source="21st.dev @wensity/drawer (31360) on vaul">
        <Drawer>
          <DrawerTrigger asChild>
            <Button className="self-start">
              <Coins aria-hidden="true" />
              Buy $HARAMBE
            </Button>
          </DrawerTrigger>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>Buy $HARAMBE</DrawerTitle>
              <DrawerDescription>Drag down or press Escape to close.</DrawerDescription>
            </DrawerHeader>
            <DrawerBody className="flex flex-col gap-4">
              <Field invalid={!(Number(amount) > 0)}>
                <FieldLabel>You pay</FieldLabel>
                <InputGroup>
                  <FieldControl>
                    <Input inputMode="decimal" className="num text-lg" value={amount} onChange={(e) => setAmount(e.target.value)} />
                  </FieldControl>
                  <InputAddon>ETH</InputAddon>
                </InputGroup>
                <FieldHint>
                  You get about <span className="num">{Math.round(Number(amount) * 24_270_000 || 0).toLocaleString("en-US")}</span> $HARAMBE
                </FieldHint>
                <FieldError>Enter an amount above 0.</FieldError>
              </Field>
              <div className="rounded-xl bg-sage-tint px-4 py-3 text-sm text-sage-ink">90% of this trade&apos;s fee goes to Wildlife rescue.</div>
            </DrawerBody>
            <DrawerFooter>
              <DrawerClose asChild>
                <Button onClick={() => toast.success("Order sent", { description: `${amount} ETH for $HARAMBE` })}>Review order</Button>
              </DrawerClose>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
        <p className="text-sm text-muted-foreground">Mobile trade ticket. The close button is there for people who cannot drag.</p>
      </Specimen>
    </div>
  );
}

/* --------------------------------------------------------------- command -- */

function TokenItems({ onPick }: { onPick: (symbol: string) => void }) {
  const groups = [
    { heading: "Memecoins", meme: true },
    { heading: "Tokenised stocks and ETFs", meme: false },
  ];
  return (
    <>
      {groups.map((g, i) => (
        <div key={g.heading}>
          {i > 0 ? <CommandSeparator /> : null}
          <CommandGroup heading={g.heading}>
            {TOKENS.filter((t) => (t.kind === "meme") === g.meme).map((t) => {
              const down = t.change.startsWith("-");
              return (
                <CommandItem
                  key={t.symbol}
                  value={t.symbol}
                  keywords={[t.name, t.cause]}
                  onSelect={() => onPick(t.symbol)}
                  icon={
                    <Avatar size="sm">
                      <AvatarFallback className="text-[11px]">{t.symbol.replace("$", "").slice(0, 2)}</AvatarFallback>
                    </Avatar>
                  }
                  hint={`${t.name} · funds ${t.cause}`}
                  trailing={
                    <span className="flex flex-col items-end">
                      <span className="num text-sm">{t.price}</span>
                      <span className={`num text-xs ${down ? "text-loss" : "text-gain"}`}>
                        {down ? "▼" : "▲"} {t.change.slice(1)}
                      </span>
                    </span>
                  }
                >
                  <span className="font-semibold">{t.symbol}</span>
                  {t.kind === "stock" ? (
                    <Badge tone="stock" className="ml-2 py-0.5">
                      STOCK
                    </Badge>
                  ) : t.kind === "etf" ? (
                    <Badge tone="etf" className="ml-2 py-0.5">
                      ETF
                    </Badge>
                  ) : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
        </div>
      ))}
    </>
  );
}

function CommandBlock() {
  const [open, setOpen] = useCommandShortcut();
  const [last, setLast] = useState<string | null>(null);
  const pick = (symbol: string) => {
    setLast(symbol);
    setOpen(false);
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Specimen label="Command palette (dialog)" source="21st.dev @uvain/command-menu-palette (33510) on cmdk">
        <Button variant="outline" className="justify-between sm:w-80" onClick={() => setOpen(true)}>
          <span className="inline-flex items-center gap-2 text-ink-muted">
            <Search aria-hidden="true" />
            Search tokens and causes
          </span>
          <KbdGroup>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </Button>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {last ? (
            <>
              Opened <strong className="text-ink">{last}</strong>
            </>
          ) : (
            "Press ⌘K or Ctrl K anywhere on this page. Try “nvda”, “water” or “tiger”."
          )}
        </p>
        <CommandDialog open={open} onOpenChange={setOpen} title="Search Varada" placeholder="Search tokens, tickers or causes…" emptyText="No coins match. Try a cause name.">
          <TokenItems onPick={pick} />
          <CommandSeparator />
          <CommandGroup heading="Actions">
            <CommandItem icon={<Sparkles aria-hidden="true" />} shortcut="G L" onSelect={() => pick("Launch a coin")}>
              Launch a coin
            </CommandItem>
            <CommandItem icon={<Vote aria-hidden="true" />} shortcut="G V" onSelect={() => pick("Vote in epoch 12")}>
              Vote in epoch 12
            </CommandItem>
          </CommandGroup>
        </CommandDialog>
      </Specimen>

      <Specimen label="Command (inline)" source="21st.dev @uvain/command-menu-palette (33510)">
        <Command className="border border-line" loop>
          <CommandInput placeholder="Filter tokens…" aria-label="Filter tokens" />
          <CommandList className="max-h-64">
            <CommandEmpty>No coins match.</CommandEmpty>
            <TokenItems onPick={(s) => toast(`Selected ${s}`)} />
          </CommandList>
        </Command>
      </Specimen>
    </div>
  );
}

/* -------------------------------------------------------------- feedback -- */

function FeedbackBlock() {
  const [raised, setRaised] = useState(31.2);
  const [uploading, setUploading] = useState(false);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Specimen label="Toaster" source="21st.dev @isaiahbjork/primitive-sonner (27363) on Sonner">
        <Toaster />
        <div className="flex flex-wrap gap-2">
          <Button variant="cause" onClick={() => toast.success("Vote cast privately", { description: "Epoch 12 · Wildlife rescue" })}>
            Success
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              toast.error("Trade failed", {
                description: "Price moved more than your 0.5% slippage.",
                action: { label: "Retry", onClick: () => toast("Retrying…") },
              })
            }
          >
            Error with action
          </Button>
          <Button
            variant="soft"
            onClick={() =>
              toast.promise(new Promise((resolve) => setTimeout(resolve, 1600)), {
                loading: "Publishing coin page to Swarm…",
                success: "Live at harambe.varada.eth",
                error: "Publish failed",
              })
            }
          >
            Promise
          </Button>
          <Button variant="ghost" onClick={() => toast("Address copied", { description: "0x7f3a…c21e" })}>
            Plain
          </Button>
        </div>
      </Specimen>

      <Specimen label="Progress" source="21st.dev @ddoemonn/progress-bar (23549) on Radix Progress">
        <Progress
          value={raised}
          max={50}
          label="Live donation: next push to the charity"
          valueText={`${raised.toFixed(2)} / 50 USDC`}
          completeLabel="Sent to Rainforest Trust"
        />
        <Progress value={62} label="Epoch 12 cause pool target" tone="cause" />
        <Progress value={uploading ? null : 100} label="Swarm upload" pendingLabel="Uploading" tone="ink" size="sm" />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setRaised((r) => Math.min(50, r + 6.4))}>
            Simulate buys
          </Button>
          <Button size="sm" variant="soft" onClick={() => setRaised(31.2)}>
            Reset
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setUploading((u) => !u)}>
            {uploading ? "Finish upload" : "Start upload"}
          </Button>
        </div>
      </Specimen>

      <Specimen label="Skeleton" source="shadcn">
        <div aria-busy="true" className="flex flex-col gap-4">
          <span className="sr-only">Loading coins…</span>
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-11 rounded-full" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-2/5" />
                <Skeleton className="h-3 w-3/5" />
              </div>
              <Skeleton className="h-8 w-20 rounded-full" />
            </div>
          ))}
        </div>
      </Specimen>

      <Specimen label="Accordion" source="21st.dev @skyleen77/radix-accordion (1777)">
        <Accordion type="single" collapsible defaultValue="fees">
          <AccordionItem value="fees">
            <AccordionTrigger>Where do the trading fees go?</AccordionTrigger>
            <AccordionContent>90% of every trading fee goes to causes and 10% keeps Varada running. Payouts are on-chain and public.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="vote">
            <AccordionTrigger>Who can see my vote?</AccordionTrigger>
            <AccordionContent>No one. Ballots are encrypted with fully homomorphic encryption and only the epoch totals are revealed.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="stocks">
            <AccordionTrigger>What are NVDAon and SPYon?</AccordionTrigger>
            <AccordionContent>Tokenised stocks and ETFs issued by Ondo. Their trading fees fund causes the same way memecoins do.</AccordionContent>
          </AccordionItem>
        </Accordion>
      </Specimen>
    </div>
  );
}

/* --------------------------------------------------------------- display -- */

function DisplayBlock() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Specimen label="Table" source="shadcn" className="lg:col-span-2">
        <Table>
          <TableCaption>Epoch 12 cause pool, sample values.</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Cause</TableHead>
              <TableHead className="text-right">Coins</TableHead>
              <TableHead className="text-right">Raised this epoch</TableHead>
              <TableHead className="text-right">Vote share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {CAUSE_ROWS.map((r, i) => (
              <TableRow key={r.cause} data-state={i === 0 ? "selected" : undefined}>
                <TableCell className="font-semibold">{r.cause}</TableCell>
                <TableCell className="num text-right">{r.tokens}</TableCell>
                <TableCell className="num text-right">{r.epoch}</TableCell>
                <TableCell className="num text-right">{r.votes}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>Total</TableCell>
              <TableCell className="num text-right">35</TableCell>
              <TableCell className="num text-right">11.58 ETH</TableCell>
              <TableCell className="num text-right">91.6%</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </Specimen>

      <Specimen label="Avatar, separator, kbd" source="shadcn">
        <div className="flex flex-wrap items-center gap-4">
          <Avatar size="lg">
            <AvatarFallback>HA</AvatarFallback>
          </Avatar>
          <Avatar>
            <AvatarFallback className="bg-sage-tint text-sage-ink">WR</AvatarFallback>
          </Avatar>
          <Avatar size="sm">
            <AvatarFallback className="bg-stock-tint text-stock-ink">NV</AvatarFallback>
          </Avatar>
          <Separator orientation="vertical" className="h-10" />
          <AvatarGroup role="group" aria-label="Top donors: 3 shown, 41 more">
            {["AL", "MO", "JD"].map((n) => (
              <Avatar key={n} size="sm">
                <AvatarFallback>{n}</AvatarFallback>
              </Avatar>
            ))}
            <span className="num relative z-10 ml-3.5 text-sm text-ink-muted">+41</span>
          </AvatarGroup>
        </div>
        <Separator />
        <div className="flex flex-wrap items-center gap-4 text-sm text-ink-soft">
          <span className="inline-flex items-center gap-2">
            Search
            <KbdGroup>
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </KbdGroup>
          </span>
          <span className="inline-flex items-center gap-2">
            Buy <Kbd>B</Kbd>
          </span>
          <span className="inline-flex items-center gap-2">
            Close <Kbd>esc</Kbd>
          </span>
        </div>
      </Specimen>

      <Specimen label="Scroll area" source="shadcn">
        <ScrollArea className="h-56 rounded-xl border border-line">
          <ul className="flex flex-col p-2" aria-label="Cause catalogue">
            {[...CAUSES, ...CAUSES.map((c) => ({ value: `${c.value}-regional`, label: `${c.label} (regional)` }))].map((c, i) => (
              <li key={c.value} className="flex min-h-11 items-center justify-between rounded-lg px-3 hover:bg-sand">
                <span>{c.label}</span>
                {i < 3 ? (
                  <Badge tone="cause">
                    <Check aria-hidden="true" />
                    Launch focus
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        </ScrollArea>
      </Specimen>
    </div>
  );
}
