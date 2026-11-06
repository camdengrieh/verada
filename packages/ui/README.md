# @varada/ui

Varada's component library, styled for **Direction A · Paper & Pigment**: cotton-paper ground, terracotta
actions, sage for giving and voting, Fraunces / Instrument Sans / JetBrains Mono, painted art. Built on
shadcn/ui conventions with components adapted from 21st.dev. Every component and state is on the
`/design` page of the web app.

## Using it in an app

```css
/* the app's stylesheet */
@import "@varada/ui/styles.css";
@source "<relative path to>/packages/ui/src";
```

```tsx
import { Button } from "@varada/ui/components/ui/button";
import { TradePanel } from "@varada/ui/components/varada/trade-panel";
import { AssetProvider } from "@varada/ui/lib/assets";
```

- Add `transpilePackages: ["@varada/ui"]` in Next config (the package ships TypeScript source).
- Wrap pages in `AssetProvider` with a resolver for site-relative paths (`assets/...`). The site is served
  under `/bzz/<ref>/`, bzz subdomains and ENS gateways, so components never build absolute URLs
  themselves. In apps/web the resolver is `useRel()`.
- Fonts are self-hosted by the app: link `assets/fonts/fonts.css` (see `apps/web/src/app/design/layout.tsx`).
- Components are presentational. Data, links (`LinkComponent` props) and callbacks come from the app;
  nothing here fetches, reads the chain or loads third-party URLs.

## Layout

| Folder | What's in it |
|---|---|
| `src/styles.css` | Tokens (shadcn names plus Varada ones), Tailwind v4 theme, `num` and `kicker` utilities, animations, an evening-paper dark variant (`.dark`) |
| `src/components/ui/` | Primitives and overlays: button (with `effect` hovers), badge, card, divider (line, dashed, brush, ornament, labelled), input, field, select, checkbox, radio-group, switch, slider, toggle-group, tabs (underline, pill, brush, segmented, card, vertical; scrollable lists), tooltip (spring, cursor-follow, tap to open), info-tip (glossary "?"), rich-tooltip / FeeTooltip, avatar-tooltip-group, popover, hover-card, dropdown-menu, dialog, sheet, drawer (scaled background, snap points, paper), command, toaster, skeleton, progress, accordion, table, avatar, separator, scroll-area, kbd, icons |
| `src/components/data/` | Data and flow: data-table, stat-card, sparkline, price-chart, countdown, stepper, file-dropzone, copy-button, empty-state, activity-list |
| `src/components/motion/` | marquee, number-ticker, step-transition, confetti, loading-screen / PageLoader, ink-button, text-reveal, flip-words, decrypt-text, ink-text, scroll-reveal / ScrollWordReveal, scroll-progress, tilt-card, spotlight-card, animated-beam, orbit, animated-list, ink-ripple, dock |
| `src/components/mobile/` | bottom-tab-bar (raised Launch), mobile-header, mobile-search-sheet, swipe-row, mobile-trade-sheet, mobile-trades-sheet (trades and holders tabs), mobile-vote-sheet, mobile-pair-picker, filter-sheet, sticky-action-bar, token-carousel, pull-to-refresh |
| `src/components/varada/` | Shell and brand: site-header, logo-mark, privacy-pill, painted-image, watercolour (Wash, PaperGrain, BrushUnderline), hero-home / hero-token / hero-cause / hero-launch. Coins and trading: token-card, token-row, pair-chip, price-change, mode-badge, fee-split-bar, trade-panel (buy presets, sell percentages), tx-toast, trading-metrics-bar, kpi-tile, holder-distribution, buy-sell-pressure, volume-bars, activity-ticker, activity-feed. Trades and holders: trade-feed (live trade tape, TradeTicker strip), holders-table (top holders, contract tags), holder-insights (concentration verdict, holders vs supply by holding size). Pairs: quote-asset (crypto, stock, ETF, RWA model), quote-asset-card, quote-asset-list, pair-picker, asset-kind-badge, stock-logo, market-status, liquidity-meter, liquidity-panel, price-impact-ladder (stock-market-card / stock-market-list remain as aliases). Causes and giving: cause-icon, cause-chip, cause-pool-card, pool-meter, raised-counter, donation-goal, impact-breakdown, donation-timeline, cause-leaderboard. Voting: ballot-option, ballot-list, vote-flow-dialog, takeover-card, curator-agent-card. ENS: ens-name, ens-claim, ens-address, ens-profile-card, ens-record-list, subname-tree |
| `src/lib/` | `cn`, `AssetProvider` / `useAssetUrl` |

Each component file starts with a comment naming its source (`Adapted from 21st.dev @author/name (id N)`,
`shadcn/ui new-york`, or `Written for Varada`).

## Adding a component

1. Look on 21st.dev first (the team has paid access; the `21st` MCP server can search and retrieve
   components). shadcn's CLI and 21st.dev's install command both work from this folder, because
   `components.json` points their aliases at `@varada/ui/...`.
2. Adapt it: imports from `@varada/ui/...`, Radix via the unified `radix-ui` package, animation via
   `motion/react`, icons from `lucide-react`. Replace any colour with tokens; remove external URLs, fonts
   and images. Keep 44px touch targets, labels, visible focus, ≥4.5:1 text contrast and reduced-motion
   handling. No emoji as icons.
3. Add a header comment with the source, a demo in the matching `apps/web/src/app/design/sections/*.tsx`
   file, and a test in `test/`.

## Rules worth knowing

- Components lay out by their own width (Tailwind container queries: `@container` on the root, `@sm:`/`@md:`/`@lg:` inside), not the viewport. Give each one its width from its parent (a block, grid cell or `flex-1` item); an auto-width flex item shrinks to nothing.
- Quote-asset logos: `quoteAssetLogo(config, symbol, resolve)` in apps/web returns the stocks pack image when published, else the bundled stock or crypto mark; StockLogo falls back to letters.
- Mobile sheets take `inline` (render in place, non-modal) for previews: vaul always makes drawers modal underneath, so several open drawers would block each other.

- Gains and losses always carry ▲ / ▼ (and spoken text), not colour alone.
- `PriceChart` uses TradingView Lightweight Charts with its logo turned off, because the logo links
  off-site. The licence then requires the NOTICE text and a link to tradingview.com on a page users can
  see. The `/design` page has it; the site footer must carry the same credit once pages use the chart.
- Confetti, the loading screen, hover effects and drawer scaling all switch off under `prefers-reduced-motion`.
- The trade panel shows buy presets (asset amounts, or USD amounts converted when `payPriceUsd` is given) and sell percentages by default; pass `buyPresets={false}` / `sellPercents={false}` to hide them.
- Tailwind is pinned to 4.3.2: later releases need Node 20.19+ for their PostCSS plugin.

## Checks

```sh
pnpm --filter @varada/ui typecheck
pnpm --filter @varada/ui test
```
