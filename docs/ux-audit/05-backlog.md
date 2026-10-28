# Implementation backlog — Jingler redesign

Draft GitHub issue backlog for `iammorganparry/jingler`. **Nothing is filed yet.** Each `###` block becomes one PR-sized sub-issue; each `## Epic` becomes an epic issue linking its sub-issues.

Companion docs: `03-redesign-spec.md` (what), `04-coverage-matrix.md` (code to board), `06-flow-gaps.md` (gaps `F<flow>-<n>`), `07-dev-notes.md` (per-board notes). Boards live in Paper file https://app.paper.design/file/01M4K9KPAEC70CQCJ6P8MPARJN, page "02 · Improved".

**Source path prefixes:** `ui:` = `packages/ui/src/`, `desk:` = `apps/desktop/src/renderer/` (`desk:main/…` = `apps/desktop/src/main/`), `core:` = `packages/core/src/`, `cli:` = `packages/cli-adapters/src/`, `contracts:<n>` = line `<n>` of `packages/contracts/src/index.ts`. Line numbers come from 06/07 and drift; re-check before starting.

**Rules for every issue** (AGENTS.md): never hardcode colours (use `--sb-*` tokens); renderer state with 3+ coupled pieces is an XState `*-machine.ts` with a `*.test.ts`; every user-facing feature ships a Playwright `_electron` spec under `apps/desktop/e2e/` (run locally with `pnpm --filter @jingler/desktop e2e`).

## Summary

| Epic | Title | Sub-issues | Types |
|---|---|---|---|
| 1 | Design tokens & theme | 5 | style 5 |
| 2 | Component library (atoms and molecules) | 16 | component 16 |
| 3 | App shell | 11 | feature 9, style 2 |
| 4 | Copilot layout | 10 | feature 10 |
| 5 | Composer & transcript | 15 | feature 9, style 6 |
| 6 | Changes, Checks & PRs | 28 | feature 25, style 3 |
| 7 | Plans, explanation & agent asks | 9 | bug 1, feature 5, style 3 |
| 8 | Subagent fleet, browser preview & terminal | 12 | feature 12 |
| 9 | Entry flow (login, onboarding, home, new workspace) | 8 | feature 8 |
| 10 | Settings, provider auth and import | 20 | feature 11, style 9 |
| 11 | Usage & analytics | 3 | feature 3 |
| 12 | Notifications & needs-you | 5 | feature 5 |
| 13 | System states & recovery | 11 | feature 10, style 1 |
| 14 | Data model & RPC changes | 12 | data-model 12 |
| 15 | Bug fixes | 9 | bug 9 |
| | **Total** | **174** | |

## Suggested build order

1. **Epic 1** tokens and button/badge rules (1.1 → 1.3 first; everything else reads these).
2. **Epic 2** atoms (2.1–2.9), then molecules (2.10–2.16). Toast (2.4) unblocks 5.7, 8.7, 12.4, 15.9.
3. **Epic 15** bug fixes with no dependencies (15.1, 15.2, 15.5, 15.6, 15.7, 15.8) can ship in parallel from day one.
4. **Epic 14** data model (14.1, 14.5, 14.6, 14.7 first) before the features that read them.
5. **Epic 3** shell, then **Epic 4** copilot layout (4.1 machine first).
6. **Epics 5–8** feature surfaces in parallel (composer, review/PR, plans, fleet).
7. **Epics 9–11** entry flow, settings, usage.
8. **Epics 12–13** notifications and system states last (they depend on toasts, banners and most of the above).

## Product decisions

Decided 2026-10-11: **D1 optional**, **D2 replace**, **D3 keep as context menu**, **D4 Jingler creates/restacks layer branches**.

| Id | Question | Issues |
|---|---|---|
| D1 | Is the sign-in wall mandatory, or does the app run signed out (`App.tsx:2116`, F1-15)? | 9.1, 9.2, 13.7, 15.4 |
| D2 | Does Graphite replace the default theme, ship as an added theme, or added-and-default? | 1.1, 1.5, 10.10 |
| D3 | Keep `Workspace.revertFile` as right-click "Discard file changes", or remove it (F2-08)? | 6.2 |
| D4 | Is the stacked-PR layer branch created by Jingler (needs `Github.restack`) or by the agent (F3-02)? | 6.8, 6.10, 14.1, 14.2 |

Open engineering questions (not product decisions) are written inline as "Open question" in the issue that owns them.

---

## Epic 1 — Design tokens & theme

### 1.1 Add Graphite palette and neutral-primary tokens
- **Type:** style · **Board(s):** 00 · **Spec:** §2, §6.10 · **Gaps:** — · **Source:** `ui:globals.css:82` (canvas), `ui:globals.css:87` (`--sb-border`), `ui:globals.css:137` (`--sb-brand`), `packages/themes/src/map.ts` (brand chain, comment at `ui:globals.css:125`)
- **Scope:**
  - Add `--sb-primary-fill`, `--sb-primary-fg`, `--sb-primary-hover`, `--sb-primary-disabled` and `--sb-state-working/needs/ready/failed` (alias `--sb-blue/yellow/green/red`).
  - Set Graphite values for canvas, sunken, panel, surface and the three text levels; make `--sb-border` lighter than the surface.
  - Derive the new tokens in `map.ts` so imported VS Code themes and `jingler-light` still render.
  - Restrict `--sb-brand` to the mark, focus ring, selection and drop zone.
- **Acceptance:**
  - [ ] Every new token exists for both bundled dark themes and `jingler-light`.
  - [ ] An imported VS Code theme still produces a legible primary button and border.
  - [ ] No component hardcodes a hex value for the new tokens.
- **Tests:** extend `packages/themes/src/map.test.ts`; e2e extend `apps/desktop/e2e/branding.spec.ts`.
- **Depends on:** —
- **Decided:** D2 — Graphite replaces the default theme; the old default theme is removed.

### 1.2 Switch Button primary to the neutral fill and migrate call sites
- **Type:** style · **Board(s):** 00, all · **Spec:** §6.10 · **Gaps:** — · **Source:** `ui:components/button.tsx:12` (primary is `bg-brand text-white`), `ui:components/button.tsx:14` (danger)
- **Scope:**
  - Primary uses `--sb-primary-*`; secondary is transparent with a 1px border; danger is red text on transparent.
  - A solid red fill is allowed only for the last button of a ConfirmDialog (prop on `ConfirmDialog`, see 2.10).
  - `rg 'variant="primary"|bg-brand'` and fix call sites that assumed a rose fill.
  - Update `button.stories.tsx`.
- **Acceptance:**
  - [ ] No primary button renders rose or red in any story.
  - [ ] Disabled primary shows the disabled token and grey text.
  - [ ] Focus ring is the only rose element on a focused button.
- **Tests:** new `ui:components/button.test.tsx` for variant classes; e2e extend `branding.spec.ts`.
- **Depends on:** 1.1

### 1.3 Make Badge, Pill, Kbd and chips one line
- **Type:** style · **Board(s):** 00, 18b, 09 · **Spec:** §6.4 · **Gaps:** — · **Source:** `ui:components/badge.tsx:38`, `ui:components/pill.tsx:35`, `ui:components/kbd.tsx:16` (Button already has nowrap at `ui:components/button.tsx:8`)
- **Scope:**
  - Add `whitespace-nowrap shrink-0` to Badge, Pill and Kbd.
  - Audit chip usages (`Subscription`, `API key`, runtime chips in Usage) so the neighbouring text truncates instead.
  - Add a story with a 120px-wide container proving no wrap.
- **Acceptance:**
  - [ ] Badge, Pill and Kbd never wrap in a 120px container.
  - [ ] Usage table badges stay on one line at 1100px window width.
- **Tests:** `ui:components/badge.test.tsx` asserting the class set; story snapshot.
- **Depends on:** —

### 1.4 Remove traffic-light colour from status lists
- **Type:** style · **Board(s):** 06, 09d, 09h, 16c, 18b · **Spec:** §6.3 · **Gaps:** — · **Source:** `ui:components/callout.tsx:41`, `ui:components/status-dot.tsx:24`, `ui:composites/settings-view.tsx:566` (device status pills), `ui:composites/pr-side-panel.tsx:232` (`bg-green` callout)
- **Scope:**
  - Colour is kept only for failure icons and the sidebar workspace dot; other statuses use `StatusRow` (2.5).
  - Replace `bg-green/10 text-green` pills in Devices, MCP health, import result, checks and usage limits.
  - Callout tone `success`/`warning` render neutral body with a neutral icon.
- **Acceptance:**
  - [ ] No list row has a green or yellow fill; only failure shows a red icon.
  - [ ] Sidebar workspace status dot is unchanged.
- **Tests:** update affected `*.test.tsx`; e2e extend `remote-environments.spec.ts`, `mcp-import-dialog.spec.ts`.
- **Depends on:** 1.1, 2.5

### 1.5 Apply the 11/12/13/15/20 type scale and 6/8/12 radii
- **Type:** style · **Board(s):** 00 · **Spec:** §2 · **Gaps:** — · **Source:** `ui:globals.css`, files with `text-[8.5px]`..`text-[11.5px]` (`rg 'text-\[\d+(\.\d+)?px\]' packages/ui/src`)
- **Scope:**
  - Define the scale and radius tokens once in `globals.css`.
  - Replace arbitrary sizes only in files touched by other issues in this backlog; no repo-wide sweep.
  - Keep `text-size.spec.ts` green (font-size setting still scales).
- **Acceptance:**
  - [ ] Scale and radius tokens exist and are documented in `globals.css`.
  - [ ] Font-size setting still scales every token-based size.
- **Tests:** e2e extend `apps/desktop/e2e/text-size.spec.ts`.
- **Depends on:** 1.1
- **Decided:** D2 — Graphite replaces the default theme; the old default theme is removed.

---

## Epic 2 — Component library (atoms and molecules)

### 2.1 Build IconButtonGroup
- **Type:** component · **Board(s):** 21, 04g · **Spec:** §6.9 · **Gaps:** — · **Source:** `ui:components/button-group.tsx:21`, `ui:app/preview-dock.tsx:136`
- **Scope:**
  - Segmented group of icon buttons with shared border, tooltips and `aria-label`s.
  - Support pressed state (device widths) and disabled (back/forward).
  - Story with the browser toolbar composition.
- **Acceptance:**
  - [ ] Group renders as one bordered unit; buttons are keyboard reachable with arrows.
  - [ ] Every button has a tooltip and accessible name.
- **Tests:** `ui:components/button-group.test.tsx`; story.
- **Depends on:** 1.2

### 2.2 Build SearchField and FilterChips
- **Type:** component · **Board(s):** 04l, 09i, 24a, 19a, 19b · **Spec:** §3e, §6.7 · **Gaps:** — · **Source:** `ui:components/search-input.tsx`, `ui:components/filter-menu.tsx`, `ui:components/chip-menu.tsx`
- **Scope:**
  - `SearchField` with clear button, `⌘F`-style hint slot and debounce prop.
  - `FilterChips` single-select row with counts (`All · Changed 12 · PR #482`), one line each.
  - Reuse `chip-menu` keyboard handling.
- **Acceptance:**
  - [ ] Chips never wrap; the row scrolls horizontally when crowded.
  - [ ] Counts update when the data changes without remounting.
- **Tests:** `search-field.test.tsx`, `filter-chips.test.tsx`.
- **Depends on:** 1.3

### 2.3 Restyle SegmentedControl to the 28px spec
- **Type:** component · **Board(s):** 04l, 15, 09b · **Spec:** §3e · **Gaps:** — · **Source:** `ui:components/segmented-control.tsx:11`, `ui:app/session-sidebar.tsx:833` (Sessions | Explorer grid-cols-2)
- **Scope:**
  - 28px height, 6px radius, active segment on `--sb-surface`.
  - Replace the ad-hoc grid toggle in the sidebar with the shared control.
  - Support a size prop so Subscription / API key (15) shares it.
- **Acceptance:**
  - [ ] Sidebar toggle uses the shared component with no custom classes.
  - [ ] Arrow keys move selection.
- **Tests:** `ui:components/segmented-control.test.tsx`.
- **Depends on:** 1.1

### 2.4 Build Toast, ToastRegion and toast-machine
- **Type:** component · **Board(s):** 24b, 14, 24b+ · **Spec:** §5g · **Gaps:** F4-07 · **Source:** none today (`rg -i toast` finds only comments at `desk:auto-route.ts:83`, `desk:active-session.ts:15`)
- **Scope:**
  - `Toast` variants: success, error with `Retry`, "Needs you" with `Jump`, plain info.
  - `toast-machine.ts`: queue max 3, 6 s auto-dismiss, pause on hover, `Esc` dismisses, dedupe by key.
  - `ToastRegion` mounted once in the app shell, bottom-right.
  - Skip toasts for the session the user is already viewing (rule in `desk:active-session.ts:15`).
- **Acceptance:**
  - [ ] A fourth toast evicts the oldest; hover pauses the timer.
  - [ ] No toast fires for the active session.
  - [ ] Action buttons are keyboard reachable.
- **Tests:** `desk:toast-machine.test.ts` (createActor, node env); e2e new `apps/desktop/e2e/toasts.spec.ts`.
- **Depends on:** 1.2

### 2.5 Build StatusRow and Stepper
- **Type:** component · **Board(s):** 06, 09d, 09h, 16c, 02 · **Spec:** §6.3, §5b · **Gaps:** — · **Source:** `ui:components/status-dot.tsx:24`, `ui:screens/setup-screen.tsx:104` ("1 of 2" eyebrows)
- **Scope:**
  - `StatusRow`: neutral icon + `--sb-muted` text; `failed` prop swaps in a red icon only.
  - `Stepper`: 3 numbered steps with done/current/upcoming.
  - Stories for all states.
- **Acceptance:**
  - [ ] Only the failed variant introduces colour.
  - [ ] Stepper announces the current step to screen readers.
- **Tests:** `status-row.test.tsx`, `stepper.test.tsx`.
- **Depends on:** 1.1

### 2.6 Build ListSkeleton, EmptyState and InlineError
- **Type:** component · **Board(s):** 12, 19a, 19b, 08, 05 · **Spec:** §5h · **Gaps:** — · **Source:** `ui:components/feedback.tsx:25`, `ui:app/project-sidebar.tsx:130` (only skeleton today)
- **Scope:**
  - One pattern each for loading, empty ("what + next action") and error (message + `Retry`).
  - Replace one-off loading text in inboxes and sidebars as other issues touch them.
  - Story per pattern.
- **Acceptance:**
  - [ ] `InlineError` always renders a Retry button when `onRetry` is given.
  - [ ] Skeleton rows match real row height (no layout shift).
- **Tests:** `ui:components/feedback.test.tsx`.
- **Depends on:** 1.2

### 2.7 Build SettingsCard, SettingsRow and restyle Toggle
- **Type:** component · **Board(s):** 09a–09n · **Spec:** §5e · **Gaps:** — · **Source:** `ui:composites/settings-view.tsx:944` (`ToggleRow`), `ui:components/toggle.tsx`
- **Scope:**
  - `SettingsRow`: label + help on the left, control on the right.
  - `SettingsCard`: bordered group of rows with optional header.
  - Toggle restyled to neutral track with brand-free focus ring.
- **Acceptance:**
  - [ ] A row with a long help text wraps text, not the control.
  - [ ] Toggle is operable by `Space` and has `role="switch"`.
- **Tests:** `settings-row.test.tsx`.
- **Depends on:** 1.1

### 2.8 Build Drawer and restyle Dialog
- **Type:** component · **Board(s):** 18c, 15, 14 · **Spec:** §5l, §5i · **Gaps:** — · **Source:** `ui:components/dialog.tsx`
- **Scope:**
  - `Drawer` (right sheet, 480px) on the Radix primitive already used by `dialog.tsx`.
  - Shared scrim covering the whole window, including rail and sidebar.
  - Focus trap, `Esc` closes, return focus on close.
- **Acceptance:**
  - [ ] Scrim dims rail and sidebar.
  - [ ] Focus returns to the trigger on close.
- **Tests:** `drawer.test.tsx`.
- **Depends on:** 1.1

### 2.9 Restyle HoverCard, Tooltip and Kbd chip
- **Type:** component · **Board(s):** 25a, 04b · **Spec:** §3e2 · **Gaps:** — · **Source:** `ui:components/hover-card.tsx:26`, `ui:components/tooltip.tsx`, `ui:components/kbd.tsx:16`
- **Scope:**
  - Elevated surface, 8px radius, 150 ms open delay, `Esc` closes.
  - `KbdChip` renders a shortcut as one nowrap unit with the platform glyphs.
  - Tooltip shows the shortcut via `KbdChip`.
- **Acceptance:**
  - [ ] Hover card stays open while the pointer moves from trigger to card.
  - [ ] Shortcut glyphs are `⌘` on macOS and `Ctrl` elsewhere.
- **Tests:** `hover-card.test.tsx`.
- **Depends on:** 1.3

### 2.10 Update ConfirmDialog for the destructive-final-button rule
- **Type:** component · **Board(s):** 24b, 25c · **Spec:** §6.10 · **Gaps:** — · **Source:** `ui:components/confirm-dialog.tsx:19`, `ui:components/confirm-dialog.test.tsx`
- **Scope:**
  - Default confirm button is neutral primary.
  - New `destructive` prop renders the confirm button as the only solid red fill.
  - Cancel is secondary; `Esc` cancels; initial focus on the safe button.
- **Acceptance:**
  - [ ] Destructive confirm is red; non-destructive is neutral.
  - [ ] Initial focus is on Cancel for destructive dialogs.
- **Tests:** extend `confirm-dialog.test.tsx`.
- **Depends on:** 1.2, 2.8

### 2.11 Build BannerShell and align Callout
- **Type:** component · **Board(s):** 23, 12 · **Spec:** §5h, §6.3 · **Gaps:** — · **Source:** `ui:components/callout.tsx:41`, `ui:composites/archived-banner.tsx:20`, `ui:composites/branch-drift-banner.tsx:18`, `ui:composites/runtime-recovery-card.tsx:24`
- **Scope:**
  - `BannerShell`: neutral body, icon slot (red only on failure), message, up to two actions, dismiss.
  - Placement variants: top hairline, lane header, inline card.
  - Callout tones collapse onto `BannerShell` styling.
- **Acceptance:**
  - [ ] Banners never render a coloured fill.
  - [ ] Actions stay on one line; the message truncates.
- **Tests:** `banner-shell.test.tsx`; story.
- **Depends on:** 1.4

### 2.12 Add a searchable VirtualList
- **Type:** component · **Board(s):** 09i, 22a · **Spec:** §6.7 · **Gaps:** — · **Source:** none in `packages/ui` today
- **Scope:**
  - Windowed list with fixed row height, keyboard navigation and sticky group headers.
  - Used by Agents & skills and mention menus.
- **Acceptance:**
  - [ ] 1,000 rows scroll at 60 fps and keep selection while filtering.
  - [ ] Arrow keys scroll the active row into view.
- **Tests:** `virtual-list.test.tsx` with 1,000 items.
- **Depends on:** 2.2
- **Decision pending:** none in the four product decisions; open engineering question from 07-dev-notes 09i: confirm adding a virtualiser dependency vs a ~60-line in-house windowing hook before starting.


### 2.13 Build Avatar and AvatarStack atoms
- **Type:** component · **Board(s):** 17a, 17b · **Spec:** §6.12 · **Gaps:** — · **Source:** `ui:components/avatar.tsx:21`, `ui:components/avatar.tsx:13` (`githubAvatarUrl`), `ui:brand/jingler-mark.tsx:28`
- **Scope:**
  - Restyle `Avatar` to 20px with count badge slot (one line) and focus ring.
  - `AvatarStack` overlaps avatars with a −6px offset.
  - Agent author renders the mono Jingler mark instead of an image.
- **Acceptance:**
  - [ ] Stack of 3 overlaps by 6px and stays on one row.
  - [ ] Avatars are reachable with `Tab` and expose `aria-label` with author name.
- **Tests:** `ui:components/avatar.test.tsx`; story.
- **Depends on:** 1.3

### 2.14 Build KpiTile and StackedMiniBar
- **Type:** component · **Board(s):** 18b, 18c · **Spec:** §5l · **Gaps:** — · **Source:** `core:runtime/usage-facts.ts:69` (data shape), `ui:composites/usage-modal.tsx:101`
- **Scope:**
  - `KpiTile`: label, value, delta, optional "partial" marker (cost is partial).
  - `StackedMiniBar` in inline SVG (no chart library).
  - Placeholder numbers are labelled, never invented.
- **Acceptance:**
  - [ ] Tile with a "partial" marker shows it on the same line as the label.
  - [ ] Bars render from a plain numeric array with no dependency added.
- **Tests:** `kpi-tile.test.tsx`; story.
- **Depends on:** 1.3

### 2.15 Build CommentRow
- **Type:** component · **Board(s):** 05, 17a · **Spec:** §6.2 · **Gaps:** — · **Source:** `ui:composites/review-findings.tsx:181`, `ui:composites/inline-comment-composer.tsx:13`
- **Scope:**
  - Plain comment-style row: severity as text label in `--sb-muted`, message, action slot (`Ask agent to fix`) and a `Dismiss ×` icon button.
  - No sparkle icon, gradient or "AI" stripe.
  - Shared by review findings and inline review comments.
- **Acceptance:**
  - [ ] Dismiss is keyboard reachable and has a tooltip.
  - [ ] Row has no coloured fill at any severity.
- **Tests:** `comment-row.test.tsx`.
- **Depends on:** 1.2, 1.3

### 2.16 Restyle SessionRow and PrGlyph with a stack slot
- **Type:** component · **Board(s):** 00, 04m, 24a · **Spec:** §3, §3f · **Gaps:** — · **Source:** `ui:composites/session-row.tsx:57`, `ui:composites/pr-glyph.tsx:52`, `ui:composites/pr-glyph.tsx:106`
- **Scope:**
  - Row layout on Graphite tokens with status word, diff stat and branch truncation.
  - `PrGlyph` gets a stack variant (`⑂ 3`, coloured by worst state) behind a prop; data wiring is 14.1.
  - Amber needs-you and pulsing blue working states use state tokens.
- **Acceptance:**
  - [ ] Row renders correctly for every status in the story matrix.
  - [ ] Stack variant renders without the data model (prop only).
- **Tests:** extend `ui:composites/session-row.test.tsx`; e2e extend `apps/desktop/e2e/sidebar-identity.spec.ts`.
- **Depends on:** 1.1, 15.1

---

## Epic 3 — App shell

### 3.1 Add header view buttons and overflow menu
- **Type:** feature · **Board(s):** 04g · **Spec:** §3c · **Gaps:** — · **Source:** `ui:app/tab-contributions.ts:56`, `ui:app/tab-contributions.ts:219`, `ui:app/app-shortcuts.ts:13`
- **Scope:**
  - `HeaderViewButtons`: Changes N / Checks a/b / Terminal / Browser, up to 5 pinned, count badges on one line.
  - `ViewOverflowMenu` (⋯): all Views, Plugins, "Pin to header".
  - Shortcuts ⌘⇧D Changes, ⌘⇧P Checks, ⌃\` Terminal, ⌘⇧B Browser, ⌘P quick open, ⌥1–9 by position.
  - Pinned set read from `Config.setHeaderViews` (14.5).
- **Acceptance:**
  - [ ] Pinning a sixth view is refused with a tooltip.
  - [ ] Every shortcut opens the view in the focused content group.
- **Tests:** extend `ui:app/app-shortcuts.test.ts`; e2e new `apps/desktop/e2e/view-launcher.spec.ts`.
- **Depends on:** 1.2, 2.1, 14.5

### 3.2 Remove the right view rail and merge views
- **Type:** feature · **Board(s):** 04g · **Spec:** §3c · **Gaps:** — · **Source:** `ui:app/view-rail.tsx:76`, `ui:app/view-rail.test.tsx`, `ui:app/tab-contributions.ts:56`
- **Scope:**
  - Delete `ViewRail` and its tests; remove its mounting from `jingler-app.tsx`.
  - Code Review → Changes, PR → Checks, Workflow → section inside Checks, Conversation has no button.
  - Keep the `review`, `pr`, `workflow` contributions registered so deep links and persisted tabs still open.
  - Update every e2e that clicks a `view-rail` testid.
- **Acceptance:**
  - [ ] No right rail renders at any window width.
  - [ ] A persisted `pr` tab opens Checks on the PR section.
- **Tests:** update `rg view-rail apps/desktop/e2e` specs; e2e extend `view-launcher.spec.ts`.
- **Depends on:** 3.1

### 3.3 Add contextual links to views
- **Type:** feature · **Board(s):** 04b, 04g · **Spec:** §3c · **Gaps:** — · **Source:** `ui:app/tab-contributions.ts:219`, `ui:composites/plan-card.tsx:110`, `ui:app/preview-dock.tsx:136`
- **Scope:**
  - PR chip in the header opens Checks; `LIN` chip opens the linked issue.
  - Plan card `Open plan`; transcript chip `Preview ready · Open browser`.
  - ⌘K action "Open view…" lists every registered view.
- **Acceptance:**
  - [ ] Each link opens the right view without creating a duplicate tab.
- **Tests:** e2e extend `view-launcher.spec.ts`, `previews.spec.ts`.
- **Depends on:** 3.1

### 3.4 Build the Sessions | Explorer toggle with filter chips
- **Type:** feature · **Board(s):** 04l · **Spec:** §3e · **Gaps:** — · **Source:** `ui:app/session-sidebar.tsx:833`, `ui:app/jingler-app.tsx:376` (`renderExplorer`), `desk:file-browser-view.tsx:174`, `ui:components/pierre-file-tree.tsx:41`, `desk:changes-review.tsx:74`
- **Scope:**
  - Use the shared SegmentedControl (2.3) and FilterChips (2.2): `All · Changed 12 · PR #482`.
  - `explorer-view-machine.ts`: sidebar mode, active chip and per-project memory (3 coupled pieces).
  - Header Changes button switches to Explorer with Changed selected and opens the diff via `revealSessionChanges`.
  - Shortcut ⌘⇧E.
- **Acceptance:**
  - [ ] Chip choice is remembered per project across restarts.
  - [ ] Header Changes lands on Explorer › Changed and opens the diff.
- **Tests:** `desk:explorer-view-machine.test.ts`; e2e extend `diffs-file-tree.spec.ts`.
- **Depends on:** 2.2, 2.3

### 3.5 Decorate Explorer rows
- **Type:** feature · **Board(s):** 04l · **Spec:** §3e · **Gaps:** — · **Source:** `ui:components/pierre-file-tree.tsx:41`, `desk:agent-file-activity.ts`, `desk:diff-presence.ts`
- **Scope:**
  - Git status letters, folder dots for changed descendants, agent-edit dot, pulse on the file being edited now.
  - Letters and dots use neutral text; only conflict/failure uses colour.
  - Pulse stops when the agent run ends.
- **Acceptance:**
  - [ ] A file edited by the agent shows the dot within 1 s of the write.
  - [ ] Rows stay one line at 248px sidebar width.
- **Tests:** unit on the decoration mapper; e2e extend `diffs-file-tree.spec.ts`.
- **Depends on:** 3.4

### 3.6 Remove the files tab and add the ⌘P quick-open variant
- **Type:** feature · **Board(s):** 04l, 24a · **Spec:** §3e · **Gaps:** — · **Source:** `ui:app/tab-contributions.ts:58`, `ui:asset/file-quick-open.tsx:24`, `desk:file-browser-view.tsx:230`
- **Scope:**
  - Remove the `files` builtin tab; file opens come from Explorer and ⌘P.
  - Restyle `FileQuickOpen` (query field, recent files, match highlighting, footer hints).
  - Migrate persisted `files` tabs to Explorer on load.
- **Acceptance:**
  - [ ] ⌘P opens quick-open from anywhere and ↵ opens the file in the focused group.
  - [ ] An old session with a `files` tab loads without error.
- **Tests:** unit for tab migration; e2e extend `file-browser-ide.spec.ts`.
- **Depends on:** 3.4

### 3.7 Restyle the project rail
- **Type:** style · **Board(s):** 00, 04b, 24a · **Spec:** §3 · **Gaps:** — · **Source:** `ui:app/project-sidebar.tsx:16`, `ui:app/project-sidebar.tsx:81`, `ui:app/project-navigation.ts:3`
- **Scope:**
  - 56px rail: mono 16px mark at the top, white left bar + filled tile for the active project, pulsing blue working dot.
  - Add project and account pinned at the bottom; ⌘1–9 project switch kept.
  - Sidebar lists only the active project's workspaces; chrome stays 56 + 248 = 304px.
- **Acceptance:**
  - [ ] Active tile has the left bar and fill; ⌘3 selects the third project.
  - [ ] Rail renders on the Graphite tokens with no hardcoded colour.
- **Tests:** extend `ui:app/project-sidebar.test.tsx`; e2e extend `project-sidebar-activity.spec.ts`.
- **Depends on:** 1.1

### 3.8 Show a missing-folder state on rail tiles
- **Type:** feature · **Board(s):** 24a, 24a+ · **Spec:** §5g · **Gaps:** F1-13 · **Source:** `ui:app/project-sidebar.tsx:10`, `ui:app/project-sidebar.tsx:74`
- **Scope:**
  - Replace the small yellow dot with a tile menu row "Folder not found" and actions `Locate folder…` / `Remove project`.
  - Sidebar banner on that project (BannerShell, 2.11).
  - `Locate folder…` re-registers the path through `Projects.register`.
- **Acceptance:**
  - [ ] A project whose folder is renamed shows the banner and menu.
  - [ ] Locating the folder clears the state without restart.
- **Tests:** extend `project-sidebar.test.tsx`; e2e extend `projects-and-workspaces.spec.ts`.
- **Depends on:** 2.11, 3.7

### 3.9 Build the sidebar filter/sort menu and context menus
- **Type:** feature · **Board(s):** 24a · **Spec:** §5g · **Gaps:** — · **Source:** `ui:components/filter-menu.tsx`, `ui:app/session-filters.ts:23`, `ui:components/context-menu.tsx:199`
- **Scope:**
  - Filter (status, PR state) and sort (recent, name, status) menu with checkmarks.
  - Row context menu: Rename, Archive, Copy branch, Open in terminal.
  - Rail tile context menu: Settings, Remove project.
- **Acceptance:**
  - [ ] Filter + sort choices persist per project.
  - [ ] Menus are fully keyboard operable.
- **Tests:** extend `ui:app/session-filters.test.ts`; e2e extend `sidebar-attention-layout.spec.ts`.
- **Depends on:** 2.2

### 3.10 Restyle the command palette with scopes
- **Type:** feature · **Board(s):** 10 · **Spec:** §5f · **Gaps:** — · **Source:** `ui:app/command-palette.tsx:50`, `ui:app/command-palette-model.ts:31`, `ui:app/title-search.tsx:25`
- **Scope:**
  - Scope chips `>` commands, `@` files, `#` workspaces; `Tab` cycles scope.
  - "Open view…" section (3.3) and footer hints; `⌘↵` secondary action.
  - Extract `command-palette-machine.ts` (scope + results + selection).
- **Acceptance:**
  - [ ] Typing a scope prefix switches chip and filters results.
  - [ ] `Esc` closes and restores prior focus.
- **Tests:** `ui:app/command-palette-machine.test.ts`; e2e extend `command-palette.spec.ts`.
- **Depends on:** 1.2, 2.2

### 3.11 Draw Windows/Linux title bar controls
- **Type:** style · **Board(s):** 00 · **Spec:** §3 · **Gaps:** — · **Source:** `ui:app/title-bar.tsx:7`
- **Scope:**
  - Overlay minimise/maximise/close on non-macOS using Graphite tokens.
  - Keep the draggable region and the search field centred.
- **Acceptance:**
  - [ ] Controls render only when `platform !== "darwin"`.
- **Tests:** unit for platform branching in `title-bar`.
- **Depends on:** 1.1

---

## Epic 4 — Copilot layout

### 4.1 Add the chat-lane state machine
- **Type:** feature · **Board(s):** 04b–04e · **Spec:** §3b · **Gaps:** — · **Source:** `ui:app/editor-layout-machine.ts:17`, `ui:app/editor-layout.ts:61` (`CHAT_RATIO`), `desk:conversation-pane.tsx:89` (`PLAN_SPLIT_RATIO_KEY` pattern)
- **Scope:**
  - `chat-lane-machine.ts`: Full, Docked, Collapsed, Focus, Drawer; events `OPEN_CONTENT`, `CLOSE_CONTENT`, `TOGGLE_COLLAPSE`, `TOGGLE_FOCUS`, `RESIZE`, `WINDOW_NARROW`.
  - Persist the docked width in px.
  - Thin `use-chat-lane.ts` hook that maps snapshots to layout props.
- **Acceptance:**
  - [ ] Every mode transition in §3b is covered by a test.
  - [ ] Docked width survives a window resize and restart.
- **Tests:** `ui:app/chat-lane-machine.test.ts`; e2e new `apps/desktop/e2e/chat-lane.spec.ts`.
- **Depends on:** —

### 4.2 Size the docked chat in pixels
- **Type:** feature · **Board(s):** 04c, 04h · **Spec:** §3b · **Gaps:** — · **Source:** `ui:app/editor-layout.ts:61`, `ui:app/split-layout.ts:68` (`MIN_RATIO`), `ui:app/editor-groups.tsx:52`
- **Scope:**
  - Replace `CHAT_RATIO = 1/3` with `clamp(360px, 33%, 560px)` and drag-resize.
  - Snap to 33% / 50%; collapse below 320px.
  - Content area takes the remainder.
- **Acceptance:**
  - [ ] Dragging to 300px collapses the lane to the Ask pill.
  - [ ] Width is clamped between 360 and 560px by default.
- **Tests:** extend `ui:app/editor-layout.test.ts`; e2e extend `chat-lane.spec.ts`.
- **Depends on:** 4.1

### 4.3 Build the chat lane header
- **Type:** feature · **Board(s):** 04b · **Spec:** §3b · **Gaps:** — · **Source:** `ui:app/chat-tab-bar.tsx:115`, `ui:app/subagent-tab-bar.tsx:7`, `ui:app/conversation-view.tsx:46`
- **Scope:**
  - `ChatLaneHeader`: thread switcher, `+ New chat`, subagent chip slot (8.1), follow-agent toggle.
  - Replaces the chat tab strip inside the lane; no tabs on chat.
  - Existing multi-chat data model is unchanged.
- **Acceptance:**
  - [ ] Switching threads keeps the composer draft per thread.
  - [ ] No tab strip renders above the transcript.
- **Tests:** replace `ui:app/chat-tab-bar.test.tsx`; e2e extend `multi-chat.spec.ts`.
- **Depends on:** 4.1, 2.9

### 4.4 Add the collapsed Ask pill and Focus mode
- **Type:** feature · **Board(s):** 04d, 04e · **Spec:** §3b · **Gaps:** — · **Source:** `desk:preview-dock-machine.ts:118`, `desk:terminal-dock-view.tsx:26`
- **Scope:**
  - ⌘L collapses the lane to a floating `Ask ⌘L` pill; ⌘⇧L and double-click on the handle toggle Focus.
  - Content tabs stay mounted but hidden in Focus so terminal and browser keep state.
- **Acceptance:**
  - [ ] Terminal output continues while the lane is in Focus.
  - [ ] ⌘L from Collapsed restores the previous width.
- **Tests:** machine tests in `chat-lane-machine.test.ts`; e2e extend `chat-lane.spec.ts`.
- **Depends on:** 4.1

### 4.5 Add the narrow-window chat drawer
- **Type:** feature · **Board(s):** 04f · **Spec:** §3b · **Gaps:** — · **Source:** `ui:app/session-sidebar.tsx:894`, `ui:app/session-sidebar.tsx:914`, `ui:hooks/width-tier.tsx`
- **Scope:**
  - Under 1100px the lane becomes a 400px overlay `ChatDrawer` with scrim.
  - Resolve the overlap with the 1000px sidebar collapse (open question from 07-dev-notes 04f: pick one cascade order and document it).
- **Acceptance:**
  - [ ] At 1024px wide the lane opens as an overlay and `Esc` closes it.
  - [ ] Sidebar collapse and drawer never overlap each other.
- **Tests:** extend `ui:hooks/width-tier.test.tsx`; e2e extend `responsive.spec.ts`.
- **Depends on:** 4.1, 2.8

### 4.6 Rebuild content group tab strips
- **Type:** feature · **Board(s):** 04i · **Spec:** §3d · **Gaps:** — · **Source:** `ui:app/tab-bar.tsx:182`, `ui:app/editor-groups.tsx:52`, `ui:app/use-split-layout.ts`, `ui:app/split-shortcuts.ts:8`
- **Scope:**
  - `GroupTabStrip`: 32px, underline on active, focused group bright and others dimmed.
  - Max 3 groups; ⌘\\ split right, ⌘⇧\\ split down; groups collapse below 240px.
  - 1px gutters with an 8px hit area.
- **Acceptance:**
  - [ ] A fourth split is refused.
  - [ ] Group under 240px collapses to its tab strip.
- **Tests:** extend `ui:app/split-layout.test.ts`, `ui:app/editor-groups.test.tsx`; e2e extend `editor-groups.spec.ts`.
- **Depends on:** 4.2

### 4.7 Add the drag-to-split drop zone overlay
- **Type:** feature · **Board(s):** 04k · **Spec:** §3d · **Gaps:** — · **Source:** `ui:app/editor-layout.ts:22` (`DropEdge`), `ui:app/editor-groups.tsx:38`
- **Scope:**
  - `DropZoneOverlay` with 5 labelled zones in the `--sb-brand` tint (an allowed brand use).
  - Dropping on an edge creates a group; centre moves the tab.
- **Acceptance:**
  - [ ] Dragging a tab shows five zones and the hovered zone is highlighted.
- **Tests:** unit on drop-edge resolution; e2e extend `editor-groups.spec.ts`.
- **Depends on:** 4.6

### 4.8 Add the file breadcrumb and agent-edit decorations
- **Type:** feature · **Board(s):** 04c, 04h · **Spec:** §3b, §6.1 · **Gaps:** — · **Source:** `desk:agent-file-activity.ts`, `desk:diff-presence.ts`, `desk:file-browser-view.tsx:154`, `ui:asset/asset-view.tsx:30`
- **Scope:**
  - Mono 11px `Breadcrumb` with `● 2 agent edits`.
  - Inline diff decoration labelled `Agent edit · Turn 3`; no per-hunk Keep/Revert.
  - Clicking the label jumps the timeline to that turn.
- **Acceptance:**
  - [ ] Agent edits are decorated without any Keep or Revert control.
  - [ ] Breadcrumb count matches the edits in the current file.
- **Tests:** unit for decoration ranges; e2e extend `file-browser-ide.spec.ts`.
- **Depends on:** 4.2

### 4.9 Add selection-to-chat with ⌘L
- **Type:** feature · **Board(s):** 04c · **Spec:** §3b · **Gaps:** — · **Source:** `ui:components/file-chip.tsx`, `ui:app/conversation-view.tsx:315` (`draftCodeReferences`)
- **Scope:**
  - With a selection in a file, ⌘L adds a `FileRangeChip` to the composer and focuses it.
  - Without a selection, ⌘L toggles the lane (4.4).
  - Chip shows `path:12–30` on one line and is removable.
- **Acceptance:**
  - [ ] Selecting lines then ⌘L adds exactly one chip with the right range.
- **Tests:** unit on chip formatting; e2e extend `chat-selection.spec.ts`.
- **Depends on:** 4.4

### 4.10 Extend the timeline rail ticks and hover card
- **Type:** feature · **Board(s):** 04b · **Spec:** §3e2 · **Gaps:** — · **Source:** `ui:app/conversation-view.tsx:46` (`PreviewRail`), `ui:app/conversation-view.tsx:123` (`activeRailIdFor`), `ui:app/conversation-view.tsx:695`
- **Scope:**
  - Tick kinds: amber needs-you, red failed, checkpoint; keep the rail in every chat mode.
  - Hover card `Turn 3 · 4 files · +84 −12` with Jump / Filter Changes / Revert to here.
  - ⌥↑ / ⌥↓ move between turns.
- **Acceptance:**
  - [ ] A blocked question shows an amber tick that jumps to the card.
  - [ ] Revert to here opens the confirm dialog (13.4).
- **Tests:** extend `ui:app/conversation-view.test.tsx`; e2e extend `chat.spec.ts`.
- **Depends on:** 2.9

---

## Epic 5 — Composer & transcript

### 5.1 Restyle the @ mention and / command menus
- **Type:** style · **Board(s):** 22a · **Spec:** §4 · **Gaps:** — · **Source:** `ui:composites/mention-menu.tsx:10`, `ui:composites/slash-command-row.tsx:6`, `ui:composites/composer.tsx:514`
- **Scope:**
  - Graphite popover with group headers (Files, Sessions, Skills), match highlighting and a keyboard footer.
  - Use `VirtualList` (2.12) for long file lists; `SearchField` hint for the active trigger.
  - Empty state "No matches" with the typed query.
- **Acceptance:**
  - [ ] `@` and `/` open the right menu; ↑↓ ↵ Esc work; 1,000 files stay responsive.
  - [ ] Rows never wrap; long paths truncate in the middle.
- **Tests:** story matrix; e2e extend `composer-capabilities.spec.ts`.
- **Depends on:** 1.3, 2.12

### 5.2 Move reasoning and environment into the model popover
- **Type:** feature · **Board(s):** 22b, 22b+ · **Spec:** §4 (22b), §5h · **Gaps:** F1-14 · **Source:** `ui:composites/provider-model-browser.tsx:99`, `ui:composites/composer.tsx:200` (`ComposerSelect`), `ui:composites/environment-dialog.tsx:36`, `desk:conversation-pane.tsx:1506`, `desk:conversation-pane.tsx:1515`
- **Scope:**
  - One popover holds model list, reasoning level and environment; the loose chips leave the composer row.
  - Disabled composer with no model shows "Choose a model to start" + `Select model`, which opens the popover.
  - `Agent.setModel`, `Agent.setReasoning`, `Provider.verifyModel` wiring stays unchanged.
- **Acceptance:**
  - [ ] A session with no connection shows the first-run line and the button opens the popover.
  - [ ] Changing reasoning from the popover updates the next send.
- **Tests:** story; e2e extend `composer-capabilities.spec.ts`.
- **Depends on:** 1.2, 2.2, 5.3

### 5.3 Show provider logos in the model popover and model chip
- **Type:** style · **Board(s):** 22b · **Spec:** §6.15, §6.5 · **Gaps:** — · **Source:** `ui:components/provider-icon.tsx:85`, `ui:composites/provider-model-browser.tsx:15`, `ui:composites/composer.tsx:200`
- **Scope:**
  - `ProviderIcon` at 14px on every provider and model row, and on the composer model chip.
  - Providers without an icon fall back to a neutral letter tile.
  - No invented marks; reuse the existing paths.
- **Acceptance:**
  - [ ] Claude and Codex rows use the real logos at 14px.
  - [ ] Chip and popover rows stay on one line.
- **Tests:** `ui:components/provider-icon.test.tsx` for the fallback tile; story.
- **Depends on:** 1.3

### 5.4 Turn the context meter into a send-button ring with a popover
- **Type:** feature · **Board(s):** 22c · **Spec:** §4 (22c) · **Gaps:** — · **Source:** `ui:composites/context-meter.tsx:68`, `ui:composites/composer.tsx:514`
- **Scope:**
  - Ring around the send button with usage percentage.
  - Click opens a detail popover (breakdown, compaction trigger, `Compact now`).
  - Neutral colours; the ring turns red only when compaction is stalled.
- **Acceptance:**
  - [ ] Popover lists the same figures as `contextBreakdown` today.
  - [ ] `Compact now` calls `Context.compactNow` and shows progress.
- **Tests:** extend context-meter tests; e2e extend `context-compaction.spec.ts`.
- **Depends on:** 1.1, 2.9

### 5.5 Restyle attachments, background-task dock and stop/send-branch
- **Type:** style · **Board(s):** 22c · **Spec:** §4 (22c) · **Gaps:** — · **Source:** `ui:components/attachment-thumb.tsx`, `ui:composites/background-task-dock.tsx:150`, `ui:composites/background-task-dock.tsx:220`, `ui:composites/composer.tsx:456`
- **Scope:**
  - Attachment thumbs with remove button and drop/paste hint.
  - Background-task dock rows with output popover and Stop icon.
  - Stop and send-branch buttons use the neutral primary/secondary variants.
- **Acceptance:**
  - [ ] Drop and paste of an image still attach; remove works from keyboard.
  - [ ] Stopping a background task shows a pending state.
- **Tests:** e2e extend `attachments.spec.ts`, `background-tasks.spec.ts`.
- **Depends on:** 1.2

### 5.6 Restyle queued message actions as icon buttons
- **Type:** style · **Board(s):** 22c · **Spec:** §6.13 · **Gaps:** — · **Source:** `ui:composites/queued-message-row.tsx:8`, `ui:composites/queued-message-row.tsx:52`
- **Scope:**
  - Send now, hand off, edit, remove as 24px ghost icon buttons; `title` stays the accessible name.
  - Hand off tooltip stays `handoffHint ?? "Hand off — run this in a new chat"`.
  - A `sending` row hides its actions.
- **Acceptance:**
  - [ ] Existing tests that address rows by `title` still pass.
  - [ ] Message text truncates before the icons wrap.
- **Tests:** extend the queued-message-row tests; e2e extend `queue-actions.spec.ts`.
- **Depends on:** 1.2, 2.1

### 5.7 Add "Hand off all" for the queue
- **Type:** feature · **Board(s):** 22c · **Spec:** §6.14 · **Gaps:** — · **Source:** `ui:app/conversation-view.tsx:242`, `ui:app/conversation-view.tsx:368`, `desk:conversation-pane.tsx:1241`
- **Scope:**
  - Queue header gets `Hand off all · N`; it forks each queued message into its own new chat on the hand-off target model and clears the queue.
  - Batch handler over the existing per-item `onHandoffQueued`; disabled while any item is `sending`.
  - Toast `3 messages handed off · View` where View opens the thread switcher.
- **Acceptance:**
  - [ ] Three queued messages produce three chats and an empty queue.
  - [ ] Button is disabled while a message is sending.
- **Tests:** unit for the batch handler; e2e extend `queue-actions.spec.ts`.
- **Depends on:** 2.4, 5.6, 4.3

### 5.8 Restyle transcript turns, thought blocks, tool calls and context divider
- **Type:** style · **Board(s):** 22d, 04b · **Spec:** §4 (22d) · **Gaps:** — · **Source:** `ui:composites/message-turn.tsx:122`, `ui:composites/thought-block.tsx:20`, `ui:composites/tool-call.tsx:111`, `ui:composites/context-divider.tsx:55`
- **Scope:**
  - Graphite tokens, collapsed tool rows with neutral status icons, expanded thought block.
  - Context-divider (compaction) as a hairline with label.
  - Streaming text and error rows follow the shared InlineError pattern.
- **Acceptance:**
  - [ ] No hardcoded colour remains in these four files.
  - [ ] Tool rows show a red icon only for a failed call.
- **Tests:** update affected tests; e2e extend `chat.spec.ts`.
- **Depends on:** 1.1, 2.6

### 5.9 Add PR transcript cards (opened, stacked, merged)
- **Type:** feature · **Board(s):** 22d, 24a, 22d+, 24a+ · **Spec:** §3f · **Gaps:** F3-08, F2-13 · **Source:** `desk:App.tsx:813`, `desk:publish-machine.ts:54`, `desk:notifier.ts:76`, `desk:pr-sweep.ts:49`
- **Scope:**
  - Card `Opened #482 · stacked on #481` emitted when publish completes; links to the header PR switcher.
  - Card `PR #482 merged` with `Archive workspace` / `Keep open`; sidebar row shows Merged.
  - Cards are persisted transcript events, not toasts.
- **Acceptance:**
  - [ ] Publishing a stacked PR adds exactly one card.
  - [ ] Merge adds one card and `Archive workspace` runs the archive flow (13.3).
- **Tests:** unit for the event mapper; e2e extend `github-publish.spec.ts`.
- **Depends on:** 14.1, 2.11

### 5.10 Add "Sign in" action to auth-failed tool rows
- **Type:** feature · **Board(s):** 22d, 22d+ · **Spec:** §4 (22d) · **Gaps:** F5-05 · **Source:** `ui:composites/tool-call.tsx:111`, `contracts:1257` (`Mcp.startAuthorization`)
- **Scope:**
  - Failed tool row classified as auth failure shows `Sign in to <server>`.
  - The action starts the same flow as the MCP recovery card (5.14).
  - Other failures keep the generic row with `Retry`.
- **Acceptance:**
  - [ ] An MCP tool failing with needs-auth shows the sign-in action.
- **Tests:** extend tool-call tests; e2e extend `mcp-recovery.spec.ts`.
- **Depends on:** 5.14

### 5.11 Restyle archived and branch-drift banners
- **Type:** style · **Board(s):** 23 · **Spec:** §5h · **Gaps:** — · **Source:** `ui:composites/archived-banner.tsx:20`, `ui:composites/branch-drift-banner.tsx:18`
- **Scope:**
  - Both use `BannerShell` (2.11); copy "This session is archived and now read-only…" with `Restore` / `Delete`.
  - Branch drift keeps its two recovery actions.
- **Acceptance:**
  - [ ] Banners render no coloured fill; actions stay one line.
- **Tests:** extend archived and branch-drift tests; e2e extend `branch-drift-recovery.spec.ts`.
- **Depends on:** 2.11

### 5.12 Build the three recovery-card variants
- **Type:** feature · **Board(s):** 23, 23+ · **Spec:** §5h · **Gaps:** F8-05 · **Source:** `ui:composites/runtime-recovery-card.tsx:15`, `ui:composites/runtime-recovery-card.tsx:24`, `desk:conversation-pane.tsx:145`, `desk:conversation-pane.tsx:843`, `contracts:807`
- **Scope:**
  - Variants: MCP server, Provider, Runtime ("The agent process exited unexpectedly" · `Restart runtime` · `Inspect`).
  - Neutral body; red icon only on failure; shares `BannerShell`.
  - `Inspect` opens Settings → Runtime (10.17).
- **Acceptance:**
  - [ ] Each variant renders from a story and from `Sessions.resolveRuntimeRecovery` state.
- **Tests:** extend runtime-recovery-card tests; e2e extend `pi-recovery.spec.ts`.
- **Depends on:** 2.11

### 5.13 Add provider signed-out, limit and account-choice cards
- **Type:** feature · **Board(s):** 23, 15a, 18a, 23+ · **Spec:** §5i, §5h · **Gaps:** F5-01, F5-02, F5-03 · **Source:** `desk:provider-recovery.ts:15`, `desk:provider-recovery.ts:22`, `desk:provider-recovery.ts:89`, `desk:conversation-pane.tsx:1511`, `contracts:1288`
- **Scope:**
  - Card "Claude Code signed out during this run" + `Reconnect` (opens the Connect sheet in place) and `Resume run` after success; copy states a subscription never falls back to an API key.
  - Usage-limit banner "Limited until 16:40" + `Switch model` / `Switch account`.
  - Ambiguous rebind lists signed-in accounts as radio rows + `Use this account`.
- **Acceptance:**
  - [ ] Reconnecting from the card resumes the run without leaving the workspace.
  - [ ] Ambiguous case never auto-picks an account.
- **Tests:** extend `provider-recovery` tests; e2e extend `provider-onboarding.spec.ts`.
- **Depends on:** 2.11, 10.4

### 5.14 Add MCP sign-in card states (waiting, cancel, failed)
- **Type:** feature · **Board(s):** 23, 16d, 23+ · **Spec:** §6.6 · **Gaps:** F5-04 · **Source:** `desk:conversation-pane.tsx:137`, `desk:conversation-pane.tsx:153`, `core:mcp.ts:39`, `ui:composites/mcp-settings.tsx:45`
- **Scope:**
  - States `Needs sign-in · Connect` → "Waiting for browser… · Cancel" → "Connected" (auto-hides) or "Sign-in failed · Retry".
  - Reuse `authorizing` from `McpAuthState`.
  - Dismissal persistence is fixed in 15.7.
- **Acceptance:**
  - [ ] Cancel returns the card to `Needs sign-in`; failure shows Retry.
- **Tests:** unit for the card state mapper; e2e extend `mcp-recovery.spec.ts`.
- **Depends on:** 2.11, 15.7

### 5.15 Add offline, device-offline and relay-quota banners
- **Type:** feature · **Board(s):** 23, 12, 23+ · **Spec:** §5h · **Gaps:** F5-06, F7-05, F7-06 · **Source:** `ui:composites/queued-message-row.tsx:52`, `contracts:860` (`Sessions.continueOnEnvironment`), `core:remote.ts:137`, `core:remote.ts:760`, `core:remote.ts:818`
- **Scope:**
  - Top hairline banner "Offline — agents keep running locally" from `navigator.onLine` plus a failed-RPC heuristic.
  - A send that needs a provider queues as "Waiting for connection" using the queued row.
  - Lane banner "Studio-Mac went offline — the run is paused" + `Continue on this Mac…`.
  - Banner "Remote runs are paused — relay quota reached" with placeholder reset date.
- **Acceptance:**
  - [ ] Going offline shows the banner and queues a provider send; reconnect sends it.
  - [ ] Device banner clears when the device reconnects.
- **Tests:** unit for the online heuristic; e2e extend `remote-environments.spec.ts`.
- **Depends on:** 2.11, 5.6

---

## Epic 6 — Changes, Checks & PRs

### 6.1 Restyle Changes review (tree, turn filter, diff, states)
- **Type:** style · **Board(s):** 05 · **Spec:** §4 (05), §5h · **Gaps:** — · **Source:** `ui:composites/changes-review.tsx:123`, `ui:composites/changes-review.tsx:176`, `ui:composites/changes-review.tsx:293`, `ui:composites/changes-review.tsx:417`, `ui:composites/changes-review.tsx:71`, `ui:composites/code-review-view-machine.ts:26`
- **Scope:**
  - File tree with +/− and status letters, `TurnFilter` ("All turns ▾"), unified diff on Graphite tokens.
  - Skeleton, empty ("No changes yet"), error + Retry, `OmittedFilesNotice`.
  - Merge Code Review into Changes (shortcut ⌘⇧D).
- **Acceptance:**
  - [ ] Turn filter narrows the file list and the diff.
  - [ ] A diff with omitted files shows the notice.
- **Tests:** e2e extend `diffs-file-tree.spec.ts`, `enormous-review-diff.spec.ts`.
- **Depends on:** 1.1, 2.6, 3.2

### 6.2 Remove per-hunk and per-file revert controls
- **Type:** feature · **Board(s):** 05, 04c, 05+ · **Spec:** §6.1 · **Gaps:** F2-08 · **Source:** `ui:composites/changes-review.tsx:278`, `ui:composites/changes-review.tsx:309`, `contracts:661` (`Workspace.revertFile`), `contracts:667`, `desk:rpc-client.ts:740`
- **Scope:**
  - Remove `onRevertFile` / `onRevertLines` buttons everywhere; agent changes are kept by default.
  - "Revert to here" on a turn stays (13.4).
  - Option A: also delete `Workspace.revertFile` and its client wiring. Option B: keep it behind a right-click "Discard file changes" (Changes and Explorer) with a confirm dialog.
- **Acceptance:**
  - [ ] No Keep or Revert control renders in Changes or the file view.
  - [ ] Whichever option D3 picks, no dead RPC remains.
- **Tests:** update changes-review tests; e2e extend `diffs-file-tree.spec.ts`.
- **Depends on:** 6.1
- **Decided:** D3 — keep `Workspace.revertFile` as a right-click "Discard file changes" (Changes + Explorer) with a confirm dialog; per-hunk Keep/Revert stays removed.

### 6.3 Make review findings dismissable comment rows
- **Type:** feature · **Board(s):** 05, 05+ · **Spec:** §6.2 · **Gaps:** F2-07 · **Source:** `ui:composites/review-findings.tsx:181`, `ui:composites/review-findings.tsx:318`, `desk:review-store.ts:14`
- **Scope:**
  - Render findings with `CommentRow` (2.15): severity as text, message, `Ask agent to fix`, `Dismiss ×`.
  - "Dismissed (3) · Show" row; Undo from a toast.
  - Persist dismissals per session in the review store (14.7 adds the RPC if sync is needed).
- **Acceptance:**
  - [ ] Dismissed findings survive a reload and can be shown again.
  - [ ] Findings have no sparkle icon, gradient or AI stripe.
- **Tests:** unit for the store; e2e new `apps/desktop/e2e/review-findings-dismiss.spec.ts`.
- **Depends on:** 2.4, 2.15, 14.7

### 6.4 Restyle the review tray and inline comment composer
- **Type:** style · **Board(s):** 05 · **Spec:** §4 (05) · **Gaps:** — · **Source:** `ui:composites/review-tray.tsx:19`, `ui:composites/inline-comment-composer.tsx:13`, `ui:composites/review-code-view.tsx:302`
- **Scope:**
  - "Your review" tray with removable comments and a neutral Submit.
  - Inline composer under the selected line range.
- **Acceptance:**
  - [ ] A comment can be added, removed and submitted from the keyboard.
- **Tests:** extend review-tray tests; e2e extend `diffs-file-tree.spec.ts`.
- **Depends on:** 6.1, 2.15

### 6.5 Add the PR scope filter to Changes
- **Type:** feature · **Board(s):** 05, 04m, 05+ · **Spec:** §3f · **Gaps:** F3-06 · **Source:** `contracts:1822`, `contracts:1829`, `ui:composites/changes-review.tsx:176`
- **Scope:**
  - `PrFilter` ("PR: #481 ▾") next to the turn filter.
  - Empty state "No commits in this layer".
  - Reads per-layer ranges from 14.4.
- **Acceptance:**
  - [ ] Selecting a layer shows only that layer's files.
- **Tests:** e2e new `apps/desktop/e2e/pr-stack.spec.ts` (shared with 6.9).
- **Depends on:** 6.1, 14.4

### 6.6 Restyle the Checks view (readiness, timeline, threads)
- **Type:** style · **Board(s):** 06 · **Spec:** §4 (06), §6.3 · **Gaps:** — · **Source:** `ui:composites/pull-request-view.tsx:201`, `ui:composites/pr-side-panel.tsx:232`, `ui:composites/pr-check-row.tsx:16`, `ui:composites/pr-review-thread.tsx:136`, `ui:composites/pr-timeline-entry.tsx`, `desk:use-pull-request.ts:25`
- **Scope:**
  - `ReadinessChecklist` (StatusRow list: git, CI, review threads, todos, description).
  - Review threads with reply and resolve; timeline entries.
  - Merge PR into Checks (⌘⇧P); neutral icons, red only for a failing check.
- **Acceptance:**
  - [ ] Checks view shows no green fill; failing check shows a red icon only.
  - [ ] Reply and resolve call `Github.replyToThread` and `Github.resolveThread`.
- **Tests:** extend pull-request-view tests; e2e extend `github-cli-pr.spec.ts`.
- **Depends on:** 1.4, 2.5, 3.2

### 6.7 Show Create PR as a three-step stepper
- **Type:** feature · **Board(s):** 06, 06+ · **Spec:** §4 (06) · **Gaps:** F2-09 · **Source:** `desk:publish-machine.ts:59`, `desk:publish-machine.ts:61`, `core:domain.ts:547`, `ui:composites/pull-request-view.tsx:532`
- **Scope:**
  - `Create PR` expands to Commit · Push · Open PR rows driven by `PublishCheckpoint`.
  - Failure marks the failing row and offers `Retry from push` using `resumeFrom`.
  - `no-changes` shows "Nothing to publish".
- **Acceptance:**
  - [ ] A push failure shows `Retry from push` and the retry skips Commit.
- **Tests:** extend the publish-machine tests; e2e extend `github-publish.spec.ts`.
- **Depends on:** 2.5

### 6.8 Add "Stack on" base choice to Create PR
- **Type:** feature · **Board(s):** 06, 04m, 06+, 04m+ · **Spec:** §3f · **Gaps:** F3-02 · **Source:** `contracts:1850` (`Github.createPr`), `ui:composites/pull-request-view.tsx:532`
- **Scope:**
  - `Base: main ▾` with option `Stack on #481` defaulting to the top of the stack.
  - Option A (Jingler): Jingler creates the layer branch and PR through the GitHub API; needs `Github.createPr` base input and 14.2.
  - Option B (agent): the agent creates branches with git; Jingler only discovers and orders PRs the agent opens, and the selector is read-only.
- **Acceptance:**
  - [ ] Stacking creates a PR whose base is the previous layer's branch (Option A), or an opened PR is ordered into the stack (Option B).
- **Tests:** e2e extend `pr-stack.spec.ts` with chained fake PRs.
- **Depends on:** 6.7, 14.1, 14.2
- **Decided:** D4 — Jingler creates and restacks stacked-PR layer branches (`Create PR → Stack on #481`), via a new `Github.restack` RPC. Option B (agent-driven) is dropped.

### 6.9 Build the PR stack rail and header switcher
- **Type:** feature · **Board(s):** 04m · **Spec:** §3f · **Gaps:** — · **Source:** `ui:composites/pr-glyph.tsx:52`, `ui:composites/pr-glyph.tsx:106`, `ui:composites/pull-request-view.tsx:201`, `ui:composites/pr-side-panel.tsx:113`
- **Scope:**
  - `PrStackRail` in Checks (Graphite style) and `PrSwitcher` `PR #482 ▾ 2/3` with ⌥[ ⌥].
  - `pr-stack-machine.ts`: selected PR and merge-stack progress.
  - Stack glyph with count in the sidebar row (2.16).
- **Acceptance:**
  - [ ] ⌥] moves to the next PR and Checks follows.
  - [ ] Rail orders layers base-up.
- **Tests:** `desk:pr-stack-machine.test.ts`; e2e new `pr-stack.spec.ts`.
- **Depends on:** 14.1, 2.16, 6.6

### 6.10 Add Rebase and Restack actions
- **Type:** feature · **Board(s):** 04m, 04m+ · **Spec:** §3f · **Gaps:** F3-03 · **Source:** `contracts:1982` (`Github.updateBranch`), `desk:use-pull-request.ts:45`
- **Scope:**
  - Rail row badge "Base merged" + `Rebase onto main`; bulk `Restack` in the rail header.
  - Calls the new `Github.restack` (14.2); conflicts hand off to the agent (6.14).
- **Acceptance:**
  - [ ] After the base merges, Restack retargets and rebases every upper layer.
- **Tests:** unit on the restack plan; e2e extend `pr-stack.spec.ts`.
- **Depends on:** 6.9, 14.2
- **Decided:** D4 — Jingler creates and restacks stacked-PR layer branches (`Create PR → Stack on #481`), via a new `Github.restack` RPC. Option B (agent-driven) is dropped.

### 6.11 Add Merge stack with ordered progress
- **Type:** feature · **Board(s):** 04m, 04m+ · **Spec:** §3f · **Gaps:** F3-04 · **Source:** `ui:composites/pull-request-view.tsx:175`, `desk:use-pull-request.ts:34`, `contracts:1959` (`Github.merge`)
- **Scope:**
  - Upper PRs disabled with "Merge #481 first".
  - `Merge stack` shows a per-PR list with spinner then ✓ and halts at the first failure with `Resume`.
  - Squash or rebase on a lower PR adds an automatic restack row.
- **Acceptance:**
  - [ ] Merging a 3-PR stack merges in order; a failure stops and Resume continues.
- **Tests:** machine tests in `pr-stack-machine.test.ts`; e2e extend `pr-stack.spec.ts`.
- **Depends on:** 6.9, 6.13

### 6.12 Add the Draft PR state and Mark ready
- **Type:** feature · **Board(s):** 25e, 25e+ · **Spec:** §4 (25e) · **Gaps:** F2-10 · **Source:** `ui:composites/pr-side-panel.tsx:88`, `ui:composites/pr-side-panel.tsx:90`, `ui:composites/pr-side-panel.tsx:152`, `contracts:1971`
- **Scope:**
  - `Draft` pill beside the title and secondary `Mark ready for review`.
  - Inline error from `markReadyError`.
- **Acceptance:**
  - [ ] Marking ready calls `Github.markReady` and removes the pill.
- **Tests:** extend pr-side-panel tests; e2e extend `github-publish.spec.ts`.
- **Depends on:** 6.6

### 6.13 Add merge blocker rows and the merge split button
- **Type:** feature · **Board(s):** 25e, 25e+ · **Spec:** §4 (25e) · **Gaps:** F2-11 · **Source:** `ui:composites/pr-side-panel.tsx:37`, `ui:composites/pr-side-panel.tsx:173`, `ui:composites/pr-side-panel.tsx:300`, `ui:composites/pull-request-view.tsx:179`
- **Scope:**
  - A checklist row per blocker with its action ("Branch is 3 commits behind main · `Update branch`").
  - `MergeSplitButton`: `Squash and merge ▾` with merge, squash, rebase.
  - A failed merge shows `mergeError` under the button.
- **Acceptance:**
  - [ ] Merge is disabled with the first blocker's reason as a tooltip.
  - [ ] Method choice is remembered.
- **Tests:** extend pr-side-panel tests; e2e extend `github-publish.spec.ts`.
- **Depends on:** 6.6

### 6.14 Add "Ask agent to resolve conflicts"
- **Type:** feature · **Board(s):** 25e, 25e+ · **Spec:** §4 (25e) · **Gaps:** F2-12 · **Source:** `ui:composites/pr-side-panel.tsx:173`, `ui:composites/pr-side-panel.tsx:192`
- **Scope:**
  - Button posts a conflict-resolution prompt into the chat and shows "Agent is resolving…" with the file list.
  - Replaces the "conflicts need the code" dead end.
- **Acceptance:**
  - [ ] Clicking posts one prompt naming the conflicting files and shows the resolving state.
- **Tests:** e2e new `apps/desktop/e2e/pr-conflicts.spec.ts`.
- **Depends on:** 6.13

### 6.15 Add the Workflow section to Checks
- **Type:** feature · **Board(s):** 06 · **Spec:** §3c · **Gaps:** — · **Source:** `desk:workspace-workflow-bar.tsx:16`, `ui:app/tab-contributions.ts:56`
- **Scope:**
  - Collapsible Workflow section (setup, run steps, retry/skip) inside Checks; collapsed row in 25e.
  - Existing Workflow tab contribution stays registered for deep links.
- **Acceptance:**
  - [ ] Setup retry and skip work from the section.
- **Tests:** e2e extend `workspace-workflow.spec.ts`.
- **Depends on:** 6.6, 3.2

### 6.16 Restyle the PR inbox with loading and Retry
- **Type:** feature · **Board(s):** 19a, 08+ · **Spec:** §5h · **Gaps:** F2-02 · **Source:** `ui:composites/pull-request-inbox.tsx:73`, `ui:composites/pull-request-inbox.tsx:102`, `ui:composites/pull-request-inbox-filter-machine.ts:17`
- **Scope:**
  - Filters, rows, `ListSkeleton`, `EmptyState`, `InlineError` with Retry.
  - Retry re-runs `Github.inbox` / `Github.teamPrs`.
- **Acceptance:**
  - [ ] A failed load shows Retry and recovers.
- **Tests:** extend inbox tests; e2e extend `github-team-pr.spec.ts`.
- **Depends on:** 2.6, 2.2

### 6.17 Restyle the issue inbox with loading and Retry
- **Type:** feature · **Board(s):** 19b, 08+ · **Spec:** §5h · **Gaps:** F2-02 · **Source:** `ui:composites/issue-inbox.tsx:86`, `ui:composites/issue-inbox.tsx:93`, `ui:composites/issue-inbox-filter-machine.ts:17`
- **Scope:**
  - Same pattern as 6.16 for `Github.issueInbox`.
- **Acceptance:**
  - [ ] A failed load shows Retry and recovers.
- **Tests:** extend inbox tests; e2e extend `github-issues-inbox.spec.ts`.
- **Depends on:** 2.6, 2.2

### 6.18 Build the PR view header and sub-tabs
- **Type:** feature · **Board(s):** 26a, 26b · **Spec:** §6.17 · **Gaps:** — · **Source:** `ui:composites/pull-request-view.tsx:201`, `ui:composites/pull-request-view.tsx:45` (`StatePill`), `ui:composites/pull-request-view.tsx:264` (`renderPullRequestBody`), `ui:composites/pull-request-view.tsx:639` (`CommitEvidence`), `core:domain.ts:1652` (`PullRequest`), `desk:pull-request-pane.tsx:13`, `contracts:1686` (`Github.pr`), `ui:app/tab-contributions.ts:56` (`BUILTIN_TAB`)
- **Scope:**
  - Header: `title` + grey `#number`; one meta line: state pill (Open / Draft / Merged / Closed, neutral, one line) · `author.login` avatar · `headRefName → baseRefName` mono with copy · commits · files `+additions −deletions` · relative `createdAt`.
  - Actions: `Open on GitHub` icon, `Open session` secondary (`onOpenSession`), `⋯` with Mark ready / Close PR (destructive) / Copy branch.
  - 28px underline sub-tabs `Conversation · Commits N · Files N · Checks a/b` with counts from `commits`, `changedFiles`, `checks`; Commits renders `commitItems`.
  - The tab opens as `PR #482` from the header PR chip, the PR inbox, Checks and ⌘K.
- **Acceptance:**
  - [ ] Every header field renders from a `PullRequest` fixture; missing fields are omitted, not shown as "—".
  - [ ] State pill and counts stay on one line at 600px tab width.
  - [ ] Sub-tab counts match the data and ←/→ switch tabs.
- **Tests:** extend `ui:composites/pull-request-view.test.tsx`; e2e new `apps/desktop/e2e/pr-view.spec.ts`.
- **Depends on:** 1.1, 2.1, 2.13, 3.3

### 6.19 Rebuild the PR Conversation (description, timeline, threads, composer)
- **Type:** feature · **Board(s):** 26a · **Spec:** §6.17 · **Gaps:** — · **Source:** `ui:composites/pull-request-view.tsx:264`, `ui:composites/pr-timeline-entry.tsx:28`, `ui:composites/pr-review-thread.tsx:136`, `ui:composites/pr-review-composer.tsx:12`, `core:domain.ts:1536` (`PrTimelineItem`), `core:domain.ts:1604` (`PrReviewThread`), `contracts:1910` (`Github.submitReview`), `contracts:1933` (`Github.resolveThread`), `contracts:1946` (`Github.replyToThread`)
- **Scope:**
  - `body` as markdown in a 720px reading column ("No description provided." when null).
  - Timeline rows from `PrTimelineItem` (commented / approved / changes_requested as a grey verb, never coloured); `reviewThreads` inline with their diff hunk, Reply and Resolve.
  - `Send to agent` per entry (existing `onSendEntryToAgent`, stays `Sent` for `sentEntryIds`).
  - Sticky `PrReviewComposer`: Comment / Approve / Request changes (destructive outline) and the "Also send to agent" toggle; approve and request changes disabled when `author.login === viewerLogin`.
- **Acceptance:**
  - [ ] Approve and Request changes are disabled on your own PR; Comment still works.
  - [ ] Reply and Resolve call `Github.replyToThread` and `Github.resolveThread`.
  - [ ] No timeline row has a green or amber fill.
- **Tests:** extend `pull-request-view.test.tsx`, `pr-review-thread.test.tsx`, `pr-review-composer.test.tsx`; e2e extend `github-cli-pr.spec.ts` and `pr-view.spec.ts`.
- **Depends on:** 6.18, 2.15

### 6.20 Build the PR right rail
- **Type:** feature · **Board(s):** 26a, 26c · **Spec:** §6.17 · **Gaps:** — · **Source:** `ui:composites/pr-side-panel.tsx:113`, `ui:composites/pr-side-panel.tsx:78` (`PrSidePanelProps`, `width`), `ui:composites/pull-request-view.tsx:63` (`LabelChip`), `core:domain.ts:1511` (`PrReviewer`)
- **Scope:**
  - 280px rail, collapsing to a sheet below 900px content width. Sections: Reviewers (`reviewers[]` login + state word), Labels (one-line pills), Checks summary, Linked issue, Stack (when 14.1 lands), then the merge box.
  - Merge box lays out the method picker + `Merge`; blocker rows, `Update branch`, conflicts and Draft states are owned by 6.12–6.14 and are only placed here.
- **Acceptance:**
  - [ ] Rail collapses at 900px and reopens from a header button.
  - [ ] Sections with no data are hidden, not empty.
- **Tests:** extend `pull-request-view.test.tsx`; e2e extend `pr-view.spec.ts`.
- **Depends on:** 6.18, 6.13

### 6.21 Add the PR Files and Checks sub-tabs
- **Type:** feature · **Board(s):** 26b · **Spec:** §6.17 · **Gaps:** — · **Source:** `contracts:1822` (`Github.files`), `contracts:1829` (`Github.diff`), `ui:composites/changes-review.tsx:176`, `ui:composites/pr-check-row.tsx:16`, `ui:composites/pull-request-view.tsx:667` (`CheckEvidence`)
- **Scope:**
  - Files: the Changes renderer filtered to this PR's files via `Github.files` / `Github.diff`; read-only for team PRs.
  - Checks: `PrCheckRow` list (neutral icons, red icon only for a failing check, duration, `detailsUrl` link).
- **Acceptance:**
  - [ ] Files shows the PR's files only, not the working tree.
  - [ ] A failing check shows a red icon and no coloured row.
- **Tests:** extend `pull-request-view.test.tsx`; e2e extend `github-team-pr.spec.ts`.
- **Depends on:** 6.18, 6.1, 6.5

### 6.22 Draw PR view loading, not-connected, no-PR, error and read-only states
- **Type:** feature · **Board(s):** 26c · **Spec:** §6.17, §5h · **Gaps:** — · **Source:** `ui:composites/pull-request-view.tsx:138` (`connectionMessage`, `publish`, `readOnly`), `contracts:1714` (`Github.teamPr`), `contracts:1761` (`Github.prBySlug`), `core:domain.ts:547` (`PublishCheckpoint`)
- **Scope:**
  - Loading skeleton; not connected (`connectionMessage` + `Connect GitHub`); no PR yet (`Create PR` or publish progress, see 6.7); error with Retry.
  - `readOnly` team PRs from the inbox: no merge or review controls, `Start session from this PR`.
  - Merged and Closed header states.
- **Acceptance:**
  - [ ] Each state renders from a story and from the data hook.
  - [ ] Read-only view exposes no write action.
- **Tests:** extend `pull-request-view.test.tsx`; e2e extend `github-team-pr.spec.ts`.
- **Depends on:** 6.18, 2.6

### 6.23 Extract the shared PR/issue reading shell
- **Type:** feature · **Board(s):** 26d · **Spec:** §6.18 · **Gaps:** — · **Source:** `plugins/github-issues/src/ui.tsx:106` (`IssueTab`), `plugins/github-issues/src/ui.tsx:275` (`IssueMetadata`), `packages/plugin-sdk/src/ui.ts:58` (`Avatar` export), `packages/plugin-sdk/src/ui.ts:62` (`IssueLabelChip` export), `ui:app/tab-contributions.ts:146` (`issueProviderId`)
- **Scope:**
  - `ReadingShell` in `packages/ui`: header (title + grey identifier, meta line, actions), 720px column and 280px rail; used by 6.18 and the issue view.
  - Export it from the plugin SDK UI entry so plugins render it; plugins cannot reach the network from the UI half.
  - Restyle `IssueTab` header: provider logo, state pill, author, relative `updatedAt`, comment count; `Start workspace` primary (or `Open workspace` when linked), `⋯` with Close issue (destructive) / Copy link.
- **Acceptance:**
  - [ ] PR and issue headers share one component and visually match.
  - [ ] `github-issues` renders through the shell with no private header markup.
- **Tests:** unit for the shell; extend plugin tests; e2e new `apps/desktop/e2e/issue-view.spec.ts`.
- **Depends on:** 6.18

### 6.24 Add issue comments and a comment composer
- **Type:** feature · **Board(s):** 26d · **Spec:** §6.18 · **Gaps:** — · **Source:** `plugins/github-issues/src/ui.tsx:72` (`Comment`), `core:domain.ts:1794` (`IssueComment`), `contracts:1749` (`Github.issueCommentBySlug`), `contracts:1755` (`Github.issueCloseBySlug`), `contracts:1798` (`Github.closeIssue`), `plugins/linear/src/main.ts:22` (`CREATE_COMMENT_MUTATION`)
- **Scope:**
  - Markdown body ("No description provided."), `comments[]` as plain rows (avatar, login, relative time, body).
  - Composer under the thread: `Comment` primary, `Close with comment` secondary.
  - Open question: `github-issues` `main.ts` only reads comments today; posting needs a host-side write through the authentication door, like Linear's `CREATE_COMMENT_MUTATION`.
- **Acceptance:**
  - [ ] Posting appears in the thread without a reload; `Close with comment` closes the issue.
  - [ ] A failed post keeps the draft and shows an inline error.
- **Tests:** extend `plugins/github-issues/src/main.test.ts`; e2e extend `github-issues-inbox.spec.ts`, `issue-view.spec.ts`.
- **Depends on:** 6.23

### 6.25 Add the issue rail and states
- **Type:** feature · **Board(s):** 26d, 26e, 08+ · **Spec:** §6.18 · **Gaps:** F2-03 · **Source:** `plugins/github-issues/src/ui.tsx:275`, `plugins/github-issues/src/ui.tsx:162`, `ui:composites/issue-picker-list.tsx:116` (`IssueLabelChip`), `core:domain.ts:1805` (`IssueDetail`), `contracts:1804` (`Github.issue`)
- **Scope:**
  - 280px rail: Assignees, Labels (one-line pills), Linked workspace / PR, Provider + repository. Only fields that exist; nothing invented.
  - States: loading skeleton; "No issue is linked to this session." + `Link issue`; "couldn't be loaded" + mono reason + Retry; closed issue banner (neutral) + `Reopen`.
  - Open question: no reopen RPC exists (only `Github.closeIssue` / `Github.issueCloseBySlug`); drop `Reopen` or add the RPC.
- **Acceptance:**
  - [ ] Every state renders from a story; the rail hides empty sections.
  - [ ] An issue already linked to a workspace shows `Open workspace` (14.9).
- **Tests:** extend plugin tests; e2e extend `issue-view.spec.ts`.
- **Depends on:** 6.23, 14.9

### 6.26 Render Linear issues through the shared issue view
- **Type:** feature · **Board(s):** 26e · **Spec:** §6.18 · **Gaps:** — · **Source:** `plugins/linear/src/ui.tsx:478` (`IssueTab`), `plugins/linear/src/ui.tsx:281` (`DetailView`), `plugins/linear/src/ui.tsx:258` (`Metadata`), `plugins/linear/src/ui.tsx:163` (`UnlinkedView`), `plugins/linear/src/ui.tsx:143` (`Comment`), `plugins/linear/src/linear-issue-machine.ts:73`, `desk:plugin-loader.ts:472`
- **Scope:**
  - `DetailView`, `Metadata` and `Comment` use `ReadingShell` (6.23) and the same comment composer; identifier is `ENG-123`, provider logo is `LinearMark` (`:120`).
  - Keep `linearIssueMachine` and `LinearSetupFlyout` (`:333`); only the markup changes. Linear-only states (needs setup, no team selected) stay in the plugin.
- **Acceptance:**
  - [ ] A Linear issue and a GitHub issue are visually identical apart from provider data.
  - [ ] The Linear setup flow still works.
- **Tests:** extend `plugins/linear/src/ui.test.tsx`; e2e extend `linear-plugin.spec.ts`.
- **Depends on:** 6.23, 6.24

---

### 6.27 Add an agent scope to Changes that aggregates subagent worktrees
- **Type:** feature · **Board(s):** 05, 20c · **Spec:** §6.19 · **Gaps:** — · **Source:** `ui:composites/changes-review.tsx`, `desk:changes-review.tsx`, `core:runtime/subagent-fleet.ts:81`
- **Scope:**
  - Scope control next to the turn filter: `All agents ▾` (default) · `Main` · one entry per subagent with a `workspace`.
  - `All agents`: each file row gets a one-line agent chip; a file touched by several trees groups one row per agent; header diff stat sums every tree.
  - Diff reads per tree (main checkout + each child `workspace.path`); reuse the existing diff RPCs with a workspace path, add a payload field only if none accepts one.
  - Scope state lives in the subagent-view machine from 8.2 (shared with 8.12), not a local `useState`.
- **Acceptance:**
  - [ ] Changes made by a child in its own worktree appear in the main session's Changes under `All agents`.
  - [ ] Picking one agent shows only that tree's files; `Main` hides child files.
  - [ ] A file edited in two trees shows two agent rows; agent chips stay on one line.
- **Tests:** unit for merging per-tree file lists; e2e new `apps/desktop/e2e/subagent-worktree-changes.spec.ts`.
- **Depends on:** 14.12, 8.2, 2.2

### 6.28 Show every session PR (main and subagents) in the header PR chip
- **Type:** feature · **Board(s):** 06, 19a, 20c · **Spec:** §6.19 · **Gaps:** — · **Source:** `core:runtime/subagent-fleet.ts:81`, `ui:composites/pr-glyph.tsx:52`, `ui:composites/pull-request-inbox.tsx:102`
- **Scope:**
  - Header chip becomes `PRs · 3 ▾` when children own PRs; each row: PR number, agent, branch mono, state word.
  - Selecting a row opens that PR's view (6.18) in the content area.
  - PR inbox (19a) gains a `This session` filter covering main + child PRs.
  - Child PRs stay out of the main stack (§3f) unless stacked on it.
- **Acceptance:**
  - [ ] A child that opens a PR appears in the chip list without a reload.
  - [ ] `This session` lists exactly the main and child PRs.
- **Tests:** unit for building the list from session `prs` + fleet nodes; e2e extend `subagent-worktree-changes.spec.ts`.
- **Depends on:** 14.12, 14.1, 6.18

## Epic 7 — Plans, explanation & agent asks

### 7.1 Restyle Plan review keeping today's layout
- **Type:** style · **Board(s):** 17a · **Spec:** §5k · **Gaps:** — · **Source:** `ui:screens/plan-review.tsx:142`, `ui:screens/plan-review.tsx:254`, `ui:composites/plan-stage-card.tsx:224`
- **Scope:**
  - Keep the layout (content tab, max-w 1120, sticky 208px Contents nav, stage cards, 320px draft, margin threads, pinned footer).
  - Restyle only: `Request changes` as red outline, `Approve` as the neutral primary, General feedback secondary.
  - No structural change to `plan-review.tsx`.
- **Acceptance:**
  - [ ] DOM structure of the layout is unchanged; only tokens and variants differ.
- **Tests:** e2e extend `plan-mode.spec.ts`, `rich-plan-scratchpad.spec.ts`.
- **Depends on:** 1.2

### 7.2 Handle stale plans and approval while revising
- **Type:** feature · **Board(s):** 17a, 17a+ · **Spec:** §5k · **Gaps:** F2-04 · **Source:** `ui:composites/plan-card.tsx:142`, `ui:screens/plan-review.tsx:142`, `ui:screens/plan-review.tsx:340`
- **Scope:**
  - `Approve` disabled with reason "Agent is revising this plan".
  - Banner "Plan changed since you opened it · Reload".
- **Acceptance:**
  - [ ] A plan revised while open shows the banner and Reload fetches the new version.
- **Tests:** unit for plan state; e2e extend `plan-mode.spec.ts`.
- **Depends on:** 2.11, 7.1

### 7.3 Confirm before discarding unsaved plan comments
- **Type:** bug · **Board(s):** 17a, 17a+ · **Spec:** §5k · **Gaps:** F2-05 · **Source:** `ui:composites/plan-comment-store.ts:4`, `ui:composites/plan-comment-layer.tsx:16`
- **Scope:**
  - ConfirmDialog "Discard 1 unsaved comment?" with `Keep editing` (primary) and `Discard`.
  - Triggers on Request changes, Approve and tab close with drafts.
- **Acceptance:**
  - [ ] No unsaved draft is lost without the dialog.
- **Tests:** unit for the draft guard; e2e extend `plan-mode.spec.ts`.
- **Depends on:** 2.10

### 7.4 Show plan comments as floating avatars
- **Type:** feature · **Board(s):** 17a, 17b · **Spec:** §6.12 · **Gaps:** — · **Source:** `ui:composites/plan-comment-layer.tsx:16`, `ui:screens/plan-review.tsx:254`
- **Scope:**
  - 20px avatar per thread aligned to its anchored line; agent threads use the mono Jingler mark; reply count badge; −6px stacking.
  - Hover or focus opens the thread card as a popover; click pins; the anchored range stays tinted while hovered.
  - Keyboard: `Tab` reaches avatars, `Enter` pins, `Esc` closes.
- **Acceptance:**
  - [ ] Overlapping threads stack; hover shows the 320px card; Esc closes.
- **Tests:** component test for keyboard behaviour; e2e extend `rich-plan-scratchpad.spec.ts`.
- **Depends on:** 2.13, 7.1

### 7.5 Draw plan execution failed and interrupted rows
- **Type:** feature · **Board(s):** 17b, 17b+ · **Spec:** §5k · **Gaps:** F2-06 · **Source:** `ui:composites/plan-progress-dock.tsx:18`, `ui:composites/plan-progress-dock.tsx:21`, `ui:composites/plan-card.tsx:110`
- **Scope:**
  - Neutral icon rows; failed gets a red icon, "Step 3 failed" and `Retry step` / `Ask agent`.
  - Interrupted: "Stopped by you" + `Resume`; blocked state drawn.
- **Acceptance:**
  - [ ] All `PlanProgressStatus` values render in a story.
- **Tests:** extend dock tests; e2e extend `plan-tools-any-mode.spec.ts`.
- **Depends on:** 2.5

### 7.6 Add the Plannotator disconnected card
- **Type:** feature · **Board(s):** 17a, 17a+ · **Spec:** §6.8 · **Gaps:** F8-06 · **Source:** `contracts:1101`, `cli:plannotator-recovery.ts`
- **Scope:**
  - Card inside the plan tab "Plan reviewer disconnected" + `Reopen`, wired to the existing recovery RPC.
  - Confirm where the recovery surfaces today and remove any duplicate.
- **Acceptance:**
  - [ ] Killing the reviewer shows the card; Reopen restores the session.
- **Tests:** extend plannotator-recovery tests; e2e extend `plan-mode.spec.ts`.
- **Depends on:** 2.11

### 7.7 Restyle the Explanation view with loading and empty states
- **Type:** style · **Board(s):** 17c · **Spec:** §5k · **Gaps:** — · **Source:** `ui:screens/explanation-view.tsx:15`, `desk:use-explanation-document.ts`, `contracts:1605`
- **Scope:**
  - Skeleton of headings while loading, TOC rail, empty text, error + Retry.
- **Acceptance:**
  - [ ] Loading, empty and error states render from stories.
- **Tests:** e2e new `apps/desktop/e2e/explanation.spec.ts`.
- **Depends on:** 2.6

### 7.8 Restyle agent question cards and approval gates
- **Type:** style · **Board(s):** 17d · **Spec:** §5k · **Gaps:** — · **Source:** `ui:composites/question-card.tsx:19`, `ui:composites/approval-gate.tsx:20`, `contracts:1046`, `contracts:1035`
- **Scope:**
  - Neutral cards, numbered options, free-text answer; amber only on the needs-you tick.
  - "Switch session to Auto" link via `Agent.setMode`.
- **Acceptance:**
  - [ ] Options are answerable by number key; focus lands on option 1.
- **Tests:** extend question-card tests; e2e new `apps/desktop/e2e/needs-you.spec.ts`.
- **Depends on:** 1.2

### 7.9 Support long commands in agent asks
- **Type:** feature · **Board(s):** 17d, 22d · **Spec:** §6.11 · **Gaps:** — · **Source:** `ui:composites/approval-gate.tsx:20`, `ui:composites/question-card.tsx:19`, `desk:notifier.ts:55`
- **Scope:**
  - Mono block, `pre-wrap` and `break-all`, capped at 6 lines with `Show all · 42 lines`, scrolls inside the card up to 320px, `Copy` icon button.
  - Approve and deny stay pinned under the block.
  - One-line summary (`Run pnpm test --filter …`) feeds notifications and the sidebar.
- **Acceptance:**
  - [ ] A 42-line command collapses to 6 lines; the buttons stay visible when expanded.
  - [ ] Notification body uses the one-line summary.
- **Tests:** unit for summary and line count; e2e extend `needs-you.spec.ts`.
- **Depends on:** 7.8, 1.2

---

## Epic 8 — Subagent fleet, browser preview & terminal

### 8.1 Add the subagent chip popover in the lane header
- **Type:** feature · **Board(s):** 20, 04f+ · **Spec:** §6.16 · **Gaps:** F6-01 · **Source:** `ui:app/subagent-tab-bar.tsx:7`, `desk:subagent-fleet-machine.ts:140`, `ui:composites/agent-card.tsx:7`
- **Scope:**
  - Chip `2 subagents ▾` (pulses while spawning; overflow becomes `+N`) opens a popover: running children (status word, agent, one-line task, elapsed), then `Finished · 4` replacing the History menu.
  - Transcript row "Spawned 3 subagents", `View` on the subagent tool card, sidebar `· 2 agents`, ⌘K → "Go to subagent…".
  - Replaces the 32px "Subagents" strip under the chat.
- **Acceptance:**
  - [ ] Spawning shows the chip and transcript row without opening the fleet.
  - [ ] `View` and the popover rows open the same subagent.
- **Tests:** new `ui:app/subagent-tab-bar.test.tsx`; e2e extend `subagents-outlive-turn.spec.ts`.
- **Depends on:** 4.3, 2.9

### 8.2 Swap the chat lane to a subagent in place
- **Type:** feature · **Board(s):** 20a · **Spec:** §6.16 (operator decision: no separate fleet view, no "Open beside") · **Gaps:** — · **Source:** `ui:app/subagent-view.tsx:110`, `ui:app/subagent-view.tsx:95`, `desk:conversation-pane.tsx:1099`, `desk:subagent-tab-store.ts`
- **Scope:**
  - Clicking a dropdown row swaps the lane's transcript for the child's, at the same width, in every chat mode (Full/Docked/Collapsed/Focus/drawer). The content area doesn't change.
  - Lane header becomes a breadcrumb `Fix PR inbox › reviewer ▾` (▾ jumps to sibling subagents) with `← Main` and Esc.
  - Selected-thread state couples lane content, header and composer, so model it as `subagent-view-machine.ts` (AGENTS.md rule) with `*.test.ts`, replacing `subagent-tab-store` selection.
- **Acceptance:**
  - [ ] Selecting a subagent replaces the main transcript in the same lane; nothing opens in the content area.
  - [ ] Esc / `← Main` returns to the main thread with its draft and scroll position intact.
  - [ ] Sibling switch via the breadcrumb ▾ works without going back to main.
- **Tests:** `desk:subagent-view-machine.test.ts`; e2e new `apps/desktop/e2e/subagent-view.spec.ts`.
- **Depends on:** 8.1

### 8.3 Add the subagent meta strip, Details and read-only bar
- **Type:** feature · **Board(s):** 20a, 20b · **Spec:** §6.16 · **Gaps:** — · **Source:** `core:runtime/subagent-fleet.ts:81` (`SubagentFleetNode`), `ui:components/provider-icon.tsx:85`, `ui:app/subagent-view.tsx:110`
- **Scope:**
  - Meta strip under the breadcrumb, up to 3 rows to fit the ~360px lane: (1) `ProviderIcon` + `model` · `status` + `phase` · elapsed from `startedAt` · `Details ▾`; (2) `currentTool` (mono) · `usage.inputTokens/outputTokens` · `usage.toolCalls` · `usage.costUsd` (only when > 0) · `Background` pill; (3) `artifacts[]` chips that open in the content area.
  - `Details ▾` expands to a key/value grid (adds run id, started time).
  - The task is the first, quoted item in the transcript.
  - Composer is replaced by a read-only bar: `Subagent of <main> · read-only` + `Stop` (destructive text) while running; `attention.message` + `Reply` when set; `terminal.summary` + `Retry` when `terminal.retryable`; `Stopped by you · 2m 10s`.
- **Acceptance:**
  - [ ] Every strip field renders from a `SubagentFleetNode` fixture; null fields are omitted, not shown as "—".
  - [ ] Pills and chips stay on one line; each row truncates the tool/task text, never the pills.
  - [ ] Reply sends to the child, Retry restarts it, Stop shows pending then the stopped line.
- **Tests:** extend `subagent-view.test.tsx` per field and per bar state; e2e `apps/desktop/e2e/subagent-view.spec.ts`.
- **Depends on:** 8.2, 2.1

### 8.4 Render workflow fleets as a tree
- **Type:** feature · **Board(s):** 20 · **Spec:** §6.16 · **Gaps:** — · **Source:** `core:runtime/subagent-fleet.ts:50`, `desk:subagent-fleet-machine.ts:191`
- **Scope:**
  - Indented orchestrator → children tree in the popover, status word only.
  - Failed rows get the red icon and `View error`.
- **Acceptance:**
  - [ ] Nested children indent by depth; no row has a coloured fill.
- **Tests:** unit for tree building; e2e extend `fleet-durable-status.spec.ts`.
- **Depends on:** 8.1

### 8.5 Draw subagent view states
- **Type:** feature · **Board(s):** 20b · **Spec:** §6.16, §5h · **Gaps:** — · **Source:** `ui:app/subagent-view.tsx:110`, `desk:subagent-fleet-machine.ts:205`
- **Scope:**
  - Loading skeleton, "This agent has no transcript (orchestrator)", error + Retry.
  - A finished child keeps its view open instead of jumping to main.
- **Acceptance:**
  - [ ] Each state renders from a story and from the machine.
- **Tests:** machine test for `SYNC` not resetting an open child; extend `subagent-view.test.tsx`.
- **Depends on:** 8.2, 2.6

### 8.6 Move peer agents into the popover
- **Type:** feature · **Board(s):** 20 · **Spec:** §6.16 · **Gaps:** — · **Source:** `ui:app/agent-roster.tsx:6`, `ui:app/agent-roster.test.tsx`
- **Scope:**
  - `Peers · 2` group in the popover, each row with `Message`.
  - Remove the "Peer agents" disclosure.
- **Acceptance:**
  - [ ] Messaging a peer works from the popover.
- **Tests:** update `agent-roster.test.tsx`.
- **Depends on:** 8.1, 15.9

### 8.7 Draw agent card end states and the Done group
- **Type:** feature · **Board(s):** 20 · **Spec:** §6.3, §6.16 · **Gaps:** F6-04, F6-07 · **Source:** `ui:composites/agent-card.tsx:4`, `core:runtime/subagent-fleet.ts:50`, `desk:subagent-fleet-machine.ts:31`
- **Scope:**
  - `AgentState` gains `failed` and `stopped`; neutral icon rows, red icon plus reason and `Resume` / `View transcript` on failure.
  - Finished children move to a `Done (3)` group and toast "researcher finished" with `View`.
- **Acceptance:**
  - [ ] Completed, stopped and failed all render distinctly.
  - [ ] A finish toast does not fire when that child is open.
- **Tests:** extend agent-card tests; e2e extend `fleet-durable-status.spec.ts`.
- **Depends on:** 2.4, 8.1

### 8.8 Add the follow toggle to the subagent view
- **Type:** feature · **Board(s):** 20a · **Spec:** §6.16 · **Gaps:** F6-02 · **Source:** `ui:composites/composer.tsx:308`, `ui:composites/composer.tsx:310`, `ui:app/subagent-view.tsx:110`
- **Scope:**
  - Follow toggle in the subagent header.
  - Open question: follow that subagent's file edits? Default to following the edits of the viewed child; confirm in review.
- **Acceptance:**
  - [ ] With follow on, files edited by the child open in the content area.
- **Tests:** e2e extend `subagents-outlive-turn.spec.ts`.
- **Depends on:** 8.2

### 8.9 Rebuild the browser preview toolbar
- **Type:** feature · **Board(s):** 21 · **Spec:** §6.9 · **Gaps:** — · **Source:** `ui:app/preview-dock.tsx:27`, `ui:app/preview-dock.tsx:136`, `desk:preview-dock-view.tsx:15`, `desk:preview-dock-machine.ts:118`
- **Scope:**
  - `IconButtonGroup` for back · forward · reload · open external; a second group for device widths.
  - Transcript chip `Preview ready · Open browser`; loading and error states with Retry.
  - Shortcut ⌘⇧B.
- **Acceptance:**
  - [ ] Back and forward are disabled when there is no history.
  - [ ] Preview-ready chip opens the browser view.
- **Tests:** extend preview-dock tests; e2e extend `previews.spec.ts`.
- **Depends on:** 2.1, 3.3

### 8.10 Make the terminal dock resizable with tabs and states
- **Type:** feature · **Board(s):** 07, 04j · **Spec:** §4 (07) · **Gaps:** — · **Source:** `ui:app/terminal-panel.tsx:53`, `ui:app/terminal-panel.tsx:358`, `desk:terminal-dock-view.tsx:26`, `contracts:1998`
- **Scope:**
  - Replace the fixed 256px height with a draggable handle (default 240).
  - Multi-tab strip, "No terminals" empty state with `New terminal`, shell-exited state with Restart.
  - Terminal inside a content group uses `TerminalPanel`.
- **Acceptance:**
  - [ ] Height persists per workspace; an exited shell offers Restart.
- **Tests:** e2e extend `terminal.spec.ts`.
- **Depends on:** 4.6

---

### 8.11 Show branch, diff stat and PR on subagent dropdown rows and meta strip
- **Type:** feature · **Board(s):** 20, 20a, 20c · **Spec:** §6.19, §6.16 · **Gaps:** — · **Source:** `ui:app/subagent-tab-bar.tsx:7`, `core:runtime/subagent-fleet.ts:81`
- **Scope:**
  - Dropdown rows add `workspace.branch` (mono, truncates), `+42 −8`, PR number; shared-checkout children show `Shared checkout`.
  - 20a meta strip adds the branch and a PR chip that opens 6.18.
- **Acceptance:**
  - [ ] Rows stay one line; branch truncates before stats or PR.
- **Tests:** extend `subagent-view.test.tsx`.
- **Depends on:** 14.12, 8.1, 8.3

### 8.12 Isolate Changes, Checks, file tree, terminal and timeline to the viewed subagent
- **Type:** feature · **Board(s):** 20d · **Spec:** §6.19 · **Gaps:** — · **Source:** `ui:app/subagent-view.tsx:110`, `desk:conversation-pane.tsx:1099`, `ui:app/conversation-view.tsx` (PreviewRail)
- **Scope:**
  - While the lane shows a child (8.2), every content view reads the child's `workspace` and `prNumber`: Changes, Checks/PR, Explorer `Changed` filter, new terminals' cwd, timeline rail.
  - One-line scope bar at the top of the content area: `Scoped to reviewer · feat/review-retry · PR #491` + `Show all agents`; Esc / `← Main` restores the aggregate.
  - Shared-checkout children scope by the files they edited.
  - States: worktree removed (`changes were merged into …` / `changes discarded`), `No changes yet`.
  - Extend `subagent-view-machine.ts` (8.2) with the scope; one transition updates lane + content scope together.
- **Acceptance:**
  - [ ] Entering a child scopes Changes and PR to it; `← Main` restores all agents in one step.
  - [ ] A terminal opened while scoped starts in the child worktree.
- **Tests:** machine test for scope enter/exit/sibling switch; e2e extend `subagent-view.spec.ts`.
- **Depends on:** 8.2, 6.27, 6.28, 14.12

## Epic 9 — Entry flow (login, onboarding, home, new workspace)

### 9.1 Restyle Login with waiting, sent and error states
- **Type:** feature · **Board(s):** 01, 01+ · **Spec:** §5a · **Gaps:** F1-01, F1-02, F1-03, F1-04 · **Source:** `ui:screens/login-screen.tsx:10`, `ui:screens/login-screen.tsx:51`, `ui:composites/auth-card.tsx:27`, `ui:composites/magic-link-form.tsx:38`
- **Scope:**
  - `LoginState` gains `waiting` ("Finish signing in in your browser…") with `Cancel` and `Copy sign-in link`; after 2 min "Still waiting? Try again".
  - Error state: inline red line with the cause, `Retry`, `Use a different method`.
  - Sent state: "Check morgan@… — link expires in 15 min", `Resend` with 30 s cooldown ("Sent again ✓"), `Use a different email`.
  - Primary button is neutral; the colour mark and `JinglerWordmark` lockup are the only rose.
- **Acceptance:**
  - [ ] Every `LoginState` renders from a story.
  - [ ] Cancel, Retry and Resend buttons fire the callbacks wired in 15.2.
- **Tests:** story matrix; e2e extend `apps/desktop/e2e/auth.spec.ts`.
- **Depends on:** 1.2, 15.2
- **Decided:** D1 — sign-in is optional; the app runs signed out (today's `App.tsx` behaviour). Board 01 becomes the in-app sign-in dialog skin; no full-screen wall.

### 9.2 Resolve the sign-in wall behaviour
- **Type:** feature · **Board(s):** 01, 25c, 01+, 25c+ · **Spec:** §5a · **Gaps:** F1-15 · **Source:** `apps/desktop/src/renderer/App.tsx:2116`, `ui:composites/sign-in-dialog.tsx:14`
- **Scope:**
  - Option A (optional, today): keep signed-out mode; onboarding must not require auth; sign-in is offered from the sidebar footer via the dialog.
  - Option B (mandatory): gate the app behind the wall until `auth-machine` reaches `signedIn`.
  - Either way document the chosen behaviour in `AGENTS.md` or the auth spec.
- **Acceptance:**
  - [ ] Signed-out launch behaves as the decided option, covered by a test.
- **Tests:** extend `apps/desktop/src/renderer/auth-machine.test.ts`; e2e extend `auth.spec.ts`.
- **Depends on:** 9.1
- **Decided:** D1 — sign-in is optional; the app runs signed out (today's `App.tsx` behaviour). Board 01 becomes the in-app sign-in dialog skin; no full-screen wall.

### 9.3 Rebuild onboarding step 1 (projects folder) with stepper, errors and empty state
- **Type:** feature · **Board(s):** 02a, 02a+ · **Spec:** §5b · **Gaps:** F1-06, F1-07 · **Source:** `ui:screens/setup-screen.tsx:72`, `ui:screens/setup-screen.tsx:104`, `ui:screens/setup-screen.tsx:260`, `desk:app-machine.ts:326`, `desk:app-machine.ts:338`
- **Scope:**
  - Replace the "1 of 2" eyebrows with the 3-step `Stepper` (2.5): Projects folder, GitHub, Agent.
  - Repo list with checkboxes in machine context and an "Add N projects" event.
  - Error "Couldn't read ~/code — permission denied" + `Choose another folder`; empty "No git repositories in ~/code" + `Clone a repository` (reuses `add-project-dialog.tsx:297`).
- **Acceptance:**
  - [ ] A failed scan keeps the user on step 1 with the inline error.
  - [ ] Selecting two repos and continuing registers exactly those two.
- **Tests:** extend the `app-machine` tests; e2e new `apps/desktop/e2e/onboarding.spec.ts`, extend `projects-and-workspaces.spec.ts`.
- **Depends on:** 2.5, 2.6, 15.5

### 9.4 Rebuild onboarding step 2 (GitHub) with actionable errors
- **Type:** feature · **Board(s):** 02b, 02b+ · **Spec:** §5b · **Gaps:** F1-09 · **Source:** `ui:screens/setup-screen.tsx:143`, `ui:screens/setup-screen.tsx:172`, `desk:github-connection-machine.ts:183`, `contracts:1341`, `contracts:1353`
- **Scope:**
  - Connected state shows avatar, `@login`, installation count.
  - Error "GitHub didn't respond" + `Try again` + `Skip for now` replaces the action-less red Callout.
  - Skipping keeps onboarding completable.
- **Acceptance:**
  - [ ] Error offers both buttons and Skip proceeds to step 3.
- **Tests:** machine test for the skip path; e2e extend `github-onboarding.spec.ts`.
- **Depends on:** 9.3

### 9.5 Rebuild onboarding step 3 (agent) with HarnessCard and provider failure states
- **Type:** feature · **Board(s):** 02c, 02c+ · **Spec:** §5b, §6.5 · **Gaps:** F1-10 · **Source:** `ui:screens/setup/provider-setup-step.tsx:21`, `ui:components/provider-icon.tsx:62`, `desk:app-machine.ts:368`, `desk:app-machine.ts:398`, `desk:app-machine.ts:451`, `desk:app-machine.ts:500`, `desk:app-machine.ts:509`
- **Scope:**
  - `HarnessCard` with real logos and a status pill (Ready / Signing in… / Needs attention / Signed out), one line.
  - Card-level errors: "Couldn't load providers · Retry" (`loadFailed`) and "Couldn't save setup · Retry" (`completionFailed`).
  - CTA disabled with the reason text from the guard at `app-machine.ts:403`.
- **Acceptance:**
  - [ ] `loadFailed` and `completionFailed` each render and recover via Retry.
  - [ ] The disabled CTA states why.
- **Tests:** extend app-machine tests; e2e extend `provider-onboarding.spec.ts`.
- **Depends on:** 9.3, 10.4

### 9.6 Build the composer-first Home with Needs-you and import card
- **Type:** feature · **Board(s):** 03, 03+ · **Spec:** §5c · **Gaps:** F1-11, F4-05 · **Source:** `ui:screens/empty-conversation.tsx:11`, `ui:app/session-sidebar.tsx:1160`, `desk:mcp-import-prompt.tsx:20`, `core:domain.ts:261`, `desk:notifier.ts:72`
- **Scope:**
  - `NeedsYouCard` (question inline, Allow / Answer), `RunningRow`, dismissible `ImportCard`.
  - Import card states: detecting (skeleton), found (counts), failed ("Couldn't scan Claude Code · Retry"), dismissed (`Not now` persists; the card reappears as a row in Settings → MCP servers).
  - A question that is no longer pending turns neutral: "No longer waiting · Dismiss".
  - Replace the one-time `jingler:mcp-import-prompt:v1` flag with a persisted dismissal.
- **Acceptance:**
  - [ ] Needs-you cards derive from `needs-input` / `needs-approval` activities.
  - [ ] A stale question card shows the neutral state and dismisses.
- **Tests:** unit for the card derivation; e2e new `apps/desktop/e2e/home-needs-you.spec.ts`, extend `mcp-import-dialog.spec.ts`.
- **Depends on:** 1.2, 2.6, 10.8

### 9.7 Rebuild New workspace with chip row and "Start from" list
- **Type:** feature · **Board(s):** 08, 08+ · **Spec:** §5d · **Gaps:** F2-01, F2-02, F2-03, F7-09 · **Source:** `ui:composites/new-workspace-view.tsx:491`, `ui:composites/new-workspace-machine.ts:315`, `ui:composites/new-workspace-machine.ts:424`, `ui:composites/linked-issue-selector.tsx:37`, `ui:composites/issue-picker-list.tsx:15`, `ui:composites/repo-picker.tsx:21`, `ui:composites/environment-dialog.tsx:36`
- **Scope:**
  - One `ChipRow` (project · from · isolation · environment) and a `StartFromList`.
  - Issue provider missing: "Linear isn't connected" + `Connect` (jumps to Settings → Plugins).
  - List skeleton, "No assigned issues" + `Search all issues`, "Couldn't load issues" + `Retry`.
  - Issue already linked: "Already open in '…'" + `Open it` / `Create another` (lookup in 14.9).
  - `This Mac ▾` environment chip only when a device or managed environment exists.
- **Acceptance:**
  - [ ] Each list state renders; Connect jumps to Plugins settings.
  - [ ] Environment chip is hidden with no remote environments.
- **Tests:** extend `new-workspace-machine` tests; e2e extend `projects-and-workspaces.spec.ts`, `github-issues-inbox.spec.ts`.
- **Depends on:** 2.6, 14.9

### 9.8 Draw workspace provisioning progress and failure
- **Type:** feature · **Board(s):** 25b, 25b+ · **Spec:** §5d · **Gaps:** F1-12, F7-07 · **Source:** `ui:composites/new-workspace-view.tsx:84`, `ui:composites/new-workspace-view.tsx:165`, `ui:composites/new-workspace-machine.ts:73`, `ui:composites/new-workspace-machine.ts:560`, `desk:workspace-workflow-bar.tsx:16`, `contracts:608`, `contracts:614`, `core:domain.ts:49`
- **Scope:**
  - Replace the composer with a phase list (Creating worktree · Installing dependencies · Starting agent), spinner on the current row, `Cancel`.
  - Failure marks the failing row (red icon only) with `Retry` / `Edit`; setup failures use `WorkspaceWorkflow.retrySetup` / `skipSetup`.
  - Managed environments: header chip "Waking workspace…" with elapsed time or "Paused · Resume"; failed shows reason + `Retry`.
- **Acceptance:**
  - [ ] Failure keeps the form values and Retry re-runs the failed phase.
  - [ ] Cancel aborts provisioning and returns to the form.
- **Tests:** extend `new-workspace-machine` tests; e2e extend `managed-environments.spec.ts`, `workspace-workflow.spec.ts`.
- **Depends on:** 9.7, 2.5

---

## Epic 10 — Settings, provider auth and import

### 10.1 Build the full-page Settings shell
- **Type:** feature · **Board(s):** 09a, 09n · **Spec:** §5e · **Gaps:** — · **Source:** `ui:composites/settings-view.tsx:107`, `ui:composites/settings-view.tsx:263`, `ui:composites/settings-dialog.tsx:112`, `ui:composites/settings-view.tsx:693`
- **Scope:**
  - `SettingsNav` in four groups (Workspace, Agents, Integrations, Appearance) with search and `Soon` pills for Permissions and Keybindings.
  - Settings opens as a full page (⌘,); delete `settings-dialog.tsx`.
  - Lockup at the top of the nav.
- **Acceptance:**
  - [ ] ⌘, opens Settings as a page; search filters the nav.
  - [ ] No dialog variant remains.
- **Tests:** update settings tests; e2e extend `unified-project-settings.spec.ts`.
- **Depends on:** 2.7, 2.2

### 10.2 Restyle General settings and offload status
- **Type:** feature · **Board(s):** 09a, 09a+ · **Spec:** §5e · **Gaps:** F7-08 · **Source:** `ui:composites/settings-view.tsx:944`, `desk:offload-settings-machine.ts:27`, `contracts:1327`, `contracts:1429`, `contracts:1476`
- **Scope:**
  - General rows on `SettingsRow`.
  - Offload row: "Priming…" / "Ready" / "Failed · Retry".
- **Acceptance:**
  - [ ] A failed offload shows Retry that re-runs priming.
- **Tests:** extend `offload-settings-machine` tests; e2e extend `offload-compute.spec.ts`, `adhd-mode.spec.ts`.
- **Depends on:** 10.1

### 10.3 Restyle Providers and the accounts list
- **Type:** style · **Board(s):** 09b, 15d · **Spec:** §5i, §6.5 · **Gaps:** — · **Source:** `ui:composites/provider-connections-settings.tsx:222`, `desk:provider-recovery.ts:15`, `ui:composites/native-endpoint-login.tsx:10`
- **Scope:**
  - Account rows with real logos, default star, `Make default` / `Sign out`.
  - The line "Subscription connections never fall back to an API key" stays visible.
  - Open question: is a default account per runtime stored (today `Config.setDefaultProviderModel` is per model)?
- **Acceptance:**
  - [ ] Claude and Codex show real logos; sign-out removes the row.
- **Tests:** extend provider-connections tests; e2e extend `provider-onboarding.spec.ts`.
- **Depends on:** 10.1, 5.3

### 10.4 Build the Connect sheet (OAuth, device code, API key)
- **Type:** feature · **Board(s):** 15a, 15b, 15c · **Spec:** §5i · **Gaps:** — · **Source:** `ui:composites/provider-connections-settings-machine.ts:28`, `ui:composites/provider-auth-forms.tsx:9`, `ui:composites/provider-auth-forms.tsx:27`, `contracts:318`, `contracts:329`, `contracts:335`, `contracts:341`
- **Scope:**
  - 480px right sheet (`Drawer`, 2.8) with segmented Subscription / API key (2.3).
  - OAuth waiting with Cancel (`Provider.cancelLogin`); `DeviceCodeBlock` (20px mono code, copy, countdown, `Reopen browser`).
  - API key: saving → verified / invalid (keeps input) via `Provider.verifyModel`.
- **Acceptance:**
  - [ ] Cancel stops the login and closes the waiting state.
  - [ ] An invalid key keeps the typed value and shows the error.
- **Tests:** extend the provider-connections machine tests; e2e extend `provider-onboarding.spec.ts`.
- **Depends on:** 2.3, 2.8

### 10.5 Restyle GitHub settings
- **Type:** style · **Board(s):** 09c, 04m+, 09c+ · **Spec:** §3f · **Gaps:** F3-09 · **Source:** `ui:composites/settings-view.tsx:1238`, `core:domain.ts:349`
- **Scope:**
  - `closeOnMerge` label becomes "Close workspace when the whole stack is merged".
  - Rows on `SettingsRow`; disconnect keeps its confirm.
- **Acceptance:**
  - [ ] The label matches the new copy; behaviour change is in 14.3.
- **Tests:** e2e extend `github-onboarding.spec.ts`.
- **Depends on:** 10.1

### 10.6 Restyle MCP servers with neutral health rows and sign-in
- **Type:** style · **Board(s):** 09d · **Spec:** §5j, §6.3, §6.6 · **Gaps:** — · **Source:** `ui:composites/mcp-settings.tsx:31`, `ui:composites/mcp-settings.tsx:132`, `core:mcp.ts:39`, `contracts:1219`, `contracts:1257`
- **Scope:**
  - Health row = neutral icon + "12 tools"; OAuth servers show `Needs sign-in · Connect`.
  - No green or yellow fills.
- **Acceptance:**
  - [ ] `Connect` runs `Mcp.startAuthorization` and the row updates to signed in.
- **Tests:** e2e extend `mcp-recovery.spec.ts`.
- **Depends on:** 10.1, 2.5

### 10.7 Build the MCP server detail dialog
- **Type:** feature · **Board(s):** 16d · **Spec:** §6.6 · **Gaps:** — · **Source:** `ui:composites/mcp-settings.tsx:284`, `cli:mcp-probe.ts`, `contracts:1219`
- **Scope:**
  - `ToolList` with toggles, `LogTail`, OAuth row "OAuth · Signed in as … · Sign out".
  - Log tail needs a new read RPC (14.10).
- **Acceptance:**
  - [ ] Tool toggles persist; log tail refreshes on open.
- **Tests:** e2e extend `mcp-recovery.spec.ts`.
- **Depends on:** 10.6, 14.10

### 10.8 Build the import flow (sources and review)
- **Type:** feature · **Board(s):** 16a, 16b, 03+ · **Spec:** §5j, §6.6 · **Gaps:** F1-11 · **Source:** `ui:screens/setup/resource-setup-step.tsx:10`, `desk:mcp-import-prompt.tsx:39`, `desk:app-machine.ts:512`, `desk:app-machine.ts:534`, `desk:app-machine.ts:566`, `contracts:377`, `contracts:383`, `contracts:1264`, `contracts:1275`
- **Scope:**
  - One flow replaces the onboarding `resources` step and the one-time dialog; remove `resources` from `app-machine` once the Home card exists.
  - Review rows: `ConflictBadge` (Keep mine / Replace / Keep both), `NeedsSecretsRow`, `NeedsSignInRow` (OAuth host, `Sign in after import`).
  - `detectFailed` and `importFailed` states with Retry.
- **Acceptance:**
  - [ ] Onboarding completes with no resources step.
  - [ ] Import of an OAuth server marks it `Needs sign-in` in the result.
- **Tests:** extend app-machine tests; e2e extend `mcp-import-dialog.spec.ts`, `agent-imports.spec.ts`.
- **Depends on:** 2.5, 10.6

### 10.9 Draw the import result step
- **Type:** feature · **Board(s):** 16c · **Spec:** §6.3, §6.6 · **Gaps:** — · **Source:** `contracts:1257`, `contracts:1275`
- **Scope:**
  - Neutral result rows; red icon only on `Failed to start · View log`.
  - `Connect` runs `Mcp.startAuthorization` for OAuth servers.
- **Acceptance:**
  - [ ] No traffic-light fills; failures show View log.
- **Tests:** e2e extend `mcp-import-dialog.spec.ts`.
- **Depends on:** 10.8

### 10.10 Restyle Theme settings
- **Type:** style · **Board(s):** 09e · **Spec:** §2 · **Gaps:** — · **Source:** `ui:composites/themes-settings.tsx:86`, `ui:composites/themes-settings.tsx:102`, `contracts:2417`
- **Scope:**
  - Theme cards on Graphite; the Graphite entry follows D2.
  - Import and active-theme flows unchanged.
- **Acceptance:**
  - [ ] Active theme switches live; imported theme still works.
- **Tests:** e2e extend `branding.spec.ts`.
- **Depends on:** 1.1
- **Decided:** D2 — Graphite replaces the default theme; the old default theme is removed.

### 10.11 Build Notifications settings with a blocked-by-OS warning
- **Type:** feature · **Board(s):** 09f, 09f+ · **Spec:** §5e · **Gaps:** F4-06 · **Source:** `ui:composites/settings-view.tsx:1188`, `desk:notifier.ts:41`, `contracts:1422`, `contracts:1540`
- **Scope:**
  - Own settings board using the existing notifications block.
  - Warning row "Notifications are blocked by macOS" + `Open System Settings`, driven by 14.6.
- **Acceptance:**
  - [ ] Blocked permission shows the row and the button opens system settings.
- **Tests:** e2e new `apps/desktop/e2e/notifications-settings.spec.ts`.
- **Depends on:** 10.1, 14.6

### 10.12 Restyle Projects and Routines settings
- **Type:** style · **Board(s):** 09g, 24a+ · **Spec:** §5e · **Gaps:** F1-13 · **Source:** `ui:composites/project-workflow-settings.tsx:18`, `ui:composites/project-workflow-machine.ts:74`, `ui:composites/routines-settings-view.tsx:39`, `desk:routines-machine.ts:40`, `ui:composites/routine-form-machine.ts:72`, `contracts:574`, `contracts:260`
- **Scope:**
  - Per-project workflow and Routines list on `SettingsRow`.
  - Missing-folder row with `Locate…` / `Remove` (shares 3.8).
- **Acceptance:**
  - [ ] Routine create, run now and delete still work.
- **Tests:** e2e extend `workspace-routines.spec.ts`, `unified-project-settings.spec.ts`, `workspace-workflow.spec.ts`.
- **Depends on:** 10.1, 3.8

### 10.13 Restyle Devices with full status set and revoke confirm
- **Type:** feature · **Board(s):** 09h, 24b, 09h+, 24b+ · **Spec:** §6.3 · **Gaps:** F7-02, F7-03, F7-04 · **Source:** `ui:composites/settings-view.tsx:484`, `ui:composites/settings-view.tsx:566`, `core:domain.ts:36`, `desk:environment-machine.ts:81`, `contracts:461`, `contracts:467`, `apps/device-agent/src/control-connection.ts:236`
- **Scope:**
  - One-line neutral status text: Online · Offline · Reconnecting… · Incompatible (red icon) · Revoked.
  - Incompatible remedy: "Device agent v0.8 is older than this app needs" + `How to update` (command from `apps/device-agent/README.md`).
  - Revoke confirm: "Revoke Studio-Mac? 2 workspaces run on it and will stop." with a solid red final button.
- **Acceptance:**
  - [ ] All five statuses render with no green or yellow fill.
  - [ ] Revoke lists running workspaces before confirming.
- **Tests:** extend environment-machine tests; e2e extend `remote-environments.spec.ts`, `managed-environments.spec.ts`.
- **Depends on:** 1.4, 2.10

### 10.14 Build the device pairing wizard
- **Type:** feature · **Board(s):** 25b, 25b+ · **Spec:** §5e · **Gaps:** F7-01 · **Source:** `ui:composites/settings-view.tsx:560`, `desk:environment-machine.ts:81`, `contracts:451`, `contracts:455`
- **Scope:**
  - 480px sheet: host with suggestions → "Installing device agent…" steps → "Paired ✓" or the failing step with log tail + `Retry`.
  - Empty list: "No owned machines yet" + `Pair a machine`.
- **Acceptance:**
  - [ ] A failing bootstrap step shows the log tail and Retry resumes.
- **Tests:** extend environment-machine tests; e2e extend `remote-environments.spec.ts`.
- **Depends on:** 10.13, 2.8

### 10.15 Build searchable Agents & skills
- **Type:** feature · **Board(s):** 09i · **Spec:** §6.7 · **Gaps:** — · **Source:** `ui:composites/agents-settings.tsx:82`, `desk:agents-settings-machine.ts:57`, `contracts:372`, `contracts:1196`
- **Scope:**
  - Search + kind filter (`All · Agents · Skills`) + source filter, counts, `VirtualList` (2.12).
  - Enable toggle and remove per row.
- **Acceptance:**
  - [ ] 500 entries stay responsive; filters combine.
- **Tests:** extend agents-settings-machine tests; e2e extend `agent-imports.spec.ts`.
- **Depends on:** 2.12, 2.2

### 10.16 Restyle Context & plan settings
- **Type:** style · **Board(s):** 09j · **Spec:** §5e · **Gaps:** — · **Source:** `ui:composites/settings-view.tsx:718`, `ui:composites/context-meter.tsx:68`, `contracts:1302`
- **Scope:**
  - Context thresholds, plan auto-run and plan template on `SettingsRow`.
- **Acceptance:**
  - [ ] Changes persist via the existing `Config.set*` RPCs.
- **Tests:** e2e extend `context-compaction.spec.ts`, `plan-mode.spec.ts`.
- **Depends on:** 10.1

### 10.17 Restyle the Runtime inspector settings
- **Type:** style · **Board(s):** 09k · **Spec:** §5e · **Gaps:** — · **Source:** `ui:composites/runtime-inspector.tsx:12`, `desk:runtime-inspector-machine.ts:25`, `contracts:266`, `contracts:275`
- **Scope:**
  - Diagnostics list and `Export diagnostics` on Graphite; reachable from the recovery card `Inspect` action.
- **Acceptance:**
  - [ ] Export produces the same bundle as today.
- **Tests:** e2e extend `runtime-settings.spec.ts`.
- **Depends on:** 10.1

### 10.18 Restyle Plugins settings without a Plannotator key
- **Type:** style · **Board(s):** 09l · **Spec:** §6.8 · **Gaps:** — · **Source:** `ui:composites/plugins-settings.tsx:480`, `ui:composites/plugin-secret-setting-machine.ts:20`, `contracts:2484`, `contracts:2676`
- **Scope:**
  - Plannotator shows only its real settings, no API key or secret field.
  - Other plugins keep secret fields.
- **Acceptance:**
  - [ ] No key input renders for Plannotator.
- **Tests:** e2e extend `plugins.spec.ts`.
- **Depends on:** 10.1

### 10.19 Restyle Web search and add the header views picker
- **Type:** feature · **Board(s):** 09m · **Spec:** §3c · **Gaps:** — · **Source:** `ui:composites/web-search-settings.tsx:26`, `contracts:1508`
- **Scope:**
  - Web search credential and skip rows.
  - Header views picker: max 5 pinned, drag to reorder, stored through 14.5.
- **Acceptance:**
  - [ ] Reordering changes the header order live.
- **Tests:** e2e extend `web-search.spec.ts`, `view-launcher.spec.ts`.
- **Depends on:** 10.1, 14.5

### 10.20 Draw the Coming-soon settings stubs
- **Type:** style · **Board(s):** 09n · **Spec:** §5e · **Gaps:** — · **Source:** `ui:composites/settings-view.tsx:693`
- **Scope:**
  - Permissions and Keybindings show a `Soon` pill and a one-line placeholder.
- **Acceptance:**
  - [ ] Stub pages render and are keyboard reachable.
- **Tests:** covered in `unified-project-settings.spec.ts`.
- **Depends on:** 10.1

---

## Epic 11 — Usage & analytics

### 11.1 Build the limits-only usage popover
- **Type:** feature · **Board(s):** 18a, 23+ · **Spec:** §5l · **Gaps:** F5-02, F7-06 · **Source:** `ui:composites/usage-modal.tsx:121`, `ui:composites/user-menu.tsx:88`, `contracts:1288`, `core:remote.ts:137`
- **Scope:**
  - Popover from the avatar showing limit rows with reset time ("Limited until 16:40") and relay quota status.
  - Neutral rows; link to Settings → Usage. Numbers are labelled placeholders.
- **Acceptance:**
  - [ ] A limited provider shows its reset time; no traffic-light fills.
- **Tests:** e2e new `apps/desktop/e2e/usage.spec.ts`.
- **Depends on:** 2.5, 2.9

### 11.2 Build Settings · Usage analytics
- **Type:** feature · **Board(s):** 18b · **Spec:** §5l, §6.4 · **Gaps:** — · **Source:** `core:runtime/usage-facts.ts:69`, `ui:composites/usage-modal.tsx:101`, `contracts:1293`
- **Scope:**
  - Filters (range, runtime, project), four `KpiTile`s with cost marked partial, sortable `ModelPerformanceTable`, inline-SVG charts.
  - `Subscription` / `API key` / runtime badges one line.
  - Filters run client-side or through 14.8.
- **Acceptance:**
  - [ ] Sorting and filtering update table and KPIs.
  - [ ] Badges stay on one line at 1100px.
- **Tests:** unit for aggregation; e2e extend `usage.spec.ts`.
- **Depends on:** 2.14, 2.7, 14.8

### 11.3 Build the model detail drawer
- **Type:** feature · **Board(s):** 18c · **Spec:** §5l · **Gaps:** — · **Source:** `ui:components/dialog.tsx`, `core:runtime/usage-facts.ts:69`
- **Scope:**
  - 480px `Drawer` with per-model stats, sparklines and a slowest-runs list linking to turns.
  - Run → turn id mapping from 14.8.
- **Acceptance:**
  - [ ] Clicking a table row opens the drawer; Esc closes it.
- **Tests:** e2e extend `usage.spec.ts`.
- **Depends on:** 2.8, 11.2

---

## Epic 12 — Notifications & needs-you

### 12.1 Show an amber needs-you count on rail tiles
- **Type:** feature · **Board(s):** 00, 04b, 24a, 04b+ · **Spec:** §3 · **Gaps:** F4-01 · **Source:** `ui:app/project-sidebar.tsx:16`, `ui:app/project-sidebar.tsx:17`, `core:domain.ts:261`
- **Scope:**
  - `ProjectAvatar` gains `needsYouCount`, derived from sessions whose `SessionActivity` is `needs-input` or `needs-approval`.
  - Amber badge top-right of the tile, one line (`nowrap`); counts subagent questions too (12.5).
  - Count clears when the question is answered or the run stops.
- **Acceptance:**
  - [ ] A blocked session in another project shows the badge on that project's tile.
  - [ ] Badge disappears after the answer without a reload.
- **Tests:** extend `ui:app/project-sidebar.test.tsx`; e2e extend `project-sidebar-activity.spec.ts`.
- **Depends on:** 3.7, 1.3

### 12.2 Land notification clicks on the waiting question
- **Type:** feature · **Board(s):** 04b, 17d, 04b+, 17d+ · **Spec:** §3e2 · **Gaps:** F4-02 · **Source:** `desk:main/notifications.ts:111`, `apps/desktop/src/preload/index.ts:111`, `desk:App.tsx:289`, `ui:app/conversation-view.tsx:123`
- **Scope:**
  - Payload becomes `{ sessionId, kind, turnId }` across main, preload and renderer.
  - Click switches project, selects the workspace, scrolls to the blocked card and focuses option 1.
  - The timeline gets an amber tick for the same turn (4.10).
- **Acceptance:**
  - [ ] Clicking the OS notification for a session in another project opens that project, session and question.
  - [ ] A notification for an already-answered question just selects the session.
- **Tests:** unit for the payload mapper; e2e new `apps/desktop/e2e/needs-you.spec.ts` (shared with 7.8).
- **Depends on:** 7.8, 4.10

### 12.3 Add a "Needs you" section and action to the command palette
- **Type:** feature · **Board(s):** 10, 10+ · **Spec:** §5f · **Gaps:** F4-04 · **Source:** `ui:app/command-palette-model.ts:31`, `ui:app/command-palette.tsx:50`
- **Scope:**
  - Pinned first section "Needs you (3)" listing blocked workspaces.
  - Action "Go to next workspace that needs you" with a shortcut. **Shortcut:** ⌘J (decided: ⌘J, #507).
- **Acceptance:**
  - [ ] The action cycles blocked workspaces in order and opens each question.
- **Tests:** extend `ui:app/command-palette-model.test.ts`; e2e extend `command-palette.spec.ts`.
- **Depends on:** 3.10, 12.1

### 12.4 Fire "Needs you · Jump" toasts
- **Type:** feature · **Board(s):** 24b, 24b+ · **Spec:** §5g · **Gaps:** F4-07 · **Source:** `desk:auto-route.ts:83`, `desk:active-session.ts:15`, `desk:notifier.ts:41`
- **Scope:**
  - When a run enters a blocked state and the app is focused on another session, show a toast with `Jump` (12.2 landing).
  - Suppress for the session being viewed.
- **Acceptance:**
  - [ ] Toast appears for a blocked background session and not for the active one.
  - [ ] `Jump` lands on the question.
- **Tests:** unit for the suppression rule; e2e extend `toasts.spec.ts`.
- **Depends on:** 2.4, 12.2

### 12.5 Surface subagent questions in the timeline and Needs-you
- **Type:** feature · **Board(s):** 20, 17d, 17d+ · **Spec:** §6.16 · **Gaps:** F6-06 · **Source:** `core:runtime/subagent-fleet.ts:153`, `ui:composites/question-card.tsx:19`, `ui:app/subagent-view.tsx:110`
- **Scope:**
  - A child's question adds a needs tick to the parent timeline and counts in 12.1.
  - The subagent view shows the `QuestionCard`; answering routes to the child.
- **Acceptance:**
  - [ ] A child asking a question increments the rail count and shows an amber tick.
- **Tests:** unit for the count derivation; e2e extend `subagents-outlive-turn.spec.ts`.
- **Depends on:** 12.1, 8.2

---

## Epic 13 — System states & recovery

### 13.1 Replace the raw boot failure with a Retry card
- **Type:** feature · **Board(s):** 25c, 12, 25c+ · **Spec:** §5h · **Gaps:** F1-08 · **Source:** `desk:App.tsx:2168`, `desk:app-machine.ts:233` (`RETRY_*` events), `contracts:275` (`RuntimeDiagnostics.export`)
- **Scope:**
  - Centred card "Jingler couldn't start", short cause, details disclosure.
  - `Retry` (primary) sends the machine's retry event; `Copy diagnostics` uses `RuntimeDiagnostics.export`.
  - Remove the red mono text.
- **Acceptance:**
  - [ ] A forced boot failure shows the card and Retry recovers.
- **Tests:** extend app-machine tests; e2e extend `boot.spec.ts`.
- **Depends on:** 1.2, 2.6, 15.6

### 13.2 Redesign the crash screen
- **Type:** feature · **Board(s):** 25c, 25c+ · **Spec:** §5g · **Gaps:** F8-04 · **Source:** `desk:root-error-boundary.tsx:22`, `desk:root-error-boundary.tsx:52`, `desk:root-error-boundary.tsx:82`
- **Scope:**
  - Card "Jingler hit an error", "Agents keep running in the background", `Reload window` (primary), `Copy error details`, `Open logs`.
- **Acceptance:**
  - [ ] A thrown render error shows all three actions and Reload recovers.
- **Tests:** unit for the boundary; e2e extend `boot.spec.ts`.
- **Depends on:** 1.2

### 13.3 Add archive confirm, failure and the Archived list
- **Type:** feature · **Board(s):** 25a, 25c, 24b, 25c+, 24b+, 25a+ · **Spec:** §5g · **Gaps:** F2-14, F8-08 · **Source:** `desk:session-archive-machine.ts:33`, `desk:session-archive-machine.ts:41`, `core:domain.ts:567`, `ui:app/session-sidebar.tsx:646`, `contracts:800`, `contracts:895`
- **Scope:**
  - ConfirmDialog "Archive this workspace? Terminal history is saved" (final button follows 2.10); failure keeps the dialog open with the error and Retry.
  - "Archived (14)" opens a searchable list with `Restore` and `Delete` (destructive, confirm).
- **Acceptance:**
  - [ ] Archive failure shows the error and Retry in the dialog.
  - [ ] Restore moves a workspace back; Delete asks first.
- **Tests:** extend archive-machine tests; e2e new `apps/desktop/e2e/archived-list.spec.ts`.
- **Depends on:** 2.10, 2.2

### 13.4 Add the "Revert to here" confirm dialog
- **Type:** feature · **Board(s):** 25c · **Spec:** §3e2, §6.1 · **Gaps:** — · **Source:** `desk:workspace-checkpoints-machine.ts:32`, `desk:workspace-checkpoints-view.tsx:13`, `contracts:599`, `contracts:603`
- **Scope:**
  - ConfirmDialog "Revert to turn 3?" listing the files affected from `WorkspaceCheckpoints.preview`.
  - Final button runs `WorkspaceCheckpoints.restore`; failure shows an error and Retry.
- **Acceptance:**
  - [ ] The preview file list matches what is restored; Cancel changes nothing.
- **Tests:** extend checkpoint-machine tests; e2e extend `workspace-checkpoints.spec.ts`.
- **Depends on:** 2.10

### 13.5 Draw the five auto-update states with a running-agents confirm
- **Type:** feature · **Board(s):** 24b, 24b+ · **Spec:** §5g · **Gaps:** F8-01, F8-02 · **Source:** `ui:app/session-sidebar.tsx:53`, `ui:app/session-sidebar.tsx:141`, `desk:use-auto-update.ts:5`, `desk:use-auto-update.ts:15`, `desk:use-auto-update.ts:40`
- **Scope:**
  - Account-menu row states: "v1.9.0 available · Download" → "Downloading 42%" → "Restart to update" → "Update failed · Retry" → manual "Open installer"; dismiss collapses to a compact button.
  - ConfirmDialog "3 agents are running. Restarting stops them." with `Restart anyway` / `Wait`. Open question: do runs resume after relaunch?
- **Acceptance:**
  - [ ] Each updater state renders in a story and from the hook.
  - [ ] Restart with running agents shows the confirm.
- **Tests:** unit for the state mapper; e2e extend `release-notes.spec.ts`.
- **Depends on:** 2.10

### 13.6 Add a reopenable "What's new" dialog
- **Type:** feature · **Board(s):** 24b, 24b+ · **Spec:** §5g · **Gaps:** F8-03 · **Source:** `ui:app/session-sidebar.tsx:66`, `desk:use-release-notes.ts:7`, `desk:use-release-notes.ts:32`
- **Scope:**
  - Account menu `What's new (v1.9.0)` opens a dialog listing every version since the last run, with `jingler-icon-color.png`.
- **Acceptance:**
  - [ ] Notes can be reopened after dismissal and show all skipped versions.
- **Tests:** extend release-notes tests; e2e extend `release-notes.spec.ts`.
- **Depends on:** 2.8

### 13.7 Restyle the in-app sign-in dialog
- **Type:** style · **Board(s):** 25c, 01, 01+, 25c+ · **Spec:** §5a · **Gaps:** F1-15 · **Source:** `ui:composites/sign-in-dialog.tsx:14`, `desk:App.tsx:2137`
- **Scope:**
  - Dialog skin of Login with the same waiting / error / sent states (9.1).
  - Used from the sidebar footer when signed out.
- **Acceptance:**
  - [ ] Dialog shows every `LoginState` and closes on success.
- **Tests:** story; e2e extend `auth.spec.ts`.
- **Depends on:** 9.1, 2.8
- **Decided:** D1 — sign-in is optional; the app runs signed out (today's `App.tsx` behaviour). Board 01 becomes the in-app sign-in dialog skin; no full-screen wall.

### 13.8 Restyle the session hover card with a PR stack list
- **Type:** feature · **Board(s):** 25a, 25a+ · **Spec:** §3f · **Gaps:** F3-05 · **Source:** `ui:composites/session-hover-card.tsx:25`, `ui:components/hover-card.tsx:26`
- **Scope:**
  - Hover card with branch, status, diff stat and, for stacked sessions, a stack list (number, title, state word, checks icon).
- **Acceptance:**
  - [ ] A session with three PRs lists all three in order.
- **Tests:** component test; e2e extend `sidebar-identity.spec.ts`.
- **Depends on:** 2.9, 14.1

### 13.9 Draw file viewer loading, too-large, unsupported and error states
- **Type:** feature · **Board(s):** 25d · **Spec:** §5h · **Gaps:** — · **Source:** `ui:asset/asset-view.tsx:30`, `desk:file-browser-view.tsx:154`, `contracts:2289` (`Asset.read`)
- **Scope:**
  - States: loading, too large (open externally), unsupported/binary, error + Retry; image and CSV tiles.
  - One pattern shared with `InlineError` (2.6).
- **Acceptance:**
  - [ ] Each state renders from a story and a failing `Asset.read` shows Retry.
- **Tests:** e2e extend `asset-browser.spec.ts`, `file-browser-ide.spec.ts`.
- **Depends on:** 2.6

### 13.10 Add the Interrupted workspace state
- **Type:** feature · **Board(s):** 04b, 04b+ · **Spec:** §5h · **Gaps:** F8-07 · **Source:** `core:domain.ts:261`, `apps/desktop/e2e/pi-recovery.spec.ts`
- **Scope:**
  - After a crash or relaunch, mid-run workspaces show "Interrupted" in the sidebar and a transcript card with `Resume`.
  - Open question: which activity value marks interruption today; confirm before building.
- **Acceptance:**
  - [ ] Killing the app mid-run then relaunching shows the card and Resume continues.
- **Tests:** extend `pi-recovery.spec.ts`.
- **Depends on:** 2.11

### 13.11 Draw the Plugin pane host states
- **Type:** feature · **Board(s):** 12, 14 · **Spec:** §5h · **Gaps:** — · **Source:** `desk:plugin-pane-host.tsx`
- **Scope:**
  - Loading, empty and plugin-crashed states for plugin panes using the shared patterns.
- **Acceptance:**
  - [ ] A crashing plugin pane shows the error state with Retry.
- **Tests:** e2e extend `plugins.spec.ts`.
- **Depends on:** 2.6

---

## Epic 14 — Data model & RPC changes

### 14.1 Replace `Session.prNumber` with an ordered `prs[]`
- **Type:** data-model · **Board(s):** 04m, 04m+ · **Spec:** §3f · **Gaps:** F3-01 · **Source:** `core:domain.ts:553`, `core:domain.ts:622`, `contracts:1839`, `contracts:1850`, `ui:composites/pr-glyph.tsx:52`
- **Scope:**
  - `prs: [{ number, branch, base, state, checks }]` ordered base-up; keep `prNumber` as derived top-of-stack for one release.
  - Migrate persisted sessions; update `Github.createPr` to accept a `base` and append to `prs`.
  - Sidebar glyph uses the worst state across the stack.
- **Acceptance:**
  - [ ] Existing sessions load with a one-element `prs`.
  - [ ] Creating a second PR on a session appends rather than replaces.
- **Tests:** unit for the migration and ordering; e2e extend `github-publish.spec.ts`.
- **Depends on:** —
- **Decided:** D4 — Jingler creates and restacks stacked-PR layer branches (`Create PR → Stack on #481`), via a new `Github.restack` RPC. Option B (agent-driven) is dropped.

### 14.2 Add `Github.restack`
- **Type:** data-model · **Board(s):** 04m, 04m+ · **Spec:** §3f · **Gaps:** F3-03 · **Source:** `contracts:1982` (`Github.updateBranch`), `desk:use-pull-request.ts:45`
- **Scope:**
  - New RPC to retarget upper layers to the new base and rebase them; open question: `gh` CLI or local `git rebase` in the worktree, and how conflicts are reported.
  - Returns per-layer result for the rail.
- **Acceptance:**
  - [ ] Restack of two upper layers returns two results; a conflict is reported, not thrown.
- **Tests:** unit with a fake git; e2e extend `pr-stack.spec.ts`.
- **Depends on:** 14.1
- **Decided:** D4 — Jingler creates and restacks stacked-PR layer branches (`Create PR → Stack on #481`), via a new `Github.restack` RPC. Option B (agent-driven) is dropped.

### 14.3 Make the PR sweep stack-aware
- **Type:** data-model · **Board(s):** 04m, 09c, 24b+, 04m+, 09c+ · **Spec:** §3f · **Gaps:** F3-07, F3-09 · **Source:** `desk:pr-sweep.ts:33`, `desk:pr-sweep.ts:49`, `desk:notifier.ts:76`, `core:domain.ts:349`
- **Scope:**
  - Key `alreadyNotified` on (session, PR number); one notification per PR ("#480 merged (stacked under #481)").
  - `closeOnMerge` archives only when every PR in `prs[]` is merged or closed.
- **Acceptance:**
  - [ ] A 3-PR stack produces 3 notifications and one archive after the last merge.
- **Tests:** unit for the sweep; e2e extend `github-publish.spec.ts`.
- **Depends on:** 14.1

### 14.4 Per-layer PR diff and commit ranges
- **Type:** data-model · **Board(s):** 05, 05+ · **Spec:** §3f · **Gaps:** F3-06 · **Source:** `contracts:1822`, `contracts:1829`
- **Scope:**
  - PR diff RPCs accept a PR number or commit range instead of one per session.
  - Returns an empty result with "No commits in this layer".
- **Acceptance:**
  - [ ] Diffs for layers 1 and 2 of a stack differ and sum to the full diff.
- **Tests:** unit for range computation; e2e extend `pr-stack.spec.ts`.
- **Depends on:** 14.1

### 14.5 Persist pinned header views
- **Type:** data-model · **Board(s):** 04g, 09m · **Spec:** §3c · **Gaps:** — · **Source:** `contracts:1558` (pattern: `Config.setStarredRepos`)
- **Scope:**
  - `Config.setHeaderViews` storing up to 5 view ids in order; open question: per-user config vs local storage, follow the starred-repos pattern unless review says otherwise.
- **Acceptance:**
  - [ ] Pinned views and order survive a restart; a sixth is rejected.
- **Tests:** unit for validation; e2e covered by `view-launcher.spec.ts`.
- **Depends on:** —

### 14.6 Add a notification permission probe
- **Type:** data-model · **Board(s):** 09f, 09f+ · **Spec:** §5e · **Gaps:** F4-06 · **Source:** `desk:main/notifications.ts:11`, `contracts:1540` (`Notify.show`)
- **Scope:**
  - `Notify.permission` returning granted / denied / unsupported from the main process.
  - Renderer shows the warning row when not granted (10.11).
- **Acceptance:**
  - [ ] A denied permission is reported as denied.
- **Tests:** unit with a mocked `Notification`; e2e in `notifications-settings.spec.ts`.
- **Depends on:** —

### 14.7 Persist review finding dismissals
- **Type:** data-model · **Board(s):** 05, 05+ · **Spec:** §6.2 · **Gaps:** F2-07 · **Source:** `desk:review-store.ts:14`, `contracts:1611`, `contracts:1660`
- **Scope:**
  - Store dismissed finding ids per session in the review store first.
  - Add `Review.dismiss` only if dismissals must sync across devices.
- **Acceptance:**
  - [ ] Dismissed ids survive a restart and are keyed per session.
- **Tests:** unit for the store.
- **Depends on:** —

### 14.8 Usage filters and run-to-turn mapping
- **Type:** data-model · **Board(s):** 18b, 18c · **Spec:** §5l · **Gaps:** — · **Source:** `contracts:1293` (`Usage.report`), `core:runtime/usage-facts.ts:69`
- **Scope:**
  - Decide whether range/runtime/project filtering stays client-side or moves into a payload; open question from 07-dev-notes.
  - Add a run → turn id mapping for the slowest-runs list if `UsageReportGroup` lacks it.
- **Acceptance:**
  - [ ] Filters return consistent totals; slowest runs link to a turn.
- **Tests:** unit on `usage-facts`.
- **Depends on:** —

### 14.9 Look up the workspace already linked to an issue
- **Type:** data-model · **Board(s):** 08, 08+ · **Spec:** §5d · **Gaps:** F2-03 · **Source:** `contracts:739` (`Sessions.linkIssue`), `contracts:731`
- **Scope:**
  - Query over sessions' linked issues returning the workspace name and id.
- **Acceptance:**
  - [ ] An issue linked to one workspace returns it; an unlinked one returns none.
- **Tests:** unit for the lookup.
- **Depends on:** —

### 14.10 Expose an MCP log tail
- **Type:** data-model · **Board(s):** 16d · **Spec:** §6.6 · **Gaps:** — · **Source:** `cli:mcp-probe.ts`, `contracts:1219` (`Mcp.status`)
- **Scope:**
  - Read RPC returning the last N lines of a server's log; open question: where MCP logs live today.
- **Acceptance:**
  - [ ] Failing server returns its recent log lines.
- **Tests:** unit with a fake log.
- **Depends on:** —

### 14.11 Decide on `IssueDetail.linkedPrs`
- **Type:** data-model · **Board(s):** 26d · **Spec:** §6.18 · **Gaps:** — · **Source:** `core:domain.ts:1805` (`IssueDetail`), `contracts:1804` (`Github.issue`), `contracts:1742` (`Github.issueBySlug`)
- **Scope:**
  - Open question: add optional `linkedPrs: [{ number, state, url }]` to `IssueDetail` (GitHub timeline cross-references; Linear attachments) so the issue rail can list PRs.
  - Without it the rail shows the linked workspace only. `IssueDetail` has no milestone or reactions either; not proposed.
- **Acceptance:**
  - [ ] Decision recorded; if accepted, both providers fill the field and 6.25 renders it.
- **Tests:** unit for the schema and each provider mapper.
- **Depends on:** —

---

### 14.12 Record each subagent's worktree, branch and PR on `SubagentFleetNode`
- **Type:** data-model · **Board(s):** 20c, 20d · **Spec:** §6.19 · **Gaps:** — · **Source:** `core:runtime/subagent-fleet.ts:81`, `cli:runtime/subagents/pi-child-launcher.ts`, `cli:runtime/subagents/subagent-supervision-service.ts`
- **Scope:**
  - Add `workspace: { path, branch, baseRef } | null` (null = shares parent checkout) and `prNumber: number | null` to `SubagentFleetNode`; old snapshots decode with both null.
  - The runtime fills `workspace` when it creates or detects a child worktree, and `prNumber` when the child opens or links a PR.
  - Open question: where the pi runtime exposes a child's cwd today; nothing in `pi-child-launcher.ts` records it.
- **Acceptance:**
  - [ ] A child launched with worktree isolation reports its path and branch in the fleet snapshot.
  - [ ] Old persisted fleet events still decode.
- **Tests:** schema decode tests; supervision-service test for a worktree child.
- **Depends on:** —

## Epic 15 — Bug fixes

### 15.1 Stop session-row status, separator and diff stat wrapping
- **Type:** bug · **Board(s):** 24a, 00 · **Spec:** §3 · **Gaps:** — · **Source:** `ui:composites/session-row.tsx:129`
- **Scope:**
  - Status word, separator and diff stat get `whitespace-nowrap shrink-0`; only the branch name truncates.
- **Acceptance:**
  - [ ] At 248px sidebar width every row stays on one line.
- **Tests:** extend `session-row.test.tsx`; e2e extend `sidebar-attention-layout.spec.ts`.
- **Depends on:** —

### 15.2 Fix sign-in dead ends in the auth machine
- **Type:** bug · **Board(s):** 01, 01+ · **Spec:** §5a · **Gaps:** F1-01, F1-02, F1-03 · **Source:** `desk:auth-machine.ts:130`, `desk:auth-machine.ts:145`, `desk:auth-machine.ts:122`, `desk:auth-machine.ts:117`
- **Scope:**
  - `CANCEL` from `oauthPending` to `idle`; `RETRY` from `error` re-running the last attempt (`lastAttempt` in context).
  - `RESEND` with a 30 s cooldown from `magicLinkSent`; error copy carries the real cause.
- **Acceptance:**
  - [ ] No signed-out state is reachable without an exit other than RESET.
- **Tests:** extend `auth-machine.test.ts`; e2e extend `auth.spec.ts`.
- **Depends on:** —

### 15.3 Handle a denied OAuth deep link
- **Type:** bug · **Board(s):** 01, 01+ · **Spec:** §5a · **Gaps:** F1-04 · **Source:** `apps/desktop/src/main/deep-link.ts:45`, `desk:App.tsx:2073`
- **Scope:**
  - Renderer reacts to `payload.ok === false`: return to idle with "GitHub sign-in was cancelled" and Retry.
- **Acceptance:**
  - [ ] A callback with `?error=` shows the message instead of nothing.
- **Tests:** unit for the handler; e2e extend `auth.spec.ts`.
- **Depends on:** 15.2

### 15.4 Tell an unreachable server apart from a signed-out user
- **Type:** bug · **Board(s):** 12, 23, 12+, 23+ · **Spec:** §5h · **Gaps:** F1-05 · **Source:** `desk:auth-machine.ts:85`, `desk:auth-machine.ts:74`
- **Scope:**
  - `checking` onError no longer becomes `signedOut` silently; it reaches an `unreachable` state.
  - Top hairline banner "Can't reach Jingler — you can keep working locally" + `Retry`; the app shows, not the wall.
- **Acceptance:**
  - [ ] An offline boot shows the app with the banner, not the sign-in wall.
- **Tests:** extend `auth-machine.test.ts`; e2e extend `boot.spec.ts`.
- **Depends on:** 15.2, 2.11
- **Decided:** D1 — sign-in is optional; the app runs signed out (today's `App.tsx` behaviour). Board 01 becomes the in-app sign-in dialog skin; no full-screen wall.

### 15.5 Keep onboarding alive when the folder scan fails
- **Type:** bug · **Board(s):** 02a, 02a+ · **Spec:** §5b · **Gaps:** F1-06 · **Source:** `desk:app-machine.ts:338`, `desk:app-machine.ts:353`
- **Scope:**
  - `choosing.onError` stays on step 1 with an `error` in context instead of `#app.failure`.
- **Acceptance:**
  - [ ] A permission-denied scan shows the error and allows choosing another folder.
- **Tests:** extend app-machine tests.
- **Depends on:** —

### 15.6 Wire Retry to the boot failure state
- **Type:** bug · **Board(s):** 25c, 25c+ · **Spec:** §5h · **Gaps:** F1-08 · **Source:** `desk:app-machine.ts:668`, `desk:App.tsx:2168`
- **Scope:**
  - Ensure the `failure` state accepts a retry event and re-enters loading; the UI card is 13.1.
- **Acceptance:**
  - [ ] Retry from `failure` reaches `loading`.
- **Tests:** extend app-machine tests.
- **Depends on:** —

### 15.7 Persist MCP recovery dismissal
- **Type:** bug · **Board(s):** 23, 23+ · **Spec:** §6.6 · **Gaps:** F5-04 · **Source:** `desk:conversation-pane.tsx:120`, `desk:conversation-pane.tsx:137`
- **Scope:**
  - Replace the module-level `dismissedMcpRecovery` `Set` with a per-server persisted dismissal that survives a reload.
- **Acceptance:**
  - [ ] A dismissed card stays dismissed after reload and returns if the auth key changes.
- **Tests:** unit for the key; e2e extend `mcp-recovery.spec.ts`.
- **Depends on:** —

### 15.8 Fix the notification copy for tool approvals
- **Type:** bug · **Board(s):** 24b, 24b+ · **Spec:** §6.11 · **Gaps:** F4-03 · **Source:** `desk:notifier.ts:55`, `desk:notifier.ts:72`
- **Scope:**
  - Title is the workspace name; body is the first line of the question or "Run `pnpm test`?".
  - Tool gates are no longer labelled "approve a plan". Open question: does `needs-approval` cover tool gates too?
- **Acceptance:**
  - [ ] A tool gate and a plan approval produce different notification bodies.
- **Tests:** extend notifier tests.
- **Depends on:** —

### 15.9 Fix the roster Send button and swallowed stop errors
- **Type:** bug · **Board(s):** 20, 24b+ · **Spec:** §6.10 · **Gaps:** F6-03, F6-05 · **Source:** `ui:app/agent-roster.tsx:53`, `ui:app/agent-roster.tsx:56`, `desk:conversation-pane.tsx:1099`, `desk:conversation-pane.tsx:1102`
- **Scope:**
  - Send uses the neutral primary variant instead of hard-coded `bg-blue`; delivery failure shows "Not delivered · Retry".
  - Stop shows pending then "Stopped"; on failure a toast "Couldn't stop researcher · Retry" instead of `.catch(() => { })`.
- **Acceptance:**
  - [ ] A failed stop surfaces a toast with Retry.
- **Tests:** extend `agent-roster.test.tsx`; e2e extend `subagents-outlive-turn.spec.ts`.
- **Depends on:** 1.2, 2.4


---

## Coverage: gap id → sub-issue

| Gap | Sub-issue(s) |
|---|---|
| F1-01 | 9.1, 15.2 |
| F1-02 | 9.1, 15.2 |
| F1-03 | 9.1, 15.2 |
| F1-04 | 9.1, 15.3 |
| F1-05 | 15.4 |
| F1-06 | 9.3, 15.5 |
| F1-07 | 9.3 |
| F1-08 | 13.1, 15.6 |
| F1-09 | 9.4 |
| F1-10 | 9.5 |
| F1-11 | 9.6, 10.8 |
| F1-12 | 9.8 |
| F1-13 | 3.8, 10.12 |
| F1-14 | 5.2 |
| F1-15 | 9.2, 13.7 |
| F2-01 | 9.7 |
| F2-02 | 6.16, 6.17, 9.7 |
| F2-03 | 9.7, 14.9 |
| F2-04 | 7.2 |
| F2-05 | 7.3 |
| F2-06 | 7.5 |
| F2-07 | 6.3, 14.7 |
| F2-08 | 6.2 |
| F2-09 | 6.7 |
| F2-10 | 6.12 |
| F2-11 | 6.13 |
| F2-12 | 6.14 |
| F2-13 | 5.9 |
| F2-14 | 13.3 |
| F3-01 | 14.1 |
| F3-02 | 6.8 |
| F3-03 | 6.10, 14.2 |
| F3-04 | 6.11 |
| F3-05 | 13.8 |
| F3-06 | 6.5, 14.4 |
| F3-07 | 14.3 |
| F3-08 | 5.9 |
| F3-09 | 10.5, 14.3 |
| F4-01 | 12.1 |
| F4-02 | 12.2 |
| F4-03 | 15.8 |
| F4-04 | 12.3 |
| F4-05 | 9.6 |
| F4-06 | 10.11, 14.6 |
| F4-07 | 2.4, 12.4 |
| F5-01 | 5.13 |
| F5-02 | 5.13, 11.1 |
| F5-03 | 5.13 |
| F5-04 | 5.14, 15.7 |
| F5-05 | 5.10 |
| F5-06 | 5.15 |
| F6-01 | 8.1 |
| F6-02 | 8.8 |
| F6-03 | 15.9 |
| F6-04 | 8.7 |
| F6-05 | 15.9 |
| F6-06 | 12.5 |
| F6-07 | 8.7 |
| F7-01 | 10.14 |
| F7-02 | 10.13 |
| F7-03 | 10.13 |
| F7-04 | 10.13 |
| F7-05 | 5.15 |
| F7-06 | 5.15, 11.1 |
| F7-07 | 9.8 |
| F7-08 | 10.2 |
| F7-09 | 9.7 |
| F8-01 | 13.5 |
| F8-02 | 13.5 |
| F8-03 | 13.6 |
| F8-04 | 13.2 |
| F8-05 | 5.12 |
| F8-06 | 7.6 |
| F8-07 | 13.10 |
| F8-08 | 13.3 |

All 75 gaps in `06-flow-gaps.md` map to at least one sub-issue: **yes**.
