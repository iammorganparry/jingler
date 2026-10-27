# Hallmark audit — epic/redesign (24 Oct)

`/hallmark audit packages/ui/src` against `epic/redesign` @ `8fdfc8fb` (after #909). This was a static pass only: `sloplint.mjs --genre modern-minimal --scope app`, with no render tier yet. No source files changed.

Raw totals were **106 FAIL · 64 REFLEX · 18 WARN** across 594 files. Many of these are in stories and tests. The triage below separates real product findings from noise.

## Real findings (product code)

| Gate | What | Where | Fix |
|---|---|---|---|
| 67 (Floor 9) | Tracked-caps / uppercase labels at 8–11px (44 hits) | `session-tree.tsx` (3), `plan-review.tsx` (2), `explanation-view.tsx` (2), `question-summary.tsx` (2), `add-project-dialog.tsx` (2), `subagent-chip.tsx` (2), `settings-view.tsx`, `session-row.tsx`, `visual-call-path.tsx` | Sentence case, body face, one step smaller, untracked |
| 54 (Floor 9) | Eyebrow above a heading | `explanation-view.tsx:81` ("Explanation"), `plan-review.tsx:336` ("Plan · revision ·") | Fold it into the heading or the meta line |
| 63 (Floor 10) | Middle-dot meta strings, arrow glued to a label | `mcp-server-detail-dialog.tsx:86`, `provider-connections-settings.tsx:171,173`, `native-endpoint-login.tsx:11`, `review-drawer.tsx:84`, `review-findings.tsx:400`, `review-tray.tsx:108` ("Send to agent →") | Separate with spacing/hairlines; use a verb label with no arrow |
| 10a (Floor 2) | `transition-[width]` on progress bars | `session-sidebar.tsx:250`, `feedback.tsx:75`, `composer.tsx:289`, `usage-panel.tsx:61` | `scaleX` transform plus `origin-left` |
| 48 (Floor 1) | Colour literals | `beui/context-menu.tsx:497`, `beui/popover-morph.tsx:253`, `context-menu.tsx:107`: `drop-shadow(... rgba(0,0,0,…))` | Shadow token (also breaks the AGENTS.md no-hardcoded-colour rule) |
| 33 | `<svg>` with no aria | `async-button.tsx:14` | `aria-hidden` |
| 19 | Em dash in UI copy (18 hits) | Various | Rephrase |
| 49 | Long clickable label without nowrap | `title-search.tsx:33` | `whitespace-nowrap` + truncate |

## Waive (deliberate)

- **30a emoji**: the `pr-review-thread.tsx` reactions are GitHub's own reaction set (content, not icons). `kbd.tsx` `↩` is a key glyph.
- **64 mono labels (51 REFLEX)**: mono is part of Jingler's dev-tool material (paths, IDs, counts). Waive where the text is a path, ID or number. Fix where it is a prose label ("Next milestone", "+ more").
- **20 stamp**: Hallmark's own CSS stamp. Only needed if we adopt Hallmark's system in `globals.css`.

## Noise

Stories and tests: `*.stories.tsx` eyebrows/colours/emoji, `markdown.test.tsx`, `command.stories.tsx`. Story chrome isn't shipped. It can be cleaned in one pass later.

## Not yet run

1. **Render tier** (`--render --url` against Storybook): contrast, focus-visible, 8 control states, spacing. About 30 min.
2. **Paper boards** (file `01M4K9KPAEC70CQCJ6P8MPARJN`, page "02 · Improved"): export each board via the Paper MCP and run the judged gates (`gates.md` §5) on the images. About 45 min.
3. **Inbox redesign** to the reference in `13-hallmark-inbox-reference.md`. This is a full-depth app-screen redesign of `pull-request-inbox.tsx` / `issue-inbox.tsx`. About 1 day, one PR.

## Paper boards (markup gates)

Scope: app, genre modern-minimal. Method: `get_node_info` and `get_jsx` (tailwind) on sub-sections of page "02 · Improved" (`root_node_p-3-0`, 110 children). **Coverage is partial.** Only board `205-0` "04b · Chat full" was read in detail: left rail, sidebar, header, tab bar, transcript and composer. The other boards were identified by name and child IDs only, because `get_jsx` overflowed the output budget on whole boards. The "not read" rows are not clean. They are unaudited. Contrast and visual density need renders.

| Board | Findings (gate) | Severity | Fix |
|---|---|---|---|
| 04b Chat full: sidebar (`2XW-0`) | The status line is "Working · morgan/pr-in…". The dot is a text node (63). The 8px status dots carry a glow `box-shadow` (63, decorative). The dot has a text label next to it, so keep the dot and drop the glow. | Floor | Separate state and branch with a gap, with no `·`. Remove the glow ring. |
| 04b: header (`301-0`) | Chips are `h-6` (24px) and the tab buttons are `h-7` (28px). Both are below the 32–40px app range. | Reflex | Raise to h-8 and keep 44px hit areas. |
| 04b: tab bar (`23L-0`) | Controls are h-7 and the "2 subagents" chip is h-6. It has a decorative blue square, `#5B9CF5`, beside the label. | Reflex | h-8. Use text-only state, or keep the dot only if it encodes state. |
| 04b: composer (`259-0`) | The mode toggle (h-7, bordered) is nested inside the bordered composer card (`#303036` inside `#303036`). This is a card-in-card (4). The controls are h-7, and the send button is a 28px disc with a 34px ring, which is fine. | Reflex | Make the segmented control borderless with a fill (`#26262B`). Raise controls to h-8. |
| 04b: transcript (`243-0`) | The plan card (`#1A1A1D` with border) sits in the message column, so it is not nested. The user bubble is also boxed. No uppercase, eyebrows, emoji or arrows. Diff counts and commands are mono, which is correct. | none | None. |
| 04b: left rail (`2X8-0`) | The "T" and "D" letter tiles stand in for icons. The "D" tile has a blue glow dot. The "J" tile has a 2px indicator bar. | Finish | Use real icons. Drop the glow. |
| 22a, 22b, 22c, 22d Composer boards | Not read. Likely to share the h-7 controls and the nested-card pattern from 04b. | unaudited | Read `EC1-0`, `EJQ-0`, `ERF-0` and `EZ4-0` first. |
| 04c, 04h Chat and file docked | Not read. | unaudited | Read `31J-0` and `4N2-0`. |
| 10 Command palette | Not read. Shortcut hints are the likely 63 risk. | unaudited | Read `95R-0`. |
| 07 Terminal, 21 Browser preview | Not read. | unaudited | Read `IE3-0` and `I1G-0`. |
| 24a Sidebar menus, 20 and 20a Subagents | Not read. | unaudited | Read `IQQ-0`, `GII-0` and `OKV-0`. |
| Plan review, inbox/PR, settings, home | Not located by name in the first 13 of 110 boards. Not read. | unaudited | List the remaining 97 child IDs first (`get_node_info` returned only 100). |

## Recurring findings (04b only; others unverified)

1. **Middle-dot separator in the sidebar status line (63).** The shipped code is already flagged for this, and the board repeats it on every session row.
2. **Controls at 24–28px (h-6 and h-7)** across the header, tab bar and composer. These are below the 32px floor of the app range.
3. **Decorative glows and dots.** There is a `box-shadow` halo on the active session dot and the rail badge.
4. **A bordered control inside a bordered card** in the composer.
5. **Mono is used correctly:** paths, IDs, counts, diffs and shortcuts only. No 64 findings in 04b.
6. **Absent in 04b:** tracked caps (54/67), eyebrows, emoji (30a) and arrows glued to labels.

## Palette versus the `--sb-*` tokens

The board uses cool, near-neutral greys and a blue accent. Shipped `--sb-*` is a warm grey with a red brand. **No board hex matches a token.** Colour restraint holds for neutrals, but the board has no brand colour at all. The send button is `#EDEDEF`, not `--sb-brand`.

| Board hex | Role | Nearest token | Status |
|---|---|---|---|
| `#0B0B0C`, `#0F0F10` | rail and sidebar | `--sb-canvas #141414` | no match, unmapped |
| `#131315`, `#1A1A1D`, `#26262B` | surface steps | `--sb-panel`, `--sb-surface` | no match |
| `#232327`, `#303036` | hairlines | `--sb-line`, `--sb-line-strong` | no match |
| `#EDEDEF`, `#A1A1AA`, `#7C7C86` | text tiers | `--sb-text-bright`, `--sb-text`, `--sb-muted` | no match |
| `#5B9CF5` | working / selected | `--sb-blue #6faef6` | no match |
| `#4FBF7F` | ready | `--sb-green #70d294` | no match |
| `#F0605D` | failed | `--sb-red #ee8372` | no match |
| `#E5A83B` | needs you | `--sb-yellow`, `--sb-orange` | no match |
| `#6FD39A`, `#F08A87` | diff text | `--sb-diff-add-fg`, `--sb-diff-del-fg` | no match; these are far brighter |

Four status hues plus blue selection is acceptable if they encode state only. Confirm in renders.

## Conflicts with the shipped-code findings above

- **67/54 (tracked caps, eyebrows):** The board is clean, so the code findings are code-only. Fix the code to match the board.
- **63 (middle-dot):** The board has the middle dot in the sidebar that the code fix removes. The board is wrong here and needs updating first.
- **Brand colour:** The board has no `--sb-brand` and uses blue `#5B9CF5` for the active state. The code uses a red brand (`#ef3f57`). A design decision is needed on which one wins.
- **Control heights:** The board says h-6 and h-7. The code audit has not yet measured heights. Check both in renders.
- **64 (mono):** The board agrees with the waiver (paths, IDs and counts only).
