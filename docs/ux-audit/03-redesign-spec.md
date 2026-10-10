# Jingler redesign spec — "Improved" mocks

Inputs: `01-current-app-audit.md` (16 problems, cited P1–P16) and `02-competitor-research.md` (15 patterns, cited R1–R15).
Direction: Conductor-calm. Near-black, low-chroma neutrals, one accent, colour used only for **state**. Less chrome, fewer tab metaphors, composer-first.

---

## 1. Ranked improvements

| # | Change | Fixes | Borrowed from |
|---|---|---|---|
| 1 | **One sidebar instead of three columns.** Remove the 60px project rail and the 40px right view rail. Use a single 248px sidebar: Project → Workspaces tree. | P4, P11 | T3 Code (R3), Conductor |
| 2 | **One tab metaphor.** The workspace header holds one segmented strip: `Chat · Changes · Checks · Terminal · Browser · Files`. Session tabs leave the title bar, and chat/subagent tabs become a thread switcher inside Chat. | P3, P5 | Conductor, Codex |
| 3 | **Status as colour + word on every workspace row.** States are `Working` (blue, pulsing), `Needs you` (amber), `Ready` (green), `Failed` (red) and `Idle` (grey). A pencil marks unsent drafts. | P5, P8 | T3 Code (R4), Conductor (R2, R15) |
| 4 | **Composer reduced to one quiet row.** Keep `[+ attach] [Model ▾] [Plan/Build] [🔒 Ask]` then the send button on the right. Thinking level and environment move into the model popover. The context meter becomes a thin ring on the send button. | P6, P7 | T3 Code (R5–R7) |
| 5 | **Composer-first new workspace.** Lead with a big prompt box, with one chip row under it: `jingler ▾ · from main ▾ · worktree ▾`. Isolation and source are defaulted, so most users never touch them. | P7 | Codex, Conductor |
| 6 | **Changes view with per-turn filter + per-hunk accept/revert.** File tree on the left, diff in the centre, and a turn filter (`All turns ▾`). Inline comments go back to the agent. | — | T3 (R9), Codex (R10), Conductor |
| 7 | **Checks tab: PR readiness checklist.** Lists git status, CI, review comments, todos and the PR description, with one "Create PR" / "Merge" CTA. | — | Conductor (R12, R13) |
| 8 | **Checkpoint revert on message hover.** An undo icon on each turn rewinds the workspace to that point. | — | Conductor/T3 (R11) |
| 9 | **One settings surface.** Use a full-page view with 4 nav groups (Workspace · Agents · Integrations · Appearance) and drop the 520px dialog. 14 flat items become 4 groups of 3–4. | P1 | Conductor |
| 10 | **Real empty/loading/error states.** Every list gets a skeleton, an empty line with one CTA, and an inline error with Retry. | P12 | — |
| 11 | **Onboarding as 3 honest steps** (Folder → GitHub → Agent) with a real stepper. Resource import becomes an optional card on Home afterwards. | P13 | — |
| 12 | **Type scale of 5 sizes** (11/12/13/15/20) and **3 radii** (6/8/12). No 8.5–10px text anywhere. | P8, P10 | — |
| 13 | **Visible borders.** Hairlines are lighter than the surface (`#232327` on `#0f0f10`), not darker. | P9 | Conductor |
| 14 | **Resizable bottom terminal** (drag handle, default 240) that lives in the Terminal tab or the dock, not both. | P15 | — |
| 15 | **Platform-aware title bar.** Mac gets a traffic-light inset; Win/Linux get a window-controls overlay. | P16 | T3 Code |

Out of scope for mocks: P2/P14 (duplicate primitives, god components). These are code refactors that ship alongside.

---

## 2. Tokens — "Jingler Graphite" (new neutral dark)

```
--bg-app        #0b0b0c   window / behind everything
--bg-sidebar    #0f0f10
--bg-surface    #131315   main pane
--bg-elevated   #1a1a1d   cards, composer, popovers
--bg-hover      #202024
--bg-active     #26262b   selected row
--border        #232327   default hairline
--border-strong #303036   inputs, focused cards
--text-1        #ededef   primary
--text-2        #a1a1aa   secondary
--text-3        #7c7c86   tertiary / placeholders (≥4.5:1 on sidebar)
--accent        #ef3f57   brand rose — ONLY primary CTA, focus ring, selection
--accent-soft   rgba(239,63,87,.14)
--state-working #5b9cf5
--state-needs   #e5a83b
--state-ready   #4fbf7f
--state-failed  #f0605d
--diff-add-bg   rgba(79,191,127,.10)   --diff-add-fg #6fd39a
--diff-del-bg   rgba(240,96,93,.10)    --diff-del-fg #f08a87
```
- Fonts: **Hanken Grotesk** (UI) and **JetBrains Mono** (code, branch names, diff stats). Both are kept so the mocks map straight back to code.
- Type scale: 11 (meta/kbd) · 12 (secondary rows) · 13 (body UI, default) · 15 (section titles) · 20 (page titles). Weights are 400/500/600 only.
- Radii: 6 (chips, buttons, rows) · 8 (inputs, menus) · 12 (cards, composer, dialogs).
- Spacing: 4px grid. Row height 32, header 44, tab strip 36, buttons 28 (small) / 32 (default).
- Icons: lucide-style 1.5px stroke, 14px in rows, 16px in toolbars, colour `--text-3`, and `--text-1` on hover/active.
- Shadows: only on floating layers: `0 12px 32px rgba(0,0,0,.5), 0 0 0 1px #232327`.
- Colour discipline: the accent appears at most once per screen outside focus. Blue is never used for "active nav", only for "working".

---

## 3. Improved shell layout (1440×900)

```
┌──────────────┬───────────────────────────────────────────────────────────────┐
│ ● ● ●        │ HEADER h44: "Fix PR inbox pagination"  ⎇ morgan/pr-inbox-page  │
│ [⌘K Search ] │   PR #482 ● Checks 3/4      [Chat|Changes 12|Checks|Terminal|  │
│ [+ New  ⌘N]  │   Browser|Files]                       [Open in ▾] [Create PR] │
│              ├───────────────────────────────────────┬───────────────────────┤
│ ▾ jingler    │ CHAT (max-w 760, centred)             │ RIGHT PANEL 400       │
│  ● Working   │  user turn (bubble, right-ish)        │ (optional, ⌘⇧D)       │
│    Fix PR…   │  assistant: prose + collapsed tool    │ Changes summary:      │
│    +84 −12   │  rows "Read 4 files", "Edited 3"      │ file list with +/−,   │
│  ● Needs you │  plan card with steps                 │ turn filter           │
│  ◌ Ready  PR │                                       │                       │
│ ▾ trigify-app│ ┌ COMPOSER (r12, elevated) ──────────┐│                       │
│  …           │ │ Ask Jingler to…                    ││                       │
│              │ │ [+] [Opus 5.5 ▾] [Plan|Build] [🔒] (↑)│                     │
│ ───────────  │ └────────────────────────────────────┘│                       │
│ (avatar) Morgan  ⚙ │                                │                       │
└──────────────┴───────────────────────────────────────┴───────────────────────┘
 sidebar 248
```
Workspace row (2 lines, 44px tall): line 1 is a status dot + title (13/500, text-1) + right-aligned time. Line 2 (12, text-3, mono for branch) is the status word coloured by state, then `· branch`, then a right-aligned `+84 −12` and PR glyph. A pencil icon replaces the time when a draft exists. Selected row: bg-active, r6.
Project group header: 11px uppercase text-3 with letterspacing 0.04em, repo icon, count, and a `+` on hover.

---

## 4. View map (Improved page artboards)

| # | Artboard | Key content |
|---|---|---|
| 00 | Design system | Tokens swatches, type scale, radii, buttons (primary/secondary/ghost × default/hover/disabled), status pills ×5, workspace row ×states, composer, tab strip |
| 01 | Login | Centred 360px card on bg-app, logo mark, "Sign in to Jingler", GitHub button (primary), email + "Send magic link", tiny footer |
| 02 | Onboarding | 3-step stepper top (Folder ✓ · GitHub ● · Agent ○), single card 520px, step 2 content: "Connect GitHub" with benefit list + Connect / Skip for now |
| 03 | Home (no workspace selected) | Sidebar + main: greeting, big composer "What should we build?" with repo/source chips, below: "Needs you (2)" cards, "Recent" list, optional card "Import MCP servers & skills from Claude Code" |
| 04 | Workspace · Chat | Full shell per §3 with right Changes panel open, a believable transcript, plan card, a `Needs you` approval card ("Run `pnpm test`?" Allow once / Always / Deny) |
| 05 | Workspace · Changes | Tab Changes active. Left 260 file tree with +/−; turn filter dropdown "Turn 3 of 5"; unified diff with hunk header actions (✓ Keep / ↺ Revert), inline comment thread "Send to agent" |
| 06 | Workspace · Checks | PR readiness checklist rows with state icons: Branch pushed ✓, CI 3/4 (1 running), 2 unresolved review comments → "Ask agent to fix", PR description ✓, Todos 1 open; CTA "Merge PR" disabled with reason |
| 07 | Workspace · Terminal | Chat tab with bottom terminal dock (drag handle, tabs "dev", "test", +), showing pnpm output |
| 08 | New workspace (⌘N) | Modal-free: main pane composer-first, chips row: repo, from `main`/PR/issue, isolation `worktree`; Linear/GitHub issue suggestions list below to start from |
| 09 | Settings | Full page, left nav 220 with 4 groups (Workspace: General, Projects, Permissions · Agents: Providers, Agents & skills, MCP servers, Runtime · Integrations: GitHub, Linear, Plugins, Devices · Appearance: Theme, Keybindings). General open with grouped rows (label left, control right) |
| 10 | Command palette | ⌘K over Workspace·Chat, 640px, sections: Workspaces (with status), Actions (New workspace ⌘N, Toggle terminal ⌃`, Open changes ⌘⇧D), Files |
| 11 | Parallel overview | Sidebar with ~8 workspaces across 3 repos in mixed states, main showing "Needs you" queue: stacked cards each with the blocking question and inline answer buttons |
| 12 | Empty / loading / error | 3 panels side by side: sidebar skeleton, empty project ("No workspaces yet" + New workspace), GitHub error inline "Couldn't load PRs · Retry" |
| 13 | Before → After notes | Table mapping each P1–P16 to the improvement # and the artboard that shows it |
