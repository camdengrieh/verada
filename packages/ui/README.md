# @verada/ui

Varada's component library, styled for **Direction A · Paper & Pigment**: cotton-paper ground, terracotta
actions, sage for giving and voting, Fraunces / Instrument Sans / JetBrains Mono, painted art. Built on
shadcn/ui conventions with components adapted from 21st.dev. Every component and state is on the
`/design` page of the web app.

## Using it in an app

```css
/* the app's stylesheet */
@import "@verada/ui/styles.css";
@source "<relative path to>/packages/ui/src";
```

```tsx
import { Button } from "@verada/ui/components/ui/button";
import { TradePanel } from "@verada/ui/components/varada/trade-panel";
import { AssetProvider } from "@verada/ui/lib/assets";
```

- Add `transpilePackages: ["@verada/ui"]` in Next config (the package ships TypeScript source).
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
| `src/components/ui/` | Primitives and overlays: button, badge, card, input, field, select, checkbox, radio-group, switch, slider, toggle-group, tabs, tooltip, popover, hover-card, dropdown-menu, dialog, sheet, drawer, command, toaster, skeleton, progress, accordion, table, avatar, separator, scroll-area, kbd, icons |
| `src/components/data/` | Data and flow: data-table, stat-card, sparkline, price-chart, countdown, stepper, file-dropzone, copy-button, empty-state, activity-list |
| `src/components/motion/` | marquee, number-ticker, step-transition |
| `src/components/varada/` | Varada-only: site-header, logo-mark, token-card, token-row, pair-chip, stock-logo, cause-icon, cause-chip, asset-kind-badge, mode-badge, price-change, fee-split-bar, trade-panel, liquidity-panel, cause-pool-card, ballot-option, ballot-list, vote-flow-dialog, curator-agent-card, takeover-card, activity-ticker, activity-feed, privacy-pill, watercolour (Wash, PaperGrain, BrushUnderline), painted-image |
| `src/lib/` | `cn`, `AssetProvider` / `useAssetUrl` |

Each component file starts with a comment naming its source (`Adapted from 21st.dev @author/name (id N)`,
`shadcn/ui new-york`, or `Written for Varada`).

## Adding a component

1. Look on 21st.dev first (the team has paid access; the `21st` MCP server can search and retrieve
   components). shadcn's CLI and 21st.dev's install command both work from this folder, because
   `components.json` points their aliases at `@verada/ui/...`.
2. Adapt it: imports from `@verada/ui/...`, Radix via the unified `radix-ui` package, animation via
   `motion/react`, icons from `lucide-react`. Replace any colour with tokens; remove external URLs, fonts
   and images. Keep 44px touch targets, labels, visible focus, ≥4.5:1 text contrast and reduced-motion
   handling. No emoji as icons.
3. Add a header comment with the source, a demo in the matching `apps/web/src/app/design/sections/*.tsx`
   file, and a test in `test/`.

## Rules worth knowing

- Gains and losses always carry ▲ / ▼ (and spoken text), not colour alone.
- `PriceChart` uses TradingView Lightweight Charts with its logo turned off, because the logo links
  off-site. The licence then requires the NOTICE text and a link to tradingview.com on a page users can
  see. The `/design` page has it; the site footer must carry the same credit once pages use the chart.
- Tailwind is pinned to 4.3.2: later releases need Node 20.19+ for their PostCSS plugin.

## Checks

```sh
pnpm --filter @verada/ui typecheck
pnpm --filter @verada/ui test
```
