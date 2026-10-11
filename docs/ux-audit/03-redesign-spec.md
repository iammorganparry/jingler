# Jingler redesign spec — "Improved" mocks

Inputs: `01-current-app-audit.md` (16 problems, cited P1–P16) and `02-competitor-research.md` (15 patterns, cited R1–R15).
Direction: Conductor-calm. Near-black, low-chroma neutrals, one accent, colour used only for **state**. Less chrome, fewer tab metaphors, composer-first.

---

## 1. Ranked improvements

| # | Change | Fixes | Borrowed from |
|---|---|---|---|
| 1 | **Two left columns, not three.** Keep the Slack-style project rail (slimmed to 56px) to switch projects. Remove the 40px right view rail. The 248px sidebar then lists only the active project's workspaces, so there's no repo grouping. Rail avatars: active = 2px `--text-1` bar + `--bg-active` tile (not blue). Badges show only `Needs you` count (amber), and a pulsing blue dot shows when something is working. Drop the per-project session count badge. | P4, P11 | Slack, T3 Code (R3), Conductor |
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
- **Brand (use the real assets, never redraw).** Files live in `packages/ui/src/brand/assets/`. In Paper, reference them as `paper-asset:///Users/morganparry/jingler/worktrees/jingler/elegant-bohr/packages/ui/src/brand/assets/<file>`:
  - `jingler-mark.svg` (colour mark, 117×127, taller than wide) for login, onboarding, loading and the empty Home greeting.
  - `jingler-mark-mono.svg` for small chrome: the top of the project rail (16px tall, `--text-2`), the settings nav header and the account menu.
  - `jingler-logo.svg` (full logo) for the login hero and the design-system board.
  - `jingler-icon-color.png` (app icon) for the About/What's new card and the design-system board.
  - **Lockup** (`JinglerWordmark`): mark at 1.15em in brand rose `#ef3f57`, an 8px gap, then "Jingler" in Hanken Grotesk 600, tracking −0.01em, `--text-1`. Use it on login, onboarding and the settings header.
  - The brand rose counts toward the "accent once per screen" rule. The rose mark on login and onboarding *is* that screen's accent, so the primary button there goes neutral (`--text-1` fill, `--bg-app` text).
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
**Project rail (kept, Slack-style):** a 56px column sits left of the sidebar on every shell board, bg `--bg-app`, with a `--border` hairline on the right. From the top it holds: traffic-light inset, then 36px rounded-8 project tiles (initials or repo avatar). The active tile gets a 2px `--text-1` bar on its left edge plus a `--bg-active` fill. An amber count badge shows `Needs you` items, and a pulsing blue dot means something is working. A dashed `+` add-project tile sits at the bottom, and the account avatar goes in the rail footer. `⌘1–9` switches projects. Because the sidebar shows only the active project's workspaces, it loses the repo group headers. Total left chrome is 56 + 248 = 304px, down from 366 today.
Workspace row (2 lines, 44px tall): line 1 is a status dot + title (13/500, text-1) + right-aligned time. Line 2 (12, text-3, mono for branch) is the status word coloured by state, then `· branch`, then a right-aligned `+84 −12` and PR glyph. A pencil icon replaces the time when a draft exists. Selected row: bg-active, r6.
Project group header: 11px uppercase text-3 with letterspacing 0.04em, repo icon, count, and a `+` on hover.

---

## 3b. Copilot layout: chat lane + content area

**Today** (`app/editor-layout.ts`): chat is one lane of a generic split tree. When no content is open it fills 100%. The first file or view splits it to `CHAT_RATIO = 1/3`. Panes can be squashed to `MIN_RATIO 0.15` (~150px), and the chat has its own tab strip like any other group. It works, but chat is just another pane: it gets crushed, jumps size, and adds a fourth tab metaphor.

**Improved:** chat becomes a first-class lane with four explicit modes, like Cursor's agent pane and VS Code's Copilot chat.

| Mode | When | Chat width | Toggle |
|---|---|---|---|
| **Full** | no file or view open | 100%, transcript max-w 760 centred | automatic |
| **Docked** | ≥1 file/view open | remembered **px** width, default `clamp(360px, 33%, 560px)` | automatic |
| **Collapsed** | user hides it | 0, with a floating "Ask ⌘L" pill bottom-right of the content | `⌘L` (Cursor parity) |
| **Focus** | user maximises chat while files stay open | 100%, content tabs kept but hidden | `⌘⇧L` or double-click the handle |

Rules:
1. **Width is px, not ratio.** The lane keeps 420px whether the window is 1280 or 2560 wide. Hard floor 320px. Below that it snaps to Collapsed instead of squashing. Snap points at 33% and 50%. Double-click the handle to reset.
2. **Animated hand-off.** Opening the first file slides chat from Full → Docked over 180ms with transcript reflow. Closing the last tab slides back. Respect `prefers-reduced-motion` (already handled once in `app-shell.tsx`).
3. **No tab strip on chat.** The lane header (h36) is a thread switcher: `▾ Fix PR inbox pagination` plus `+ New chat` and subagent chips (`2 subagents`). Every tab lives in the content area: files, Changes, Checks, Terminal, Browser.
4. **Editor ↔ chat binding.** Agent edits open in the content area with inline diff decorations and per-hunk Keep/Revert (Cursor-style). Selecting code and pressing `⌘L` (or `⌘K` inline) adds a context chip `session-row.tsx L40–62` to the composer. The composer always shows the active file as a removable chip.
5. **Follow agent.** A toggle in the lane header (an eye icon) makes the content area follow the file the agent is editing. This builds on the existing `composer-follow-agent` behaviour.
6. **Narrow windows (<1100px).** Content wins and chat turns into a 400px overlay drawer over the content, with a scrim, toggled by `⌘L`.
7. **Side.** Chat stays on the left, next to the sidebar (current behaviour). A setting to move it right is a follow-up.

Artboards: **04b · Chat full** (no content), **04c · Chat docked + file with agent diff decorations**, **04d · Chat collapsed + Ask pill**, **04e · Narrow window drawer**.

## 3c. Where the right view rail's items go

The 40px right rail (`app/view-rail.tsx`, items from `BUILTIN_TAB_META` in `app/tab-contributions.ts:221`) goes away. Each view opens as a **content tab**, which puts chat into Docked mode (§3b). You can reach every view three ways:

1. **View launcher on the right side of the workspace header (h44).** Four pinned buttons carry the rail's badges, now readable at 11px: `[Changes 12] [Checks 3/4] [Terminal] [Browser]`. A `⋯` overflow menu holds the rest, plus plugin views and "Pin to header".
2. **Context links.** The thing that produced a view links to it. For example, a plan card has "Open plan" and the header PR chip opens Checks.
3. **⌘K → "Open view…"**, plus `⌥1–9` for views (`⌘1–9` is taken by project switching).

| Rail item today | New home | Shortcut |
|---|---|---|
| Conversation | Always visible as the chat lane, so no tab needed | `⌘L` |
| Changes | Pinned header button with the `+/−` file count | `⌘⇧D` |
| Code Review | Merged into Changes. Review findings show inline on hunks, and the "Review" toggle sits in the Changes toolbar | — |
| Pull Request | Header `PR #482` chip → **Checks** tab (CI, review threads, merge) | `⌘⇧P` |
| Workflow | A section inside Checks ("Workflow: 2 of 4 steps") | — |
| Terminal | Pinned button. Opens the bottom dock (default) or as a tab via "Move to tab" | `` ⌃` `` |
| Browser | Pinned button. Agent previews also auto-open it, with a "Preview ready" chip in the transcript | `⌘⇧B` |
| Files | Overflow menu, plus `⌘P` quick open and clickable file paths in the transcript | `⌘P` |
| Plan | Overflow menu, plus "Open plan" on the transcript plan card | — |
| Explanation | Overflow menu, plus "Open explanation" on the transcript card when the agent publishes one | — |
| Issue | Header `LIN-482` chip next to the branch, plus the overflow menu | — |
| Plugin tabs | Overflow menu → "Plugins" section, each one pinnable to the header | — |

Pinned set is per user (Settings → Appearance → Header views). Max 5 pinned; the rest overflow.

Artboard: **04g · View launcher**. This is board 04c with the `⋯` menu open (sections: Views · Plugins · "Pin to header" toggles), and hover tooltips with shortcuts on the pinned buttons.

## 3d. Split layouts: chat ⅓ + content ⅔, and content splits

**Today:** the editor tree (`app/editor-layout.ts`) opens content beside chat at `CHAT_RATIO 1/3 : CONTENT_RATIO 2/3`. Drops go to `left|right|top|bottom|center` (`DropEdge`, line 22), with `MAX_PANES = 3` and `MIN_RATIO 0.15` (`split-layout.ts:65,68`). The rules stay, but the visuals get tighter.

**Improved:**
1. **Base split is ⅓ chat : ⅔ content.** Chat is the docked lane (§3b, px-remembered). The ⅔ content area is where all splitting happens. Chat is never split or replaced by content.
2. **Content splits.** Inside the ⅔ area you can split right (`⌘\`) or down (`⌘⇧\`), up to 3 content groups. Each group has its own compact tab strip (h32, file icon + name + close-on-hover; the active tab gets a 2px `--text-1` underline, not a filled box). The focused group's strip is `--text-1`, while unfocused strips dim to `--text-3`.
3. **Drag-to-split drop zones.** While dragging a tab, the target group shows a 5-zone overlay (left/right/top/bottom/center), filled `--accent-soft` with a 1px `--accent` outline on the hovered zone and a label ("Split right"). This is the one place the accent is allowed beyond the CTA.
4. **Resize gutters** are 1px `--border` lines with an invisible 8px hit area that turns `--border-strong` on hover. Double-click resets to an even split. Below the 240px floor, a group collapses to its tab strip instead of squashing.
5. **Mixed content.** Any group can hold a file, Changes diff, Terminal or Browser. Typical layouts: file | file (compare), file / terminal (stacked), file | browser preview (front-end loop).
6. **Breadcrumb** under each strip (h24, 11px mono, `--text-3`): `packages › ui › src › composites › session-row.tsx`, with the agent-edit marker `● 2 agent edits` on the right.

Artboards: **04h · ⅓ chat + ⅔ file** (single file with agent diff decorations), **04i · ⅓ chat + file | file** (two side-by-side groups), **04j · ⅓ chat + file / terminal** (stacked), **04k · Drag-to-split** (tab mid-drag with the 5-zone overlay on the right group).

## 3e. File tree (repo explorer)

**Today:** the sidebar already has a `Sessions | Explorer` toggle (`app/session-sidebar.tsx:833-855`, `workspaceView`). It's a 2-col grid at 11.5px semibold, and Explorer swaps the whole session list for `renderExplorer` (`jingler-app.tsx:376`). The Changes rail button is an *action*, not a view: it switches to Explorer filtered to uncommitted/PR files (`tab-contributions.ts:387`, `jingler-app.tsx:301`). There's also a separate `files` tab (`tab-contributions.ts:224`), so files live in two places. Problems: the toggle reads as low-contrast pills, the Explorer has no header (which branch? which filter?), and the "filtered to changes" state is invisible once you're in it.

**Improved:** keep the sidebar toggle, make it the *only* home for the tree (drop the `files` tab; `⌘P` covers quick-open), and make the Changes filter visible.
1. **Sidebar mode toggle.** Keep `Sessions | Explorer` (rename stays). Restyle as the shared segmented control: h28, 12px/500, active `--bg-active` + `--text-1`, inactive `--text-3`. `⌘⇧E` toggles. The project rail stays visible either way, so total chrome is still 56 + 248.
1b. **Filter chips under the header:** `All · Changed 12 · PR #482`. The header `Changes 12` launcher button (§3c) switches the sidebar to Explorer with `Changed` selected *and* opens the diff in the content area. The active chip is what tells you you're filtered.
2. **Explorer mode** shows the active workspace's worktree:
   - Header: branch `⎇ morgan/pr-inbox-pagination` (mono 11) and a filter input "Filter files…" (`⌘P` still opens fuzzy quick-open).
   - Tree rows h26, 12px, 14px file icons, 12px indent guides in `--border`.
   - Git status letter on the right (`M` amber, `A` green, `D` red, `U` grey). The parent folders of changed files get a dot.
   - Agent-edited files get a small blue `●` and the filename in `--text-1`. The file the agent is editing right now pulses.
   - Toolbar icons: Collapse all, "Changed only" filter, and Follow agent (shared with the chat lane toggle, §3b).
3. **Behaviour.** Click opens the file in the focused content group (⅔ area, §3d). `⌘`-click opens it in a new split. Dragging a row onto a group uses the drop zones from §3d. Dragging it onto the composer adds it as a context chip.
4. **Back to workspaces.** Clicking a workspace in the rail tile's menu, or pressing `⌘⇧E` again, returns to Sessions mode. The mode is remembered per project.

Artboard: **04l · File tree**. This is the 04i layout (⅓ chat + file | file) with the sidebar in Explorer mode and `packages/ui/src/composites/` expanded, showing `session-row.tsx M ●` (selected), `session-hover-card.tsx M`, `pr-glyph.tsx A`, with "Changed only" off.

## 3e2. Chat timeline (keep it)

**Today:** `app/conversation-view.tsx:591-696` renders a `PreviewRail` (`navigation="rail"`) on the transcript's right edge. It shows one tick per user turn, the turn in view gets a longer bright tick (`activeRailIdFor`, line 123), and hovering a tick shows a card with the prompt and the start of the reply (`createMessageRailPreview`). Clicking jumps to that turn. Keep all of this.

**Improved:** same behaviour, a few additions:
1. **Placement.** The rail sits in the chat lane's right gutter (12px from the edge) in every mode: Full, Docked, Focus and the narrow drawer. In Docked mode it stays inside the lane, never on the drag handle.
2. **Ticks.** Rest ticks are 8px `--text-3`, hover ticks 12px `--text-2`, and the active tick is 16px `--text-1`. Ticks carry state: amber for a turn that needed you (approval/question), red for a turn that failed, and a small dot for a turn with a checkpoint.
3. **Preview card.** Radius 12, `--bg-elevated`, shadow per §2, max-w 360. Title is the prompt (13/500 `--text-1`), body is two lines of the reply (13 `--text-2`), and the footer shows `Turn 3 · 4 files · +84 −12` in 11px mono.
4. **Turn actions in the card:** `Jump` (default on click), `Filter Changes to this turn` (links to §3c/§3d per-turn diff), and `Revert to here` (checkpoint, R11).
5. **Keyboard.** `⌥↑` / `⌥↓` move between turns and light the tick.

Shown on boards 04b, 04c, 04e and 04h (rail visible), with the hover card open on 04b.

## 3f. PR stacks (several PRs per session)

**Today:** a session holds one `prNumber` (`packages/core/src/domain.ts:553`, `:622`), so a session that opens a stack (`#480 → #481 → #482`) only shows one PR. To ship this, the model has to change to an ordered `prs: [{ number, branch, base, state, checks }]`.

**Improved:** the stack is visible wherever the single PR is today.
1. **Sidebar row.** The line-2 PR glyph turns into a stack glyph with a count (`⑂ 3`). The colour comes from the worst state in the stack: failed checks red, review pending amber, all green green. Hovering shows a mini list.
2. **Header PR chip → stack switcher.** `PR #482 ▾  2/3` sits next to the branch. The menu lists the stack from the base up, showing number, title, branch (mono), a state pill (Draft / Open / Approved / Merged / Closed) and a checks dot. The current PR is marked, and merged PRs are dimmed with a ✓. `⌥[` / `⌥]` move down/up the stack.
3. **Checks tab.** A vertical stack rail on the left (h36 rows connected by a 1px `--border` line, like Graphite) with the selected PR's readiness checklist on the right. Merge order is enforced: \"Merge #480 first\" disables merge on the upper PRs, and a \"Merge stack\" CTA appears once everything is green.
4. **Changes tab.** The turn filter gets a sibling filter, `PR: #481 ▾ · All`. It scopes the diff to one PR's commits, so you review a stack layer by layer.
5. **Transcript.** When the agent opens a PR it posts a compact card, `Opened #481 · stacked on #480`, and the card links into the switcher.

Artboard: **04m · PR stack**. This is the Checks tab with the stack rail (#480 Merged, #481 Approved, #482 Open with 1 failing check, selected), the header switcher menu open, and the sidebar row showing `⑂ 3` in red.

## 5. Full-app screens (beyond the workspace shell)

### 5a. Login (`screens/login-screen.tsx`, `auth-machine.ts`)
- Centred 360px column on `--bg-app`, no card border. Order: Jingler mark (28px), "Sign in to Jingler" (20/600), "Run and manage your agent sessions." (13 `--text-2`).
- Buttons, h36 r8, full width: **Continue with GitHub** (primary, the screen's one accent), **Continue with Linear** (secondary). Then a divider "or", an email input, and "Send magic link".
- Every auth-machine state gets a visible variant on the board: `sending` (spinner in the button), `magicLinkSent` ("Check morgan@… — link expires in 15 min" + Resend + Use a different email), `oauthPending` ("Finish in your browser…" + Cancel), `error` (an inline red line under the input with **Retry**; today the only way out is RESET).
- Footer at h40, 11px `--text-3`: version · Terms · Privacy.

### 5b. Onboarding (`screens/setup-screen.tsx`, `app-machine.ts` setup.*)
Today the label says "1 of 2 / 2 of 2", but the machine runs workspace → github → provider → resources (P13). Improved: **3 honest steps plus an optional finish**, with a real stepper at the top (dots + labels, done ✓ / current ● / upcoming ○).
1. **Projects folder.** "Where do your repos live?" A folder field (mono path) + Browse. Below it, a live "Found 9 repositories" list (first 5 rows: repo icon, name, branch) with checkboxes, all ticked. CTA "Add 9 projects".
2. **GitHub.** A benefit list (PR stacks, checks, review comments) with 3 icon rows. "Connect GitHub" primary, "Skip for now" ghost. Connected state: avatar + `@morganparry` + installations count + Continue.
3. **Agent.** Detected harness cards in one row: Claude Code (Ready ✓, from `~/.claude`), Codex (Sign in), API key (Add). Each card is r12, 180px wide, with a status pill. You need at least one Ready to continue; the CTA explains why it's disabled.
4. **Finish (optional, not counted as a step).** Land on Home with a dismissible card "Import 6 MCP servers and 14 skills from Claude Code" [Import] [Not now]. This replaces the blocking resources step.
Boards: **02a** step 1, **02b** step 2 (exists as 02), **02c** step 3.

### 5c. Home (no workspace selected)
- Rail + sidebar as usual. The main area is centred at max-w 760. Greeting "Good afternoon, Morgan" (20/600), then the big composer "What should we build?" with chips `jingler ▾ · from main ▾ · worktree ▾`.
- Under it: **Needs you (2)** cards (the question inline, with Allow/Answer buttons), **Running (3)** compact rows with live status, and **Recent** (5 rows, time-right).
- The resource-import card from 5b sits here once.
- First-run variant (no workspaces yet): three starter rows: "Start from a GitHub issue", "Start from a PR", "Describe a task".

### 5d. New workspace (`composites/new-workspace-view.tsx`)
Composer-first. The 4 peer pickers (Project/Source/Isolation/Branch) collapse into one chip row under the prompt: `jingler ▾` · `from main ▾` (menu tabs: Branch · Pull request · Issue) · `worktree ▾` (Worktree / This checkout, each with a one-line explainer). Below that, a "Start from" list with Linear + GitHub tabs: issue rows with ID, title, assignee avatar and label. Clicking one fills the prompt and source chip. ⌘↵ creates.

### 5e. Settings (full page; drop `composites/settings-dialog.tsx`)
14 flat items (`settings-view.tsx:107-158`) become **4 groups**. The left nav is 220px, with group labels at 11px uppercase `--text-3`. Items not marked `ready` show a "Soon" pill instead of being hidden.

| Group | Items (source keys) |
|---|---|
| Workspace | General (`general`) · Notifications (split out of general) · Projects (`projects`) · Permissions (`permissions`, Soon) |
| Agents | Providers (`providers`) · Agents & skills (`agents`) · Context & plan (`context` + `plan` merged) · Runtime (`runtime`) |
| Integrations | GitHub (`github`) · MCP servers (`connectors`) · Plugins (`plugins`) · Devices (`devices`) |
| Appearance | Theme (`themes`) · Header views (§3c) · Keybindings (`keybindings`, Soon) |

- **Page anatomy.** Title (20/600) + one-line description, then **cards of rows**: each row has a label (13/500) and help (12 `--text-2`) on the left, and the control on the right (toggle / select / segmented). Cards are r12 with `--border`; rows are separated by a hairline. Max-w 720. A search box at the top of the nav ("Search settings") filters rows across sections.
- **General:** Default mode (segmented Ask · Accept edits · Auto), Font size (segmented S · M · L · XL, mapped to .9/1/1.15/1.3), ADHD mode toggle, Offload compute toggle + status line.
- **Notifications:** master toggle, then Needs input / Run finished / Run failed / PR resolved / Play a sound (copy taken verbatim from `settings-view.tsx:1188-1223`).
- **Providers:** one card per harness: logo, name, status pill (Connected / Sign in / Error + reason), account line, model default select, `⋯` (Reconnect, Remove).
- **GitHub:** a connected-account card, installations list, then a "Pull requests" card with the toggles from `:1441-1530` (Enable PR features, Auto-detect, Auto-create, Auto-review on new commits, Post low-severity findings, Allow shared branches).
- **MCP servers:** table rows with name, transport (stdio/http) mono, a health dot (green/amber/red + "3 tools"), and an enabled toggle. "Add server" + "Import from Claude Code".
- **Theme:** a grid of theme tiles (mini app previews) with Jingler Graphite selected, plus "Import VS Code theme…".
Boards: **09a General**, **09b Providers**, **09c GitHub**, **09d MCP servers**, **09e Theme**.

### 5f. Command palette (`app/command-palette.tsx`)
640px, r12, top 120px, over a 55% scrim. Input h48 with a scope chip on the left when one is active (`> Actions`, `@ Files`, `# Workspaces`). Sections: Workspaces (status dot + status word + repo), Actions (with kbd hints right-aligned), Views ("Open view…" §3c), Files. The footer bar (h32, 11px) shows `↵ open · ⌘↵ open in split · tab scope`.

### 5g. Overlays and small surfaces
- **Add project** (`add-project-dialog.tsx`): a 520px dialog with segmented tabs Local folder · Clone URL · GitHub. The GitHub tab lists repos with search, and already-added repos are greyed out with a ✓.
- **Usage & limits** (`usage-modal.tsx`): per-provider meters (5h window, weekly) with reset times. No invented numbers on the board; use labelled placeholders.
- **Account menu** (rail footer avatar): Settings ⌘, · Usage & limits · What's new (vX.Y.Z) · Sign out. An update-available row pins to the top with a "Restart to update" button.
- **Toasts:** bottom-right, r8, max 3 stacked. Variants: success, error with Retry, and "Needs you" with Jump.
- **Archived workspaces:** the sidebar footer link "Archived (14)" opens a list with Restore.

### 5i. Provider connections: subscription OAuth, device code, API key
Code today: `screens/setup/provider-setup-step.tsx` ("Welcome · 3 of 4"), `composites/provider-auth-forms.tsx`, `composites/native-endpoint-login.tsx` (+ machine), `provider-connections-settings.tsx`. Supported routes:
- **Subscription OAuth** (Claude Pro/Max, ChatGPT/Codex). Opens the browser and shows "Waiting for browser…" with Cancel. **A subscription connection never falls back to an API key** (copy from line ~115). Keep that line visible.
- **Device code** (`loginEvent.type === "device-code"`). The code shows big (20px mono, letter-spaced) with Copy, "Enter this device code in the opened browser", Reopen browser, and a countdown.
- **API key.** A provider select (Anthropic / OpenAI / Google / OpenRouter API), a masked key input with show/hide, and Test & save. The states are `Saving API key…` → Verified ✓ / Invalid key (inline red, keep the input).
- **Entitlement unconfirmed** (`entitlement-unconfirmed`, `entitlementIssueLabel`). An amber card says the account signed in but the plan couldn't be confirmed, with Retry check · Use another account.
- **Native endpoints** (per device). Codex shows a native login; OpenCode shows "Run `opencode auth login` on this device, then refresh runtimes" with a copy button + Refresh. Unsupported shows "Install the supported OpenCode version".
- **Multiple accounts.** "Add another account" adds a row per account, the default gets a star, and `⋯` has Make default / Sign out.

Improved: one **Connect sheet** (a 480px right-side sheet over Onboarding step 3 or Settings → Providers) with segmented `Subscription · API key`. The sheet body walks the states in place, so there are no modal swaps. The harness card shows its live status pill (Ready / Signing in… / Needs attention / Signed out).
Boards: **15a Connect · subscription OAuth waiting**, **15b Connect · device code**, **15c Connect · API key (invalid → verified, side by side)**, **15d Providers · multi-account + entitlement warning + OpenCode native hint**.

### 5j. MCP servers and skills import
Code today: two separate flows. Onboarding step 4, `screens/setup/resource-setup-step.tsx` ("Import agent resources"), has a search ("Search skills and prompts"), a checklist where each row shows `kind · sourcePath` (mono 10px), Import selected / Import all, Detecting resources… / "No importable resources were detected." / "N malformed or unsupported resources were skipped." On top of that, `apps/desktop/src/renderer/mcp-import-prompt.tsx` is a one-time dialog, "Import MCP servers", which loads every source and stores `jingler:mcp-import-prompt:v1`. So two prompts ask about overlapping things.

Improved: **one Import flow** with a single entry point (the Home card from §5b, Settings → MCP servers "Import", Settings → Agents & skills "Import").
1. **Sources step.** Detected sources show as cards: Claude Code (`~/.claude`), Codex (`~/.codex`), Cursor, project `.mcp.json`. Each gives counts by kind (MCP servers · skills · prompts · agents), and undetected ones are greyed out with "Not found".
2. **Review step.** Tabs per kind with counts. Rows have a checkbox, name, source chip, mono path, and a **conflict badge** when a same-name item already exists (Keep mine / Replace / Keep both). MCP rows also show transport (stdio/http) and **needs secrets** (amber key icon, e.g. `GITHUB_TOKEN`), which opens inline env inputs. Skipped/malformed items collapse into a group at the bottom with the reason.
3. **Result step.** "Imported 6 servers, 14 skills" plus a per-server **health check**: green "12 tools", amber "Needs auth · Connect" (OAuth MCP), red "Failed to start · View log". Each has Retry.
Boards: **16a Import · sources**, **16b Import · review (MCP tab, conflict + needs-secret rows)**, **16c Import · result with health**, **16d MCP server detail** (Settings: transport, command, env vars masked, tools list with toggles, OAuth status, logs tail).

### 5k. Plan, explanation and agent interaction surfaces
Code today:
- `composites/plan-card.tsx`: an in-transcript "Plan Overview" card with Approved / Rejected / Stale badges, Download plan, Expand, a "To-dos" list, and "View Plan".
- `screens/plan-review.tsx`: the full plan doc with a sticky "Contents" nav (w-52, ✓ on done sections), select-to-comment (`plan-comment-layer`, "Save comment"), stage cards (`plan-stage-card`: user story "I want … so that …"), `plan-step-list`, "General feedback (optional)", Approve / Request changes.
- `composites/plan-progress-dock.tsx`: "Plan tasks" docked above the composer while the plan executes.
- `screens/explanation-view.tsx`: an article max-w 760, markdown + mermaid + tables, with Loading / error+Retry / "No explanation yet." states.
- `composites/question-card.tsx`: "Agent needs your input", keyed options (1–9) plus O for "Other" with "Type a custom answer…".
- `composites/approval-gate.tsx`: tool approval.

Improved:
1. **Plan review keeps today's layout exactly** (`screens/plan-review.tsx:254-356`); only the styling changes to Graphite tokens. It opens as a content tab (⅔ area, chat stays ⅓), bg `--bg-surface`, and scrolls as one document:
   - Centred wrapper max-w 1120, 40px gap, padding 32/40.
   - **Contents nav** on the left (208px, sticky, hidden below 1000px container width): mono 11px uppercase "Contents" label, then rows at 13px. Section rows have no number; stage rows show a mono number, or a green ✓ when the stage is done. The row in view gets `--bg-active` + `--text-1`.
   - **Article** max-w 760. Header: mono 12px uppercase eyebrow `Plan · revision 3 · pending`, the plan title as the doc h1 (20/600), `4 stages · 9 files touched` (13 `--text-2`), and the secondary button `Changes since revision 2` (expands an inline revision diff). Hairline under the header.
   - Then the plan **sections** (h2 + visual blocks: prose, tables, mermaid, code), then the numbered **stage cards** (`PlanStageCard`: user story, files, steps, per-stage comment button).
   - **Comments:** select text → floating `Add comment` pill → a 320px draft popover (textarea, `Cancel` / `Save comment`). Saved threads sit in the right margin via the comment layer, with reply and resolve.
   - **Footer decision bar** pinned to the bottom of the tab (unchanged position): a one-line `General feedback (optional)` textarea, then `Request changes` (danger) and `Approve` (primary). The decision error line shows above it in red.
2. Styling-only changes: hairlines become `--border`, the footer becomes `--bg-elevated` with r8 inputs, the danger button uses `--state-failed` text on a transparent fill (so `Approve` is the screen's one accent), stage cards get r12 + `--border`, and the eyebrow and contents labels move from 10–11.5px to the 11/12/13 scale.
3. **Not changed:** no header decision bar, no "Send comments to agent" batch button, no pulsing current-step state in the contents nav during review. Those were in the earlier draft of this spec and are dropped.
4. **Plan card in chat** shrinks to one row once approved (`Plan · 3/7 steps · View`), and expands on click. The progress dock above the composer becomes a 32px strip with a step ticker that you can expand to the task list.
5. **Explanation** opens as a content tab with the same article width, a TOC rail and a "Mermaid · Table · Code" block style. The transcript shows an "Explanation ready · Open" card. Loading uses a skeleton of headings, not a centred word.
6. **Question card** keeps the keyboard options (1–9, O) and shows them as a row-list with kbd chips. A selected option gets `--bg-active`. It also posts a Needs-you tick to the timeline and the rail badge.
7. **Approval gate**: "Run `pnpm test`?" with the command in mono, cwd, and `Allow once` (primary) · `Always for this command` · `Deny`. It also offers "Switch session to Auto" as a tertiary link.
Boards: **17a Plan review (comments + contents + decision bar)**, **17b Plan executing (collapsed card, progress strip, contents with current step)**, **17c Explanation tab**, **17d Agent asks (question card + approval gate stacked in the transcript)**.

### 5l. Usage & analytics
Code today: `composites/usage-modal.tsx` ("Usage & limits" dialog). Per provider it shows `WindowRow`s (label, reset time, a 6px bar tinted blue/yellow/red by `UsageStatus`, % used) and an "Execution report" with one line per group: `N runs · X% ok · T tokens · K tools · $cost | cost partial`, plus Export JSON. The data model `UsageReportGroup` (`packages/core/src/runtime/usage-facts.ts:69`) already holds, per runtime + provider + model + parent/child: runCount, successRate, durationMs, input/output/cacheRead/cacheWrite/reasoning tokens, toolCalls, knownCostUsd, costCoverage. The modal crams all of it into one text line.

Improved: keep a **compact popover** (from the account menu or the rail usage ring) for limits only, and add **Settings → Usage** (Workspace group) as the full analytics page.
1. **Limits card** (top). One row per provider/account: auth route chip (Subscription / API key), each window as a bar with "Resets in 2h 14m" and % used. Nearing = amber, limited = red with "Limited until 16:40". "Updated 3 min ago" + Refresh.
2. **Range + filters bar**: `24h · 7d · 30d` segmented, Runtime ▾, Project ▾, `Parent · Child · All` (subagents), Export JSON / CSV.
3. **KPI strip** (4 tiles): Runs, Success rate, Tokens, Known cost. Cost shows a coverage note when `costCoverage < 1` ("cost known for 82% of runs"). Never present partial cost as a total.
4. **Model performance table** (the core). One row per model: model + runtime chip, runs, success % (bar), median duration, tokens (stacked mini-bar input/output/cache/reasoning), cache hit %, tools/run, cost/run, cost coverage dot. Sortable; click a row to open a detail drawer.
5. **Charts**: tokens over time stacked by model (area), runs by outcome (bar: ok / failed / cancelled), and cost by project. All charts use state/neutral colours, no rainbow; model colours come from a fixed 6-step neutral-to-blue ramp.
6. **Model detail drawer** (480px): trend sparklines, parent vs child split, top projects, slowest runs list with links to the session turn.
7. **Empty / partial**: "No completed parent or child runs recorded." (verbatim) with a one-line hint; providers that don't report usage show "Usage not reported by this provider".
Board values must be labelled placeholders, not invented metrics.
Boards: **18a Usage popover (limits)**, **18b Settings · Usage (KPIs + model table + charts)**, **18c Model detail drawer**.

### 5h. States (board 12)
Every list follows the same three-state rule: **skeleton** (rows at `--bg-elevated` shimmer, matching real row heights), **empty** (one line + one CTA), **error** (inline red line + Retry, never a toast alone). The board shows: sidebar skeleton, empty project, PR list error, provider disconnected banner (amber, in the composer: "Claude Code signed out · Reconnect"), and offline (top hairline banner "Offline — agents keep running locally").

## 6. Operator feedback, round 1 (Paper comments)

These override anything earlier in this spec.
1. **No Keep / Revert on hunks.** Agent changes are kept by default. Remove per-hunk Keep/Revert everywhere (04c, 04g, 04h, 05, 00, and so on). Agent edits still show as inline diff decorations, labelled `Agent edit · Turn 3`. Checkpoint "Revert to here" on a turn (timeline card, 22d) stays, because it's a different feature.
2. **Review findings are dismissable and don't look like AI.** No sparkle icons, no gradient or "AI" stripe. Use a plain comment-style row: severity as a small text label (`Major` in `--text-2`), the message, and `Ask agent to fix` and `Dismiss` (× icon) on the right.
3. **No traffic-light colour lists.** Status lists (MCP health, import result, checks, usage limits) are monochrome: a neutral icon + `--text-2` text per row. Only a failure or blocking state gets colour (`--state-failed` icon only, never a coloured row). Green ✓ rows become neutral ✓. Sidebar workspace state dots are unchanged.
4. **Badges and pills are always one line.** `white-space: nowrap; flex-shrink: 0` on every badge, pill, chip and kbd. Truncate the neighbouring text instead.
5. **Real provider logos.** Claude/Anthropic and Codex/OpenAI use the paths in `packages/ui/src/components/provider-icon.tsx` (each has its own viewBox). No letter tiles for providers that have an icon there.
6. **OAuth MCP servers in import.** Review rows can be `Needs sign-in` (OAuth): the row shows the server's auth URL host and `Sign in after import`. The result step shows `Connect` (opens the OAuth flow) and the server detail shows `OAuth · Signed in as … · Sign out` or `Not signed in · Connect`.
7. **Agents & skills lists are searchable** (there can be hundreds): a search input + kind filter (`All · Agents · Skills`) + source filter, with virtualised lists and counts.
8. **Plannotator is our own plugin.** No API key or secret field. Show its real settings from code.
9. **Browser preview toolbar uses an icon button group** (back · forward · reload · open external in one segmented group, device widths as a second icon group), not loose buttons.

10. **Primary buttons are neutral, never rose or red.** Red reads as destructive. Primary = `--text-1` fill (`#ededef`), `--bg-app` text (`#0b0b0c`), hover `#ffffff`, disabled `#26262b` fill + `--text-3` text. Secondary = transparent + 1px `--border-strong` + `--text-1`. Rose `#ef3f57` is now **brand-only**: the Jingler mark, focus ring, text selection, and the drag-to-split drop zone. Destructive actions (Delete, Request changes, Revert workspace) use `--state-failed` text on a transparent fill with a `--border-strong` border, plus a solid `#f0605d` fill only inside a confirm dialog's final button. This replaces every earlier "accent once per screen on the CTA" rule.
11. **Agent asks support long commands** (17d, 22d, toasts). A permission or approval card shows the command in a mono block that wraps (`white-space: pre-wrap; word-break: break-all`), is capped at 6 lines with a `Show all · 42 lines` toggle, scrolls inside the card when expanded (max 320px), and has a `Copy` icon button. The approve/deny buttons stay pinned under the block and are never pushed off-screen. A one-line summary (`Run pnpm test --filter …`) is used for notifications and the sidebar.
12. **Plan comments are floating avatars** (17a, 17b). Each comment thread sits in the right margin as a 20px author avatar (agent threads use the mono Jingler mark) aligned to its anchored line, with a count badge when the thread has replies. Hovering or focusing the avatar opens the thread card (the current 320px card) as a popover; clicking pins it open. Overlapping avatars stack with a −6px offset. The highlighted text range stays tinted while its thread is hovered. Keyboard: `Tab` reaches avatars, `Enter` pins, `Esc` closes.
13. **Queued message actions are icon buttons** (22c), matching today's `QueuedMessageRow` (`packages/ui/src/composites/queued-message-row.tsx:8`): send now · hand off · edit · remove as 24px ghost icon buttons with tooltips (`title` is also the accessible name). Hand off keeps today's tooltip, `handoffHint ?? "Hand off — run this in a new chat"`. A row that is `sending` hides its actions.
14. **"Hand off all"** (22c, new): the queue header gets `Hand off all · 3`, which forks every queued message into its own new agent chat on the hand-off target model and clears the queue. It's disabled while a message is `sending`. A toast confirms: `3 messages handed off · View` (View opens the thread switcher). Needs a batch path over the existing per-item `onHandoffQueued` (`conversation-view.tsx:242`, `conversation-pane.tsx:1241`).
15. **Model logos in the model popover** (22b): every model and provider row shows its `ProviderIcon` (`packages/ui/src/components/provider-icon.tsx:85`) at 14px, and so does the composer's model chip. Providers with no icon fall back to a neutral letter tile.
16. **Viewing subagents** (20, 20+). Today: `SubagentTabBar` (`packages/ui/src/app/subagent-tab-bar.tsx:7`) is a 32px "Subagents" chip strip under the chat, a chip opens `FleetAgentView` (`subagent-view.tsx:110`), a read-only child transcript with an `agent · task` header and artifact buttons, finished ones live in a History menu, and `AgentRoster` (`agent-roster.tsx:6`) is a "Peer agents" disclosure with a message box. Redesign keeps that model, restyled:
   - **Entry points:** the lane header chip `2 subagents ▾` opens a popover listing running children (status word, agent, task one line, elapsed) then `Finished · 4` (replaces the History menu). The transcript's subagent tool card has `View`. The sidebar row shows `· 2 agents`. ⌘K → "Go to subagent…".
   - **Viewing replaces the chat in place (operator decision, round 3).** There is no separate fleet view and no "Open beside". Clicking a subagent in the `2 subagents ▾` dropdown swaps the chat lane's transcript for the child's transcript, in the same lane, at the same width, in every chat mode. The lane header turns into a breadcrumb `Fix PR inbox › reviewer` with `← Main` (Esc) and a dropdown to jump to sibling subagents.
   - **Meta strip** (under the breadcrumb, up to 3 rows to fit the ~360px lane: (1) model + `ProviderIcon` · status/phase · elapsed · `Details ▾`, (2) `currentTool` mono · tokens in/out · tool calls · cost · `Background` pill, (3) artifact chips; boards 20 `G8R-0` dropdown, 20a `ODA-0` viewing in place, 20b `P8H-0` states; collapsible to the `Details` disclosure). Every field comes from `SubagentFleetNode` (`packages/core/src/runtime/subagent-fleet.ts:81`): model with its `ProviderIcon` (`model`), status word + phase (`status`, `phase`), current tool in mono (`currentTool`), elapsed since `startedAt`, tokens in/out (`usage.inputTokens/outputTokens`), tool calls (`usage.toolCalls`), cost (`usage.costUsd`, shown only when > 0), `Background` pill when `background`. The task (`task`) is the first line of the transcript, quoted. Artifacts (`artifacts[]`) are one-line chips on the strip's last row that open in the content area.
   - **Composer** becomes a read-only bar: `Subagent of Fix PR inbox · read-only` + `Stop` (destructive text) while running. When `attention` is set, the bar shows its `message` with a `Reply` that targets the child. When `terminal` is set, it shows `terminal.summary` with `Retry` if `terminal.retryable`.
   - **Workflow fleets:** nested children render as an indented tree in the popover (orchestrator → children), each row status word only — no traffic lights; failed rows get the red icon and `View error`.
   - **States:** loading skeleton, `This agent has no transcript (orchestrator)` empty state, error with Retry, stop outcome line (`Stopped by you · 2m 10s`).
   - **Peer agents** (`AgentRoster`) move into the same popover under `Peers · 2`, each with `Message`.
17. **Pull request view** (boards 26a–26c, operator request round 4). Opens as a content tab (`PR #482`) from the header PR chip, the PR inbox (19a), Checks, or ⌘K. Replaces today's `PullRequestView` (`packages/ui/src/composites/pull-request-view.tsx:201`) + `PrSidePanel` (`pr-side-panel.tsx:113`) layout with a GitHub-style reading view, restyled. Every field comes from `PullRequest` (`packages/core/src/domain.ts:1652`):
   - **Header:** `title` + grey `#number`; one line below: state pill (Open / Draft / Merged / Closed, neutral, one line) · `author.login` avatar · `headRefName → baseRefName` in mono with copy · `commits` commits · `changedFiles` files `+additions −deletions` · `createdAt` relative. Actions on the right: `Open on GitHub` (icon), `Open session` (secondary, existing `onOpenSession`), overflow `⋯` with Mark ready / Close PR (destructive) / Copy branch.
   - **Sub-tabs (28px underline):** `Conversation · Commits 4 · Files 12 · Checks 3/4`. Files opens the existing diff (`Github.files`/`Github.diff`) in the Changes renderer filtered to this PR; Checks reuses `PrCheckRow`.
   - **Conversation:** `body` rendered as markdown in a 720px reading column ("No description provided." when null), then the timeline: `PrTimelineItem` rows (commented / approved / changes_requested as a grey verb, never coloured), `reviewThreads` inline with their diff hunk (`PrReviewThreadView`, Reply / Resolve), each with `Send to agent` (existing `onSendEntryToAgent`, shows `Sent`). Sticky review composer at the bottom (existing `PrReviewComposer`: Comment / Approve / Request changes, `routeToAgent` toggle "Also send to agent"). No self-approve when `author.login === viewerLogin`.
   - **Right rail (280px, collapsible below 900px content width):** Reviewers (`reviewers[]` login + state word), Labels (`labels[]`, one-line pills), Checks summary, Linked issue, Stack (if §3f prs[]), and the merge box: method picker + `Merge` primary; when `mergeBlockers` is non-empty, `Merge` is disabled and the blockers list under it; `mergeable = CONFLICTING` shows `Ask agent to resolve` + `Open in Changes` (board 25e); `BEHIND` shows `Update branch`.
   - **States:** loading skeleton, not connected (`connectionMessage` + `Connect GitHub`), no PR yet (`Create PR` / publish progress from `PublishCheckpoint`), error + Retry, `readOnly` (team PRs from the inbox: no merge/review controls, `Start session from this PR`).
18. **Issue view** (boards 26d–26e). Same shell as the PR view, so both feel like one feature. Replaces the `github-issues` plugin's `IssueTab` (`plugins/github-issues/src/ui.tsx:106`) styling; stays plugin-provided (`issueProviderId`, `tab-contributions.ts:146`) so Linear renders through the same component. Fields from `IssueDetail` (`domain.ts:1805`):
   - **Header:** `title` + grey `identifier` (`#128` / `ENG-123`) with the provider logo; one line: state pill (Open / Closed, neutral) · `author` · `updatedAt` relative · comment count. Actions: `Open on GitHub/Linear` (icon), `Start workspace` primary (or `Open workspace` when already linked, F2-03), overflow `⋯` with Close issue (destructive) / Copy link.
   - **Body:** markdown in the 720px reading column ("No description provided." when empty), then `comments[]` as plain comment rows (avatar, login, relative time, body), then a comment composer (`Comment` primary; `Close with comment` secondary).
   - **Right rail (280px):** Assignees (`assignees[]`), Labels (`labels[]` one-line pills), Linked workspace / PR, Provider + repository.
   - **States:** loading skeleton, "No issue is linked to this session." with `Link issue`, couldn't load + mono reason + Retry, closed issue banner (neutral) with `Reopen`.
   - **Data gap:** `IssueDetail` has no milestone, linked PRs or reactions; the rail shows only what exists. **Q:** add `linkedPrs` to `IssueDetail`?

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
| 02a/02c | Onboarding steps 1 and 3 | Per §5b: Projects folder with found-repos list; Agent harness cards |
| 09a–09e | Settings sections | Per §5e: General, Providers, GitHub, MCP servers, Theme |
| 14 | Overlays | Per §5g: Add project dialog, account menu, toasts, usage modal |
| 15a–15d | Provider connections | Per §5i: OAuth waiting, device code, API key (invalid → verified), multi-account + entitlement + OpenCode hint |
| 16a–16d | MCP & skills import | Per §5j: sources, review (conflict + needs-secret), result with health, MCP server detail |
| 17a–17d | Plan & agent surfaces | Per §5k: plan review, plan executing, explanation tab, question card + approval gate |
| 18a–18c | Usage & analytics | Per §5l: limits popover, Settings · Usage (KPIs, model table, charts), model detail drawer |
| 13 | Before → After notes | Table mapping each P1–P16 to the improvement # and the artboard that shows it |
