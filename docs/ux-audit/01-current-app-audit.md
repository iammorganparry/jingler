# Jingler desktop – current UI audit (code-derived)

Scope: `apps/desktop/src/renderer/**` (thin wiring + XState machines + hooks) and `packages/ui/src/**` (all real UI). Renderer `.tsx` is only ~7k lines; nearly all visuals live in `packages/ui/src` (~50k lines).
**Coverage caveat:** this audit was produced from targeted reads (shell, sidebar, rails, tokens, setup/login, settings nav, machines' state lists). Inner panes (conversation, composer, PR view, review, plugins/MCP settings) are inventoried by file and role, with sizes where classNames were inspected; items marked *(not read in detail)* need a second pass before pixel-redrawing.

**Important correction:** the tokens are **not One Dark Pro** any more. Default theme is **Jingler Dark** (warm-neutral greys + brand rose `#ef3f57`). One Dark Pro survives only as one of 11 bundled VS Code-format themes.

---
## 1. View inventory

Entry: `apps/desktop/src/renderer/main.tsx` → `App.tsx` (drives `app-machine.ts`, `auth-machine.ts`) → `packages/ui/src/app/jingler-app.tsx` (1380 lines, ~200 props) which composes everything. `root-error-boundary.tsx` wraps the root.

### Top-level screens (`packages/ui/src/screens/`)
| Screen | File | Renders |
|---|---|---|
| Loading | `loading-screen.tsx` | splash while `app.loading` (brand mark / shader `brand/brand-shader.tsx`) |
| Login | `login-screen.tsx` | `AuthCard` (`composites/auth-card.tsx`, h1 17px centred): title "Sign in to Jingler", subtitle "Run and manage your agent sessions."; OAuth buttons (`components/oauth-button.tsx`, GitHub/Linear marks), `auth-divider`, `magic-link-form.tsx` (email → magic link sent state); toggle link "Create an account"/"Sign in"; footer bar absolute bottom `h-[42px]` border-t, 12px muted text (line 163) |
| Setup / onboarding | `setup-screen.tsx` + `setup/provider-setup-step.tsx`, `setup/resource-setup-step.tsx` | centred column `max-w-[520px]`, gap-6. Eyebrow "Welcome · 1 of 2" / "Welcome · 2 of 2", h1 22px semibold. Step 1: pick workspace folder (Continue / skip GitHub). Step 2: connect provider (Claude / Codex / API key forms `composites/provider-auth-forms.tsx`, Continue/Skip) then resource import (MCP/skills; `Import`/`Skip`) |
| Empty conversation | `empty-conversation.tsx` | centred h1 20px + prompt starters |
| Session pane | `session-pane.tsx` (934) | per-session container: tab content area, chat tabs, composer, docks |
| Conversation | `session-conversation.tsx` (434) + `app/conversation-view.tsx` (803) | transcript: `composites/message-turn.tsx`, `tool-call`, `thought-block`, `plan-card`, `question-card`, `approval-gate`, `queued-message-row`, `context-divider` |
| Plan review | `plan-review.tsx` | plan doc with inline comments (`plan-comment-layer`, `plan-stage-card`, `plan-step-list`) |
| Explanation | `explanation-view.tsx` | markdown/mermaid explainer |
| Stub / component library | `stub-screen.tsx`, `component-library.tsx` | dev only |

### Shell regions (`packages/ui/src/app/`)
- `app-shell.tsx` – frame (TitleBar + content row), `bg-panel`.
- `title-bar.tsx` – h-11 (44px) drag region, `px-3.5`, left 44px spacer (traffic lights), centre = portal `#session-tab-bar-portal` (session tabs render here), right = `actions`.
- `title-search.tsx` – button `h-[30px] w-[min(52vw,560px)]`, "Search sessions, actions…" + `⌘K` kbd (opens command palette).
- `project-sidebar.tsx` – 60px project rail (see §2).
- `session-sidebar.tsx` (1244) – session list; width 266 (200–380 draggable, key `sb.sidebar.width`); collapses to 52px rail under 1000px shell width.
- `view-rail.tsx` – 40px (`w-10`) right icon rail of tab views.
- `tab-bar.tsx`, `chat-tab-bar.tsx`, `subagent-tab-bar.tsx`, `editor-groups.tsx`, `split-layout.ts`, `session-split.tsx` – tab strips and split panes (strips h-9/h-10).
- `terminal-panel.tsx` – bottom terminal dock, `h-[256px]`, header h-9.
- `preview-dock.tsx` – browser preview dock (header h-9), side selectable (`SET_SIDE`).
- `diff-panel.tsx`, `agent-roster.tsx`, `command-palette.tsx`.

### Tabs (BUILTIN_TAB, `tab-contributions.ts:56`)
conversation, files, browser, terminal, issue, explanation, plan, pr, review, changes, workflow (+ plugin tabs via `plugin-tab-host.tsx`, `plugin-pane-host.tsx`). Renderer counterparts: `file-browser-view.tsx`, `changes-review.tsx`, `pull-request-pane.tsx`, `workspace-checkpoints-view.tsx`, `terminal-dock-view.tsx`, `preview-dock-view.tsx`, `xterm-view.tsx`, `workspace-workflow-bar.tsx`.

### Session sidebar (`session-sidebar.tsx`)
Header row (`px-3 pb-2 pt-3`): brand mark 14px (or text "Workspace" when a workspace-view switch is present) · Collapse (PanelLeft, ⌘B) · spacer · Filter-and-sort menu (`filter-menu.tsx`: status, repo, starred) · New session (+, ⌘N). Below: global search (opens palette). List: `session-tree.tsx`/`session-row.tsx` (status dot, title, diff stat, PR glyph, hover card `session-hover-card.tsx`), grouped by repo (collapse/star), archived group. Footer: `user-menu.tsx` account menu → Settings, Usage & limits, Sign out / Sign in; update + release-notes affordances. Rows `h-9` in places (lines 556/579, 12px semibold).

### Modals / dialogs / popovers
- `add-project-dialog.tsx` (+machine): browse folder / clone URL / GitHub repo list, create directory.
- `settings-dialog.tsx` (`w-[520px]`) and full `settings-view.tsx` (1540 lines) – both exist (see problems).
- `usage-modal.tsx` – usage & limits.
- `sign-in-dialog.tsx`, `environment-dialog.tsx`, `confirm-dialog.tsx`, `command-palette.tsx` (cmdk), `mcp-import-prompt.tsx` (renderer).
- Popovers/menus: `chip-menu`, `filter-menu`, `context-menu` (two implementations: `components/context-menu.tsx` and `components/beui/context-menu.tsx`), `hover-card`, `tooltip` (two), `popover-morph`, composer options (`w-72`), model browser (`provider-model-browser.tsx`).
- Banners: `archived-banner`, `branch-drift-banner`, `runtime-recovery-card`, `callout`.

### New session (`composites/new-workspace-view.tsx`, 645 lines)
Header `h-12` border-b, h1 "New session" 13px. Body `max-w-[1040px]`, card variant `max-w-[560px] rounded-2xl p-8`. Row of four pickers each `min-w-[130px] flex-1`, `h-10`: **Project · Source (branch / PR / issue) · Isolation (checkout) · Branch**. Search input "Search pull requests…" / "Search issues…", issue/PR picker lists (`pr-picker-list`, `issue-picker-list`, `linked-issue-selector`), then composer. Machine: `new-workspace-machine.ts` (events SET_PROJECT, SET_SOURCE, SET_ISOLATION…).

### Settings sections (`settings-view.tsx:110-158`)
General · Projects · Devices · Providers · Context · Plan · Agents & skills · Runtime · Permissions · MCP servers · GitHub · Themes · Plugins · Keybindings (14, left nav w/ 14px icons; some `ready:false`). Related files: `provider-connections-settings.tsx`, `agents-settings.tsx`, `mcp-settings.tsx`(726), `plugins-settings.tsx`(671), `themes-settings.tsx`(590), `routines-settings-view.tsx`, `web-search-settings.tsx`, `project-workflow-settings.tsx`, `runtime-inspector.tsx`. General has font-scale (Small .9 / Default 1 / Large 1.15 / Extra Large 1.3), default mode (Ask / Accept Edits / Auto), ADHD mode, notifications.

### PR / review
`pull-request-view.tsx`(676), `pr-side-panel.tsx` (resizable rail, default 352px), `pull-request-inbox.tsx`, `pr-review-thread/composer/group`, `pr-check-row`, `pr-timeline-entry`, `review-code-view.tsx`(685), `review-file-rail/tree`, `review-findings.tsx`, `review-tray.tsx`, `changes-review.tsx`(485), `issue-inbox.tsx`, diff engine `diff/*` (Pierre).

### Composer (`composites/composer.tsx`, 1349 lines)
Textarea 14px/1.5, `max-h-64`; toolbar row (wrapping) with: environment select, provider/model browser, **mode** select (max-w 104), **thinking/reasoning** select, "Composer options" popover (w-72), attachments, mention menu, slash-command rows, send/stop; `context-meter.tsx`, queued messages, inline `plan-progress-dock`, `background-task-dock`.

---
## 2. App shell layout

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ TITLE BAR h44 drag, bg-panel, border-b | [44 traffic-light spacer][ session tabs portal … ][actions]│
├──┬────────────┬──────────────────────────────────────────────────────────────┬──┤
│60│ SESSION    │ SESSION PANE                                                  │40│
│PR│ SIDEBAR    │ ┌ chat tab bar (h40) / editor-group tab strips (h36) ───────┐ │VI│
│OJ│ 266 (200-  │ │ active TAB: conversation|files|browser|terminal|plan|pr|  │ │EW│
│EC│ 380 drag)  │ │ review|changes|explanation|issue|workflow|plugin          │ │RA│
│TS│ or 52 rail │ │  (splits via split-layout; 3px resize gutters)            │ │IL│
│  │ <1000px    │ ├───────────────────────────────────────────────────────────┤ │  │
│+ │ header     │ │ composer (+queue, plan progress, bg tasks, context meter)  │ │  │
│  │ search     │ ├───────────────────────────────────────────────────────────┤ │  │
│  │ list       │ │ TERMINAL DOCK h256, header h36 (toggle)                   │ │  │
│  │ footer acct│ └───────────────────────────────────────────────────────────┘ │  │
│  │            │  PREVIEW DOCK (browser, side L/R via SET_SIDE, header h36)    │  │
└──┴────────────┴──────────────────────────────────────────────────────────────┴──┘
```
- Project rail: `w-[60px]` `border-r`, `bg-panel`, mark h-5 at top, 40px rounded-xl avatars (32px inner), count badge top-right (blue pill), running dot bottom-left, yellow dot if unavailable, dashed "+" add-project at bottom; active = 3px blue bar at left and 14px radius.
- Sidebar bg: `AISidebarSurface`; view rail: `w-10 bg-sunken border-l`, 16px icons, 8.5px mono counts, green 5px dot for diffs. Width tiers via `hooks/width-tier.tsx` (wide/mid/narrow tab max-w 210/150/92; chat tabs 190/130/96).
- Borders use `border-hairline` (= `--sb-border` #0f0f0f); separators `--sb-line`.

---
## 3. Flows and machines

| Flow | Driver | States / transitions |
|---|---|---|
| Sign in | `auth-machine.ts` | `checking` → `signedIn` or `signedOut{idle, sending, magicLinkSent, oauthPending, error}`; events OAUTH, MAGIC_LINK, CALLBACK, RESET, SIGN_OUT; `signedIn`→`signingOut`→`signedOut` |
| Boot / onboarding | `app-machine.ts` | `loading` → `ready` / `setup` / `failure`. `setup.workspace{idle,choosing}` → `github` (SKIP_GITHUB / GITHUB_CONNECTED) → `provider{refreshing,…}` (CONNECT_CLAUDE, START_CODEX, CONNECT_API, CANCEL_AUTH, RETRY_AUTH, SKIP_PROVIDER) → resources (IMPORT_RESOURCES, SKIP_RESOURCES, RETRY_RESOURCES) → `ready`; session events (SESSION_CREATED/UPDATED/DELETED, SESSION_PR_LINKED) live here |
| Register project | `composites/add-project-machine.ts` (+`use-projects.ts`) | browse / clone / GitHub list / create dir → register; `project-workflow-machine.ts` for per-project workflow |
| New workspace/session | `new-workspace-machine.ts`, `environment-session-startup-machine.ts`, `environment-machine.ts` | choose project/source/isolation/branch → create → env startup |
| Run agent | `conversation-machine.ts` (+`conversation-registry`, `use-conversation.ts`), `subagent-fleet-machine.ts`, `runtime-inspector-machine.ts` | streaming turns, approvals, questions, plans, queued messages, subagent tabs |
| Review diff / PR | `code-review-view-machine.ts`, `pull-request-inbox-machine.ts`, `issue-inbox-filter-machine.ts`, `publish-machine.ts`, `workspace-checkpoints-machine.ts`, `github-connection-machine.ts`, `session-archive-machine.ts` | publish: `idle→publishing→{failed,complete,no-changes}` (RETRY/PUBLISH re-enter); review store via `review-store.ts`, `use-review.ts` |
| Layout | `editor-layout-machine.ts`, `preview-dock-machine.ts` (single state `active`; events FOCUS_SESSION, TOGGLE, SET_SIDE, NAVIGATE, REVEAL_BROWSER, RECONCILE_SESSIONS) | |
| Settings | `agents-settings-machine`, `offload-settings-machine`, `routines-machine`, `provider-connections-settings-machine`, `routine-form-machine`, `plugin-secret-setting-machine` | per-section form machines |

---
## 4. Design system

### Fonts / sizes / radii
- Sans: Hanken Grotesk Variable (self-hosted). Mono: JetBrains Mono Variable. Fallbacks system-ui / ui-monospace.
- Sizes are arbitrary px classes, no scale. Frequent: 8.5, 9, 10, 10.5, 11, 11.5, 12, 13 (default UI), 14 (composer), 17 (auth h1), 20 (empty h1), 22 (setup h1). Most common is 11–12px.
- Radii: `--radius` 5; sm 3, md 4, lg 5, xl 7 (editor-tight). In practice components override: `rounded-lg`, `rounded-xl` (project avatars, composer selects), `rounded-2xl` (new-session card), `rounded-[14px]`, `rounded-[10px]`.
- Spacing: Tailwind 4px grid, heavy on 0.5/1.5/2.5 half-steps.
- Icons: `lucide-react` (sizes 14/16/17/20), plus brand marks (`github-mark`, `linear-mark`, `provider-icon`, `jingler-mark`), `file-icon` for files.
- Motion: `motion/react`, `MotionConfig reducedMotion="user"`, `lib/motion.ts`, beui overlays/shared-layout indicators.

### `--sb-*` tokens – Jingler Dark fallback (`packages/ui/src/globals.css`)
Surfaces: canvas `#141414`, sunken `#171717`, panel `#1b1b1b`, editor `#212121`, surface `#2b2b2b`, border(hairline) `#0f0f0f`, line `#333333`, line-strong `#454545`.
Text: bright `#f4f1f1`, body `#dedada`, text `#c6c1c1`, muted `#8d8686`, dim `#6a6363`.
Accents: blue `#6faef6`, green `#70d294`, yellow `#ebcb60`, red `#ee8372`, purple `#db91ed`, cyan `#5eccd4`, orange `#f1a35f`.
Brand: brand `#ef3f57`, brand-hover `#f5687b`. link-hover `#f5687b`.
Effects: overlay `rgb(0 0 0/.55)`, shadow `/.45`, shadow-strong `/.62`, selection `rgb(239 63 87/.22)`, hover `rgb(255 255 255/.055)`, scrollbar `rgb(255 255 255/.125)`, hover `.2`.
Diff: add-bg `rgb(112 210 148/.125)`, del-bg `rgb(238 131 114/.125)`, add-fg `#447e59`, del-fg `#855047`.
shadcn mapping: background=editor, foreground=text, card=panel, popover=sunken, primary=brand (fg `#fff`), secondary/accent=surface, muted=panel, destructive=red, border/input=line, ring=brand.
Reference (old One Dark Pro defaults, still a bundled theme): bg `#282c34`, blue `#61afef`, green `#98c379`, yellow `#e5c07b`, red `#e06c75`, purple `#c678dd`, cyan `#56b6c2`, orange `#d19a66`.
Other bundled themes: 11 total incl. `jingler-light`; VS Code JSON import (`composites/themes-settings.tsx`, `use-theme.ts`).

### Components in `packages/ui/src/components` (shared)
async-button, attachment-source/thumb, auth-divider, avatar, badge, button (+button-group), callout, card, checkbox, chip-menu, code-chip, command, confirm-dialog, context-menu, dialog, diff-peek, diff-stat, eyebrow, feedback, file-change-list, file-chip, file-icon, filter-menu, github/linear-mark, hover-card, html-preview, input, kbd, loading, markdown (streamdown+katex), mermaid-diagram, oauth-button, pierre-file-tree, pill, provider-icon, resizable, search-input, segmented-control, select, signal-bars, spin, status-dot, toggle, tooltip, plus `components/beui/` (action-swap, agent-code, agent-disclosure, animated-badge, code-block, context-menu, controls, file-diff, loader, overlays, popover-morph, select, tool-result, tooltip, hooks).

---
## 5. UX problems (file:line)

1. **Two settings surfaces** – `composites/settings-dialog.tsx:112` (520px modal) and `settings-view.tsx` (1540 lines, 14 sections, `:110-158`). Pick one; some sections flagged `ready:false`.
2. **Duplicate primitives** – tooltip (`components/tooltip.tsx` vs `beui/tooltip.tsx`), select (`components/select.tsx` vs `beui/select.tsx`, 671 lines), context-menu (`components/` vs `beui/`), 4+ hand-rolled `z-50 … rounded-lg border-line bg-sunken p-1.5 shadow-2xl` menus (`tab-bar.tsx:104`, `chat-tab-bar.tsx:335,383`, `editor-groups.tsx:639`).
3. **Too many tab/strip layers** – title-bar tab portal (`title-bar.tsx:25`), chat tab bar h-10 (`tab-bar.tsx:435`), editor-group strips h-9 (`editor-groups.tsx:456`), subagent tabs, right view rail, terminal tabs (`terminal-panel.tsx:135,362`), preview-dock header (`preview-dock.tsx:77,103`). Session switching, chat switching, view switching and file switching are four different tab metaphors. Heights inconsistent: 44 / 40 / 36.
4. **Three left columns** – 60px project rail + 266px session sidebar + 40px view rail on the right = 366px of chrome before content; sidebar silently becomes 52px rail at <1000px (`session-sidebar.tsx:894,914`). Project count badge duplicates session list.
5. **Hidden features** – ⌘K palette is the only search (sidebar's own filter removed; `session-sidebar.tsx:776-787`), filter menu is an unlabelled icon (`:789-810`), view tabs are icon-only with 8.5px counts (`view-rail.tsx`), mode/thinking/options hidden in a composer popover (`composer.tsx:696`), terminal/preview toggled via shortcuts only.
6. **Composer toolbar overload** – env, model, mode, thinking, options, attachments in one wrapping row (`composer.tsx:557-700`); controls shrink to `max-w-[104px]`/`52` and truncate.
7. **Mode proliferation** – permission default mode (Ask/Accept Edits/Auto), plan mode, ADHD mode, isolation (checkout), source (branch/PR/issue), offload compute; concepts leak to the first-run of "New session" as four peer dropdowns (`new-workspace-view.tsx:385-388`) with no explanation.
8. **Typography chaos** – dozens of arbitrary sizes (8.5–22px), 11–12px dominant, 8.5px counts (`view-rail.tsx`), 9px badges (`project-sidebar.tsx`), 10px paths; weak hierarchy since nearly everything is same grey-on-grey. `--sb-dim #6a6363` on `#1b1b1b` is ≈3:1 contrast (fails AA) and is used for rail icons and placeholders (`title-search.tsx`, `view-rail.tsx`).
9. **Hairline invisibility** – `--sb-border #0f0f0f` on `#1b1b1b` panels is almost invisible; separation relies on tone steps (canvas→panel→editor differ by ~6 L) giving flat, low-hierarchy panes.
10. **Inconsistent radii/sizes** – rounded-xl rail avatars, 14px active radius, rounded-lg tabs, rounded-2xl card, 5px tokens; heights h-8/h-9/h-10 for similar buttons (`session-sidebar.tsx:556`, `composer.tsx:222`, `new-workspace-view.tsx:248`).
11. **Colour semantics** – blue (not brand) marks active state in rails (`view-rail.tsx`, `project-sidebar.tsx`), while brand red is primary action/focus ring; selection tint is brand. Two competing "accent" signals.
12. **Loading/empty/error gaps** – only project rail has skeletons (`project-sidebar.tsx`, 3 pulse boxes); `loading-screen.tsx` and `failure` state in `app-machine.ts` exist but sidebar/session list, PR/issue pickers and settings sections have ad hoc or no loading rows *(partially verified)*. Magic-link `error` state exists in `auth-machine.ts:145` with only RESET.
13. **Onboarding length** – workspace → GitHub (skippable) → provider → resource import, labelled "1 of 2 / 2 of 2" (`setup-screen.tsx:104,143`) though app-machine has 4+ substates; progress label is wrong.
14. **Giant god components** – `jingler-app.tsx` ~200 props (`:728`), `settings-view.tsx` 1540, `composer.tsx` 1349, `session-sidebar.tsx` 1244: any redesign must split these first.
15. **Fixed pixel docks** – terminal `h-[256px]` (`terminal-panel.tsx:360`) vs resizable elsewhere; PR panel 352 default; new-session picker content `w-[380px]` (`new-workspace-view.tsx:207`).
16. **Platform assumptions** – 44px left spacer for macOS traffic lights (`title-bar.tsx:22`) applied on all platforms.

## Next-pass gaps
Read in detail before redrawing: `session-pane.tsx`, `message-turn.tsx`, `pull-request-view.tsx`, `review-code-view.tsx`, `settings-view.tsx` section bodies, `plan-*`, `usage-modal.tsx`, `command-palette.tsx`, `user-menu.tsx`.
