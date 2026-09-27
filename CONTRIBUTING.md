# Contributing

## Development Setup

Use Bun 1.4.1+ (CI: 1.4.1), Node ^20.19.0 or >=22.12.0 for Vite 7,
and a running local Herdr server:

```bash
bun install --frozen-lockfile
bun run install-hooks
# Run in separate terminals:
bun run dev:server
bun run dev:web
```

Open <http://localhost:5173>. Vite proxies `/api`, `/ws`, and `/login` to the dev
bridge at `127.0.0.1:8788`; installed services and `start:server` default to 8787.

Keep the only lockfile (`bun.lock`) and shared tooling at root; runtime
dependencies belong in their web/server workspace. After changes, run root
`bun install` and commit manifests/lockfile.

## Validation

**Fresh checkout:** run `bun run typecheck` once to generate web assets needed by
process tests. Then use focused checks while iterating:

| Check | Command / limits |
| --- | --- |
| Format | `bun run format <paths...>` or `format:check`; omit paths for the whole repo. |
| Types | `bun run typecheck:quick` checks scripts/web/server without rebuilding assets or checking production bundles. |
| Lint | `bun run lint` runs Oxlint without a cache. Rule/scope regression checks: `bun test scripts/lint.test.ts`. |
| Tests | `bun test <path>`, `bun run test` (serial), or `bun run test:quick` (four workers). Both full-suite commands include unit and server integration tests. |
| Submission | `bun run precommit`: formatting, lint, full typechecks, and `test:quick`. |

Oxlint's explicit rules live in `.oxlintrc.json`; formatting stays in Biome.
Existing `eslint-disable` comments are supported, including unused-directive
warnings. Declare globals in the config rather than inline `/* global */`
comments. Duplicate parameters remain checked by `no-redeclare` or the parser;
legacy octal literals in non-module JavaScript have no dedicated lint check.

The installed `.githooks/pre-commit` runs the full gate: let it run when committing
rather than repeating it manually on the same revision. Without the hook, run
`bun run precommit` before committing. Further edits require revalidation; never
bypass the gate.

PR CI runs format/lint/types, site build, and the complete `test:quick` suite.
Automated tests do not launch Chrome or WebKit. Browser-specific focus, layout,
input, accessibility, and security enforcement require manual validation against
a real backend for affected changes:

- Check dialog focus/keyboard navigation, scaled layout, and HTML preview
  iframe/direct-navigation isolation, including workspace assets and CSP.

- On iOS Safari and Android Chrome, check keyboard opening/dismissal, IME,
  selection/copy while output streams, and short-landscape/scaled menu bounds.
  Check mixed mouse/touch input on actual hybrid hardware.
- Exercise connection recovery and profile controls, notification permission and
  delivery with the page closed, and settings/integration changes on the server.
- Check desktop focus after app switching, OS clipboard/rectangular selection,
  and responsiveness during sustained terminal output and real network latency.

Record device/browser and results in the PR. Passing unit and server integration
tests does not establish browser behavior or real-user-experience acceptance.

Workspace types: `bun run --filter thyra-web typecheck` or
`bun run --filter thyra-server typecheck` (builds web assets first).
Frontend changes also need `bun run build:web`; bundling needs `bun run build`.
For load-time work, `bun scripts/measure-first-load.ts` (not in CI) loads the built app in Chromium and WebKit through a throttled link against a throwaway Herdr server and reports time to the agent list and to terminal output, cold and warm.
It and `scripts/capture-screenshots.ts` load the pinned root `playwright-core` devDependency (set `PLAYWRIGHT_CORE_PATH=<dir>` to use another copy) and need its browsers in Playwright's cache: `bunx playwright-core install chromium webkit`.
Releases must package/inspect every supported archive/checksum; see
[builds](docs/DEPLOYMENT.md#build-a-standalone-executable) and
[release policy](AGENTS.md#release-notes).

## Style Organization

| Path under `web/src/` | Responsibility |
| --- | --- |
| `styles/tokens.css` | Theme variables and the geometry scale (`--ui-bar-height`, `--ui-row-height`, `--ui-control-height`, `--ui-token-height`) |
| `styles/heroui.css` | Tailwind v4 theme, HeroUI base and eager component styles, HeroUI-to-token variable mapping |
| `styles/ui.css` | `.ui-bar` and `@layer thyra` tuning of the eager primitives in `components/ui/`; other wrappers co-locate their sheet (`ui/fields.css`, `ui/overlays/overlays.css`) |
| `styles/base.css` | Resets/shared primitives: modals, forms, badges, statuses, panels, loading |
| `styles/vendor.css` | Vendor overrides the first screen needs; syntax/diff styles load with their lazy consumers (e.g. `components/CodePreview.css`) |
| `styles/layout/*.css` | App-shell regions, imported once by `App.tsx` |
| `components/<Name>.css` | Component-owned styles, imported/deleted with the component; same for `components/ui/` |

The UI is square and borderless: no rounded corners and no boxed outlines.
Surfaces separate by tone, with a single 1px divider only where two surfaces of the same tone meet; fields and buttons read through fill, not borders.
`scripts/check-web-style.test.ts` enforces this, including Tailwind classes in `.tsx` (`rounded-*`, `shadow-*`, `border`/`border-<n>`, `ring-*`, `outline-<n>`; only the `-none`/`-0` forms pass).
Build chrome from [`components/ui/`](#ui-components) instead of new per-component control CSS; every bar uses `--ui-bar-height` and every chip is a `Token`.

Prefix classes with the component name; keep media queries beside their rules,
not in a separate mobile stylesheet. Shell/Suspense fallback styles must load
before lazy content. Independently loaded features need explicit shared imports
or global base styles; never depend on another feature having opened. Shared
co-located CSS is valid when static imports cover every rendering path.

The first screen (app shell, switchers, active terminal) is budgeted by `scripts/check-web-assets.mjs`.
Menus, dialogs, pickers and panels load on first use through `lazyPanel` (`web/src/lazyWithReload.ts`) behind `LazyBoundary`/`Latched` (`components/LazyBoundary.tsx`); their triggers and the styles those need stay eager.
Add likely-next surfaces to the idle prefetch list in `App.tsx`.

## UI Components

`web/src/components/ui/` is the only place for controls, overlays, and chips.
It uses HeroUI v3's design system (component CSS in `styles/heroui.css`, themed from `styles/tokens.css`) with React Aria for behaviour, in two tiers chosen for first-load size:

- **Inline controls are native elements with HeroUI classes.** They load no React Aria runtime, so they are free in the always-loaded shell (HeroUI's React `Button` alone adds about 26 KiB gzip to the entry).
- **Overlays use React Aria and load lazily.** Each wrapper is a small eager shell; the implementation and its CSS live in one lazy chunk (`ui/overlays/`, loaded by `ui/lazyOverlays.ts`) fetched when an overlay first opens, or prefetched when its trigger is hovered or focused.

The overlay chunk renders React Aria components with HeroUI's class names instead of importing `@heroui/react`: HeroUI's React layer pulls `tailwind-variants` with a bundled tailwind-merge (about 12 KiB gzip) for no styling benefit here.

| Component | API summary |
| --- | --- |
| `Button` | Native `<button>`. `variant`: `ghost` (default), `secondary`, `primary`, `danger`, `danger-soft`; `size`: `sm` (`--ui-control-height`, default), `md` (dialog actions); `icon`; `fullWidth`; `aria-pressed` shows the toggled state. |
| `IconButton` | `label` (required: aria-label and tooltip), `icon`, `tone="danger"`, `tooltip` (string or `false`). The delegated `GlobalTooltip` shows the tooltip through `data-tooltip`. |
| `CloseButton` | `IconButton` with an X; `label` defaults to `t("Close")`. |
| `Tooltip` | `content` (ReactNode), one ref-forwarding child, `placement`. Hover after a shared delay or keyboard focus, never touch. For rich tooltips; plain text on buttons goes through `IconButton`/`data-tooltip`. |
| `SegmentedControl` | `value`, `options`, `onChange(value)`, `aria-label`, `stretch`. |
| `Token` | `tone` (`neutral`, `accent`, `info`, `success`, `warning`, `danger`), `code`, `icon`, `as="button"` for pressable tokens. |
| `Kbd`, `Spinner` | `<Kbd>Ctrl+K</Kbd>`; `<Spinner size tone label>` (`label` makes it a status). |
| `Switch` | `checked`, `onChange(checked)`, children label or `aria-label`, `description`, `disabled`, `labelPosition="start"` for settings rows. |
| `Checkbox` | `checked`, `onChange(checked)`, `indeterminate`, `invalid`, `description`. |
| `TextField`, `TextArea` | Every native input/textarea prop plus `label`, `description`, `error` (message or `true`), `fullWidth`, `onValueChange(value)`. `className` styles the wrapper; the ref is the native element. |
| `SearchField` | `value`, `onValueChange`, leading icon, clear button; Escape clears, then propagates when empty. |
| `Tabs` | `value`, `onChange(id)`, `items` (`id`, `label`, `icon`, `disabled`), `aria-label`, optional panel `children`. Arrows, Home, and End select. |
| `Select` | Superset of `ThemedSelect`: `value`, `options` (`label`, `description`, `icon`, `disabled`), `onChange(value)`, `aria-label` or `label`, `icon`, `align`, `variant="ghost"`. |
| `Menu` (`DropdownMenu`) | `trigger` (a `Button`/`IconButton`), `items`: `MenuItem` (`id`, `label`, `icon`, `shortcut`, `description`, `danger`, `disabled`, `checked`, `onAction`) or sections (`title`, `danger`, `selectionMode`, `items`); items with `checked` are announced as `menuitemcheckbox` (or `menuitemradio` with `selectionMode: "single"`), `header`, `placement`, `onAction(id)`, optional `open`/`onOpenChange`. |
| `ContextMenu` | Same items; `position` (`{x, y}` from the event, `null` closes), `onClose`. Flips and shifts into the viewport and restores focus. |
| `Popover` | `trigger`, `children` (or `(close) => children`), `aria-label`, `placement`; a non-modal panel with role `dialog`. |
| `Dialog` | `open`, `onOpenChange`, `title`, `description`, children (body), `footer`, `size` (`sm`, `md`, `lg`, `full`), `dismissable`, `keyboardDismissable`, `closeButton`, `onSubmit` (wraps body and footer in a form, default prevented), `headerStart`, `headerActions`, `placement="side"` (full-height end panel, a drawer), `busy`. A bottom sheet in the mobile layout. |
| `ConfirmDialog` | `open`, `onOpenChange`, `title`, `message`, `confirmLabel`, `cancelLabel`, `tone="danger"`, `onConfirm` (may return a promise; a rejection keeps it open), `initialFocus` (`cancel` default, or `confirm`). |
| `ToastRegion`, `toast` | Render `<ToastRegion />` once. `toast.show({title, description, tone, loading, action})`, `toast.info/success/warning/danger(title, content?, options?)`, `toast.update(id, patch, {timeout})`, `toast.close(id)`. `ui/toastQueue.ts` has no React runtime, so the store can call it. |

Conventions:

- **Events.** Native-element components keep DOM props and events (`onClick`, `onKeyDown`, `onChange(event)`), so `stopPropagation()` and `preventDefault()` work as before; nothing exposes React Aria's `onPress`. Components that pick a value report the value: `onChange(value)` for `SegmentedControl`, `Switch`, `Checkbox`, `Select`, and `Tabs`; `onAction` for menu items; `onValueChange` on text fields.
- **Refs.** `Button`, `IconButton`, `CloseButton`, `TextField`, `TextArea`, and `SearchField` forward refs to the native element. `Menu`, `Popover`, and `Tooltip` clone their trigger and merge its `ref`, `onClick`, `onKeyDown`, `onFocus`, and pointer handlers, so a trigger must be one element that forwards its ref and spreads DOM props.
- **State.** Values are controlled. Overlays take `open` and `onOpenChange` (`ContextMenu`: `position` and `onClose`); `Menu` and `Popover` may also run uncontrolled.
- **Text.** Callers pass translated strings; wrappers add only `t()` defaults (Close, Cancel, Clear search, Notifications, Dismiss notification).
- **Lazy loading.** Import overlays from anywhere; they cost a few hundred bytes until opened. Import `react-aria-components` only inside `ui/overlays/`, and do not import `@heroui/react` in new code. Check `bun run build:web` (initial JS gzip, initial CSS, file count) when adding a wrapper.
- **CSS.** HeroUI rules live in `@layer components`; Thyra tuning goes in `@layer thyra`, above components and below Tailwind utilities. `tokens.css` declares the layer order first, so lazily loaded sheets slot in correctly. A wrapper that needs another HeroUI stylesheet imports it from its own sheet, which starts with `@reference` to `styles/heroui.css`. `@reference` emits no theme variables, so add any `var(--...)` the new sheet needs to the `@theme static` block in `heroui.css`. Unlayered legacy rules beat every layer: delete a screen's per-control CSS when migrating it.
- **Gallery.** Run `bun run dev:web` and open `/ui-gallery.html?theme=light&layout=mobile&accent=teal` (`web/src/uiGallery.tsx`, dev-only). Check both themes and both layouts.

Migrating a screen:

1. A raw `<button>` becomes `Button`: the default filled look is `variant="secondary"`, `.ghost` is the default `ghost`, `.danger` is `danger-soft`, and a dialog's primary action is `variant="primary" size="md"`. Icon-only buttons become `IconButton` with a `label`; drop their `title`.
2. Hand-written `.modal-backdrop`/`.modal` markup with manual Escape, focus, and backdrop handling becomes `Dialog` or `ConfirmDialog`; delete the listeners and the `dialogFocus` calls it replaces.
3. Floating menus (`ActionsMenu`, `.context-menu`, file menus) become `Menu` or `ContextMenu` with item objects; delete outside-click, arrow-key, and viewport-clamping code.
4. `.settings-switch` buttons become `Switch`, `.check-row` inputs `Checkbox`, `ThemedSelect` `Select` (same props), hand-rolled tab strips `Tabs`, and `.form-field` inputs `TextField`.
5. Remove the replaced CSS rules, then verify in the gallery and the app.

## Pages Website and Tutorial

Edit `site/` for the landing page; **only `docs/TUTORIAL.md`** for tutorial text.
`scripts/build-pages.ts` renders the tutorial template, rewrites references, and
checks links/fragments in `.pages-dist/`:

```bash
bun test scripts/pages-content.test.ts scripts/pages-workflow.test.ts
bun run build:site
```

Serve `.pages-dist/` to check `/tutorial/`, narrow layouts, keyboard navigation,
and JavaScript-disabled reading. Canonical/social/sitemap URLs use
<https://thyra.yubo.fun/>. Never commit generated output.

### Product screenshots

Every screenshot in the READMEs, `FEATURES.md`, `docs/`, and the site comes from one command:

```bash
bun run build:web
bun scripts/capture-screenshots.ts [--only desktop-changes,mobile-launcher] [--port 8820]
```

It seeds the demo in `scripts/demo/` (Git projects, fake `claude`/`codex` agents, session files, launcher pins) into a throwaway Herdr server and Thyra on a spare port, captures desktop and phone shots in English and Chinese with Playwright WebKit, and writes optimized PNGs plus the site's hero AVIFs.
It never touches a live Herdr and stops everything it started; `--serve` keeps the demo running for inspection instead.
It needs `vips` and Playwright's WebKit build (`bunx playwright-core install webkit`); with `bwrap` installed the demo home appears as `/home/demo`.
Rerun it after visible UI changes and look at every image before committing.

**Deploy Pages** runs on `main` pushes or manual retry. Upload requires a published
Thyra release as GitHub Latest; the installer probe blocks missing assets,
HTTP/network failures, and source-only builds. After repo renames, align the
site installer URL and workflow probe.

## Pull Requests

Use focused imperative commits. PRs describe behavior, verification, and
compatibility impact. Screenshots are not required for UI changes; capture or
upload them only when explicitly requested. Do not commit screenshots solely for
PR review. Keep generated assets/binaries out of Git.

Unlabeled PRs receive `documentation`, `dependencies`, `bug` (fix titles), or
`enhancement`; release preparation uses `skip-changelog`. Override with a
`.github/release.yml` category before merging. Contributions are MIT-licensed.
