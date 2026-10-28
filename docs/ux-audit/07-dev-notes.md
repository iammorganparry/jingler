# Developer notes per board

One section per board on page `02 · Improved`. Paper cannot create comments, so these notes are the canvas annotations. Companion docs: `03-redesign-spec.md` (what), `04-coverage-matrix.md` (code to board), `06-flow-gaps.md` (gap ids `F<flow>-<n>`).

Legend: **Reuse** existing code to restyle · **New** component (atom / molecule / organism) · **Machine** XState (AGENTS.md: 3+ coupled pieces of state) · **RPC** in `packages/contracts/src/index.ts` · **Data** model change · **Tokens** `--sb-*` (never hardcode colours; defined in `packages/ui/src/globals.css:82-175`) · **Keys** · **E2E** Playwright spec in `apps/desktop/e2e/` · **Q:** open question.

## Global rules (apply to every board)

- **Tokens.** Graphite maps onto the existing `--sb-*` set: `bg-app`→`--sb-canvas` (`globals.css:82`), `bg-sidebar`→`--sb-sunken`, `bg-surface`→`--sb-panel`/`--sb-editor`, `bg-elevated`→`--sb-surface`, text 1-3→`--sb-text-bright`/`--sb-muted`/`--sb-dim`. Add: `--sb-primary-fill`, `--sb-primary-fg`, `--sb-primary-hover`, `--sb-primary-disabled` (neutral CTA, §6.10), `--sb-state-working/needs/ready/failed` (alias `--sb-blue/yellow/green/red`), `--sb-border` becomes lighter than the surface (today `#0f0f0f`, `globals.css:87`). **Q:** keep `--sb-brand` (`:137`) for mark, focus ring, selection and drop zone only.
- **Primary button is neutral.** Today `primary` is `bg-brand text-white` (`components/button.tsx:12`) and `danger` is outline red (`:14`). Change `primary` to the `--sb-primary-*` tokens. Also change every call site that relies on a brand-fill CTA. Add `whitespace-nowrap shrink-0` to `Badge` (`components/badge.tsx:38`), `Pill` (`components/pill.tsx:35`) and `Kbd` (`components/kbd.tsx:16`); `Button` already has it (`button.tsx:8`).
- **Type scale 11/12/13/15/20 and radii 6/8/12.** Replace arbitrary `text-[8.5px..11.5px]` values when a file is touched; do not do a repo-wide sweep.
- **Status lists are neutral** (§6.3). `Callout tone` (`components/callout.tsx:41`), `bg-green/10 text-green` pills (`settings-view.tsx:566-572`) and `StatusDot` (`components/status-dot.tsx:24`) keep colour only for failure or the sidebar workspace dot.
- **New shared molecules** (build once, used by many boards): `Toast` + `ToastRegion` (none today, F4-07), `StatusRow` (neutral icon + `--sb-muted` text, red icon on failure), `InlineError` (message + Retry; used by §5h states), `ListSkeleton`, `EmptyState`, `IconButtonGroup` (extend `components/button-group.tsx:21`), `SegmentedControl` (exists, `components/segmented-control.tsx:11`), `KbdChip`.
- **E2E rule.** New feature = new Playwright spec. Specs below say *new* or *extend*. Fakes already exist: `fake-auth.ts`, `fake-github.ts`, `fake-github-relay.ts`, `fake-linear.ts`, `fake-device-relay.ts`, `fake-ssh-host.ts`.

---

## 00 · Design system
- **Reuse:** `components/button.tsx:12` (variants), `components/badge.tsx:5`, `components/pill.tsx:26`, `components/segmented-control.tsx:4`, `components/kbd.tsx:16`, `brand/jingler-mark.tsx:28` (`JinglerWordmark` lockup).
- **New (atoms):** `Toast`, `StatusRow`, `IconButtonGroup`. **Molecules:** `ListSkeleton`, `EmptyState`, `InlineError`, `SettingsCard`/`SettingsRow` (label + help left, control right).
- **Tokens:** list in Global rules. Add to `globals.css` for both bundled dark themes and `jingler-light`; imported VS Code themes derive them through the `brand` chain in `map.ts` (comment at `globals.css:125-137`), so add derivations there too.
- **Q:** "Jingler Graphite" replaces the default theme (`globals.css:76-82`) or ships as an additional theme next to Jingler Dark? Affects `themes-settings.tsx:86` and `lib/theme` defaults.
- **E2E:** extend `branding.spec.ts` (mark/lockup render) and `text-size.spec.ts` (scale still maps to font-size setting).

## 01 · Login
- **Reuse:** `screens/login-screen.tsx:51` (`LoginState = default|loading|sent|error`, `:10`), `composites/auth-card.tsx:27`, `composites/magic-link-form.tsx:38`, `components/oauth-button.tsx`, `components/auth-divider.tsx`.
- **Machine:** extend `auth-machine.ts` (`checking :74`, `magicLinkSent :122`, `oauthPending :130`, `error :145`): add `CANCEL` from `oauthPending`, `RETRY` from `error`, `RESEND` with a 30 s cooldown, store `lastAttempt` (F1-01..03). `LoginState` needs a fifth value `waiting` so the board's "Finish in your browser" variant maps to a prop.
- **Handle the deep-link error:** `deep-link.ts:45` returns `error`, `App.tsx:2073` only reacts to `ok` (F1-04).
- **Offline boot:** `checking` onError goes to `signedOut` (`auth-machine.ts:85`); distinguish "unreachable" from "no session" (F1-05).
- **Q:** is the wall mandatory? `App.tsx:2116` and `sign-in-dialog.tsx:14` say the app runs signed out (F1-15).
- **Tokens:** neutral primary; brand mark is the only rose element.
- **E2E:** extend `auth.spec.ts` (cancel, retry, resend, denied callback).

## 02a · Onboarding · Folder
- **Reuse:** `screens/setup-screen.tsx:72` (step 1 at `:104`), `RepositorySummary :260`. Drop the "1 of 2" eyebrows (`:104`, `:143`) for a real 3-step stepper (**New molecule** `Stepper`).
- **Machine:** `app-machine.ts` `setup.workspace` (`:326`, `choosing :338`). `choosing.onError` jumps to `#app.failure` (`:353`): change to stay on step with an `error` and re-enter `idle` (F1-06). Add checkbox selection to context (`repos` now has no selection) and an "Add N projects" event.
- **RPC:** `Setup.chooseReposDir`, `Projects.register` (`:492`).
- **Empty:** zero repos copy and "Clone a repository" link (F1-07) reusing `add-project-dialog.tsx:297`.
- **E2E:** extend `projects-and-workspaces.spec.ts`; new `onboarding.spec.ts` for the stepper and error recovery.

## 02b · Onboarding · GitHub
- **Reuse:** `setup-screen.tsx:143-190`, `use-github-connection.ts`, `github-connection-machine.ts` (`loading`, `error` from `:183`).
- **Gap:** error is a red `Callout` with no action (`setup-screen.tsx:172`, F1-09): add Try again + Skip. Connected state shows avatar, `@login`, installation count.
- **RPC:** `GitHub.status` (`:1341`), `GitHub.install` (`:1353`).
- **E2E:** extend `github-onboarding.spec.ts`.

## 02c · Onboarding · Agent
- **Reuse:** `screens/setup/provider-setup-step.tsx:21`, `composites/provider-auth-forms.tsx:9`, `native-endpoint-login.tsx:6`, `components/provider-icon.tsx:62` (real logos, §6.5).
- **Machine:** `setup.provider` (`app-machine.ts:368`): `refreshing`, `loadFailed :398`, `completionFailed :451`, `authFailed :509`, `CANCEL_AUTH :500`. Draw each (F1-10). CTA guard is at `:403-412`: surface the reason text.
- **New:** `HarnessCard` (organism) with live status pill (Ready / Signing in… / Needs attention / Signed out).
- **RPC:** `Provider.list`, `Provider.loginEvents` (`:318`), `AgentEndpoint.list`, `Config.completeProviderSetup`.
- **E2E:** extend `provider-onboarding.spec.ts`.

## 03 · Home
- **Reuse:** `screens/empty-conversation.tsx:11`, `session-sidebar.tsx:1160`, `new-workspace-view.tsx:491` (share the composer).
- **New:** `NeedsYouCard` (question inline, Allow/Answer), `RunningRow`, `ImportCard` (dismissible).
- **Data:** "Needs you" derives from `SessionActivity` kinds `needs-input`/`needs-approval` (`domain.ts:261`; notifier treats both as blocked, `notifier.ts:72`).
- **Import card states:** detecting, found, failed, dismissed (F1-11). Replace the one-time flag `jingler:mcp-import-prompt:v1` (`mcp-import-prompt.tsx:20`) with a persisted dismissal that Settings → MCP servers can bring back.
- **Q:** stale question card behaviour (F4-05).
- **E2E:** new `home-needs-you.spec.ts`; extend `mcp-import-dialog.spec.ts`.

## 3.7 · Project rail

**Merged in #592.** Paper parity check completed in #600.

- **Reuse:** `app/project-sidebar.tsx:81` (`ProjectAvatar :12`, `ProjectSidebar :81`). 56 px rail, 36 px buttons, 8 px radius.
- **States:** active (surface bg, bright left bar), inactive (editor bg, hairline border), hover, loading skeleton, unavailable dot.
- **Hover card:** project name, path, session count, active session count.
- **Badges:** session count (16 px pill, 10 px semibold, `bg-line-strong`), active dot (8 px pulse, `bg-state-working`), unavailable dot (8 px `bg-state-needs`).
- **Tokens:** `bg-canvas`, `border-hairline`, `bg-surface` (active), `bg-editor` (inactive), `text-text-bright` (active bar, badge text), `bg-line-strong` (badge bg), neutral states (spec §6.10).
- **E2E:** `apps/desktop/e2e/project-sidebar.spec.ts` (6 assertions).

### Paper parity (node CD8-0, board 02 · Improved, read via Paper `get_jsx`)

| Property | Story (project-sidebar.tsx) | Paper (CD8-0) | Match |
|---|---|---|---|
| Rail width | `w-14` (56px) | 56px | yes |
| Rail background | `bg-canvas` (#0b0b0c) | #0B0B0C | yes |
| Rail border | `border-hairline` (`--sb-border` #232327) | #232327 | yes |
| Rail padding | `py-2` (8px vertical) | 8px | yes |
| Project button size | `size-9` (36px) | 36px | yes |
| Project button radius | `rounded-[8px]` | 8px | yes |
| Button bg (inactive) | `bg-editor` (#1a1a1d) | #1A1A1D | yes |
| Button border (inactive) | `border-hairline` (#232327) | #232327 | yes |
| Button bg (active) | `bg-surface` (#202024) | #26262B | token kept (one step off) |
| Button border (active) | `border-transparent` | none | yes |
| Avatar size / radius | 28px / 6px | 28px / 6px | yes |
| Active left bar | 2px × 20px `bg-text-bright` (#ededef) | 2px × 20px #EDEDEF | yes |
| Badge font | 10px semibold | 11px/14px semibold | no, follow-up |
| Badge colours | `bg-line-strong` (#44444c) / `text-text-bright` | warning fill, #0B0B0C text | spec §6.10 wins (neutral) |
| Add button border | `border-line`, hover `border-line-strong` | dashed #303036 | token kept |

No code changes. One real mismatch: badge font 10px vs Paper 11px (follow-up).

## 04b · Chat full
- **Reuse:** `app/conversation-view.tsx` (rail `PreviewRail :46`, `createMessageRailPreview :45`, `activeRailIdFor :123`, `navigation="rail" :695`), `composites/message-turn.tsx:122`, `composites/composer.tsx:514`, `session-pane.tsx:282`.
- **New:** `ChatLaneHeader` (thread switcher, `+ New chat`, subagent chips, follow toggle). Replaces `chat-tab-bar.tsx:115` inside the lane.
- **Machine:** new `chat-lane-machine.ts` (Full / Docked / Collapsed / Focus / Drawer; events `OPEN_CONTENT`, `CLOSE_CONTENT`, `TOGGLE_COLLAPSE ⌘L`, `TOGGLE_FOCUS ⌘⇧L`, `RESIZE`, `WINDOW_NARROW`). Put next to `editor-layout-machine.ts:17`. Persist px width (like `PLAN_SPLIT_RATIO_KEY`, `conversation-pane.tsx:89`).
- **Timeline ticks:** extend rail tick type with `needs`/`failed`/`checkpoint` states (§3e2).
- **Keys:** `⌘L`, `⌘⇧L`, `⌥↑`/`⌥↓`.
- **E2E:** new `chat-lane.spec.ts` (modes, px width survives resize); extend `chat.spec.ts`.

## 04c · Chat docked + file
- **Reuse:** `app/editor-layout.ts:61` (`CHAT_RATIO 1/3`) to be replaced by px; `editor-groups.tsx`, `split-layout.ts:65` (`MAX_PANES`), `:68` (`MIN_RATIO`).
- **New:** `AgentEditDecoration` in the file view (label `Agent edit · Turn 3`, no Keep/Revert, §6.1). Source of edits: `apps/desktop/src/renderer/agent-file-activity.ts`, `diff-presence.ts`.
- **Composer chip:** selection + `⌘L` adds `FileRangeChip` (reuse `components/file-chip.tsx`).
- **E2E:** extend `file-browser-ide.spec.ts`, `editor-groups.spec.ts`.

## 04d · Chat collapsed
- **New:** `AskPill` ("Ask ⌘L") floating bottom-right of the content area.
- **Machine:** `chat-lane-machine` state `collapsed`. Below 320 px the lane snaps here instead of squashing.
- **Keys:** `⌘L`.
- **E2E:** in `chat-lane.spec.ts`.

## 04e · Chat focus
- **Machine:** `chat-lane-machine` state `focus`; content tabs stay mounted but hidden (keep terminal and browser views alive: `preview-dock-machine.ts:118`, `terminal-dock-view.tsx:26`).
- **Keys:** `⌘⇧L`; double-click the resize handle.
- **E2E:** in `chat-lane.spec.ts`.

## 04f · Narrow window
- **Reuse:** `session-sidebar.tsx:894`/`:914` (collapse to 52 px under 1000 px), `hooks/width-tier.tsx`.
- **New:** `ChatDrawer` (400 px overlay, scrim). Breakpoint 1100 px.
- **Q:** 1000 px sidebar collapse and 1100 px drawer overlap; pick one cascade order.
- **E2E:** extend `responsive.spec.ts`.

## 04g · View launcher
- **Reuse:** `tab-contributions.ts:56` (`BUILTIN_TAB`), `:219` (`BUILTIN_TAB_META`). Remove `view-rail.tsx:76` and its tests.
- **New:** `HeaderViewButtons` (up to 5 pinned, badge counts at 11 px) + `ViewOverflowMenu` (Views, Plugins, "Pin to header").
- **Machine:** none. Pinned set is a preference; **RPC missing**: `Config.setHeaderViews` (follow `Config.setStarredRepos :1558`; or localStorage). **Q:** per-user config vs local storage.
- **Merges:** Code Review → Changes, PR → Checks, Workflow → Checks section, Conversation has no button. Remove `review`, `pr`, `workflow` from the visible set but keep their contributions for deep links.
- **Keys:** `⌘⇧D` Changes, `⌘⇧P` Checks, `` ⌃` `` Terminal (`app-shortcuts.ts:13`), `⌘⇧B` Browser, `⌘P` quick-open, `⌥1-9`.
- **E2E:** new `view-launcher.spec.ts`; update every spec that clicks the right rail (search `view-rail` testids).

## 04h · ⅓ chat + ⅔ file
- **Reuse:** `file-browser-view.tsx:154`, `asset/asset-view.tsx:30`.
- **New:** `Breadcrumb` (mono 11 px, `● 2 agent edits`).
- **E2E:** extend `file-browser-ide.spec.ts`.

## 04i · ⅓ chat + file | file
- **Reuse:** `editor-groups.tsx:52`, `use-split-layout.ts`, `split-shortcuts.ts:8`.
- **New:** `GroupTabStrip` (32 px, underline active, dimmed when unfocused) replacing `tab-bar.tsx:182`.
- **Keys:** `⌘\` split right, `⌘⇧\` split down (`app-shortcuts.ts:22`).
- **E2E:** extend `editor-groups.spec.ts`.

## 04j · ⅓ chat + file / terminal
- **Reuse:** `terminal-panel.tsx:53` (dock; fixed `256` at `:360`), `terminal-dock-view.tsx:26`.
- **Change:** terminal height becomes draggable, default 240 (audit P15). Terminal inside a content group uses `TerminalPanel :358`.
- **E2E:** extend `terminal.spec.ts`.

## 04k · Drag-to-split
- **Reuse:** `DropEdge` (`editor-layout.ts:22`, `editor-groups.tsx:38`), `editorTabMime :83`.
- **New:** `DropZoneOverlay` with 5 labelled zones in `--sb-brand` tint (the one allowed brand use beyond focus).
- **E2E:** extend `editor-groups.spec.ts`.

## 04l · File tree
- **Reuse:** `session-sidebar.tsx:834` (grid-cols-2) and `:847` (Explorer) toggle, `jingler-app.tsx:376` (`renderExplorer`), `file-browser-view.tsx:174` (`FileBrowserExplorer`), `components/pierre-file-tree.tsx:41`.
- **New:** `FilterChips` (All · Changed N · PR #N). Remove the `files` tab (`tab-contributions.ts:58`); keep `FileBrowserQuickOpen :230` for `⌘P`.
- **Machine:** sidebar mode and chip are two coupled pieces plus per-project memory: put in a small `explorer-view-machine.ts` or extend `file-browser-machine.ts`.
- **Header Changes button** calls `revealSessionChanges` (`renderer/changes-review.tsx:74`) and opens the diff.
- **Keys:** `⌘⇧E`.
- **E2E:** extend `diffs-file-tree.spec.ts`, `explorer.ts` helper.

## 04m · PR stack
- **Reuse:** `composites/pr-glyph.tsx:52`/`:106`, `pull-request-view.tsx:201`, `pr-side-panel.tsx:113`, `use-pull-request.ts:25`.
- **Data:** replace `prNumber` (`packages/core/src/domain.ts:553`, `:622`) with ordered `prs[]` (`{ number, branch, base, state, checks }`). Keep `prNumber` as derived top-of-stack for one release. Migrate persisted sessions.
- **New:** `PrStackRail` (Graphite style), `PrSwitcher` (`PR #482 ▾ 2/3`), stack variant of `PrStatusGlyph`.
- **Machine:** new `pr-stack-machine.ts` (selected PR, merge-stack progress with halt/resume, F3-04).
- **RPC missing:** `Github.restack` (retarget + rebase) (F3-03). Existing: `Github.merge :1959`, `Github.updateBranch :1982`, `Github.createPr :1850` (payload needs `base`), `Github.prState :1815`.
- **Notifications:** key `alreadyNotified` on (session, PR number) (`pr-sweep.ts:33`); `closeOnMerge` waits for the whole stack (`domain.ts:349`).
- **Keys:** `⌥[` / `⌥]`.
- **Q:** is the layer branch created by the agent or by Jingler (F3-02)?
- **E2E:** new `pr-stack.spec.ts` (extend `fake-github.ts` with 3 chained PRs).

## 05 · Changes review
- **Reuse:** `composites/changes-review.tsx` (`ExplorerPanel :123`, `ChangedFilesExplorer :176`, `ReviewFileDiff :293`, `ReviewSidebar :417`, `OmittedFilesNotice :71`), `review-code-view.tsx:302`, `review-findings.tsx:181`/`:318`, `review-tray.tsx:19`, `inline-comment-composer.tsx:13`, `review-file-tree.tsx:18`, `code-review-view-machine.ts:26`, renderer hook `changes-review.tsx:24`.
- **Remove:** `onRevertFile`/`onRevertLines` buttons (`changes-review.tsx:278-279`, `:309-310`) per §6.1. **Q:** keep `Workspace.revertFile :661` as a context-menu "Discard file changes"?
- **Findings:** plain comment-style rows, severity text, `Ask agent to fix`, `Dismiss ×` (F2-07). **RPC missing:** dismissal persistence (`Review.*` at `:1611-1660` has none). Store in `review-store.ts:14` first, add `Review.dismiss` if it must sync across devices.
- **New:** `TurnFilter` ("All turns ▾"), `PrFilter` ("PR: #481 ▾"), `DismissedFindingsRow`.
- **States:** skeleton, empty ("No changes yet"), error + Retry, `OmittedFilesNotice`.
- **Keys:** `⌘⇧D`.
- **E2E:** extend `diffs-file-tree.spec.ts`, `enormous-review-diff.spec.ts`; new `review-findings-dismiss.spec.ts`.

## 06 · Checks
- **Reuse:** `pull-request-view.tsx:201` (merge `onMerge :175`, `mergeError :179`), `pr-side-panel.tsx` (merge methods `:37-51`, `renderDraftActions :152`, `renderConflictActions :173`, `behind :300`), `pr-check-row.tsx:16`, `pr-review-thread.tsx:136`, `pr-timeline-entry.tsx`, `workspace-workflow-bar.tsx:16` (Workflow section).
- **Machine:** `publish-machine.ts` (`failed :59`, `no-changes :61`); draw the 3-step stepper (F2-09). Add `resumeFrom` retry (`domain.ts:547`).
- **New:** `ReadinessChecklist` (StatusRow list), `MergeSplitButton`.
- **RPC:** `Github.createPr :1850` (stream), `Github.markReady :1971`, `Github.resolveThread :1933`, `Github.replyToThread :1946`.
- **Neutral status icons** (§6.3): replace `bg-green` callouts at `pr-side-panel.tsx:232`.
- **Keys:** `⌘⇧P`.
- **E2E:** extend `github-publish.spec.ts`, `github-cli-pr.spec.ts`.

## 07 · Terminal
- **Reuse:** `terminal-panel.tsx:53`, `xterm-view.tsx`, `use-terminals.ts`.
- **RPC:** `Terminal.create :1998`, `Terminal.resize`, `Terminal.kill`.
- **New:** draggable resize handle; empty state ("No terminals" + New terminal); shell-exited state with Restart.
- **E2E:** extend `terminal.spec.ts`.

## 08 · New workspace
- **Reuse:** `composites/new-workspace-view.tsx:491`, `new-workspace-machine.ts` (error handling `:423-435`, `PROVISION_FAILED :560`), `linked-issue-selector.tsx:37`, `repo-picker.tsx:21`, `issue-picker-list.tsx:15`, `pr-picker-list.tsx`.
- **New:** `ChipRow` (project · from · isolation · environment), `StartFromList`.
- **States:** issue provider missing → Connect (F2-01), list skeleton/empty/error (F2-02), already-linked issue (F2-03, **Q**), environment chip only when a device or managed env exists (F7-09).
- **RPC:** `Sessions.createFromIssueWithProgress :731`, `createFromPr :708`, `linkIssue :739`.
- **Keys:** `⌘N`, `⌘↵`.
- **E2E:** extend `projects-and-workspaces.spec.ts`, `github-issues-inbox.spec.ts`.

## 09a · Settings · General
- **Reuse:** `settings-view.tsx:944` (`GeneralSection`), `:107` (`NAV`). Replace `settings-dialog.tsx:112` (delete the dialog).
- **Machine:** `offload-settings-machine.ts:27`: add `Failed · Retry` row (F7-08).
- **New:** `SettingsNav` with groups and search, `SettingsCard`/`SettingsRow`.
- **RPC:** `Config.setDefaultMode :1429`, `Config.setFontScale :1476`, `Config.setAdhdMode`, `Config.setOffloadCompute :1327`.
- **Keys:** `⌘,`.
- **E2E:** extend `adhd-mode.spec.ts`, `offload-compute.spec.ts`, `text-size.spec.ts`.

## 09b · Settings · Providers
- **Reuse:** `provider-connections-settings.tsx:222`, `provider-connections-settings-machine.ts:28`, `provider-auth-forms.tsx:9`, `native-endpoint-login.tsx:6`, `provider-icon.tsx`.
- **New:** `ConnectSheet` (480 px right sheet, segmented Subscription / API key).
- **Rule:** subscription connections never fall back to an API key; keep the line visible.
- **RPC:** `Provider.startCodexLogin :329`, `Provider.cancelLogin :335`, `Provider.setApiKey :341`, `Provider.logout`, `Provider.removeConnection`.
- **E2E:** extend `provider-onboarding.spec.ts`.

## 09c · Settings · GitHub
- **Reuse:** `settings-view.tsx:1238` (`GithubSection`), PR toggles block.
- **Copy change:** `closeOnMerge` (`domain.ts:349`) reads "Close workspace when the whole stack is merged" (F3-09).
- **RPC:** `Config.setGithub`, `GitHub.refresh`, `GitHub.disconnect`.
- **E2E:** extend `github-onboarding.spec.ts`.

## 09d · Settings · MCP servers
- **Reuse:** `mcp-settings.tsx:31`/`:132`/`:284`, `use-mcp-settings.ts`. `McpAuthState` (`packages/core/src/mcp.ts:39`) includes `needs-auth` and `authorizing`.
- **New:** neutral health row (icon + "12 tools"), `Needs sign-in · Connect` per OAuth server.
- **RPC:** `Mcp.status :1219`, `Mcp.setAuth`, `Mcp.startAuthorization :1257`.
- **E2E:** extend `mcp-recovery.spec.ts`, `mcp-import-dialog.spec.ts`.

## 09e · Settings · Theme
- **Reuse:** `themes-settings.tsx:86`/`:102`.
- **RPC:** `Theme.list`, `Theme.import :2417`, `Theme.setActive`.
- **Q:** Graphite default (see 00).
- **E2E:** extend `branding.spec.ts`.

## 09f · Settings · Notifications
- **Reuse:** `settings-view.tsx` notifications block (copy verbatim, `:1188-1223`), `NotificationsConfig` import `:7`.
- **New:** blocked-by-OS warning row with `Open System Settings` (F4-06). Needs a main-process permission probe (**RPC missing**, extend `Notify.show :1540` or add `Notify.permission`).
- **RPC:** `Config.setNotifications :1422`.
- **E2E:** new `notifications-settings.spec.ts`.

## 09g · Settings · Projects (+ Routines)
- **Reuse:** `project-workflow-settings.tsx:18`, `project-workflow-machine.ts:74`, `routines-settings-view.tsx:39`, `routines-machine.ts:40`, `routine-form-machine.ts:72`.
- **RPC:** `Projects.setWorkflow :574`, `Projects.remove`, `Routines.list :260`, `Routines.runNow`.
- **States:** missing folder row with Locate / Remove (F1-13).
- **E2E:** extend `workspace-routines.spec.ts`, `unified-project-settings.spec.ts`, `workspace-workflow.spec.ts`.

## 09h · Settings · Devices
- **Reuse:** `DevicesSection settings-view.tsx:484` (states `:566-572`), `environment-machine.ts:81`, `use-environments.ts`.
- **States:** `offline`/`reconnecting` (`domain.ts:36-46`), incompatible remedy, revoke confirm (F7-02..04). Replace green/yellow fills with neutral text.
- **RPC:** `Environment.pairSsh :455`, `suggestHosts :451`, `rename :461`, `revoke :467`.
- **E2E:** extend `remote-environments.spec.ts`, `managed-environments.spec.ts`.

## 09i · Settings · Agents & skills
- **Reuse:** `agents-settings.tsx:82`, `agents-settings-machine.ts:57`, `use-agents-settings.ts`.
- **New:** `VirtualList`-based searchable list with kind + source filters and counts (§6.7). **Q:** virtualiser: the repo has none in `packages/ui`; confirm before adding a dependency.
- **RPC:** `AgentResources.list :372`, `setEnabled`, `remove`, `Skills.list :1196`.
- **E2E:** extend `agent-imports.spec.ts`.

## 09j · Settings · Context & plan
- **Reuse:** `settings-view.tsx:718` (`ContextSection`), `context-meter.tsx:68`.
- **RPC:** `Config.setContext`, `Config.setPlanAutoRun`, `Config.setPlanTemplate`, `Context.state :1302`.
- **E2E:** extend `context-compaction.spec.ts`, `plan-mode.spec.ts`.

## 09k · Settings · Runtime
- **Reuse:** `runtime-inspector.tsx:12`, `runtime-inspector-machine.ts:25`, `use-runtime-inspector.ts`.
- **RPC:** `RuntimeDiagnostics.get :266`, `.latest`, `.export :275`.
- **E2E:** extend `runtime-settings.spec.ts`.

## 09l · Settings · Plugins
- **Reuse:** `plugins-settings.tsx:480`, `plugin-secret-setting-machine.ts:20`.
- **Rule:** Plannotator is built in; no API key field (§6.8). Its code lives in `screens/plan-review.tsx`, `plan-presence.ts`, `plannotator-recovery.ts`; show only real settings.
- **RPC:** `Plugins.list :2484`, `Plugins.setEnabled`, `Plugins.secretSet :2676`.
- **E2E:** extend `plugins.spec.ts`.

## 09m · Settings · Web search & header views
- **Reuse:** `web-search-settings.tsx:26`.
- **New:** Header views picker (max 5 pinned, drag to reorder). Same open data question as 04g.
- **RPC:** `WebSearch.get :1508`, `WebSearch.setCredential`, `WebSearch.skip`.
- **E2E:** extend `web-search.spec.ts`; header views in `view-launcher.spec.ts`.

## 09n · Settings · Coming soon
- **Reuse:** `StubSection settings-view.tsx:693`. Permissions and Keybindings show a `Soon` pill in the nav instead of being hidden.
- **E2E:** covered by a settings-nav test in `unified-project-settings.spec.ts`.

## 10 · Command palette
- **Reuse:** `app/command-palette.tsx:50` (placeholder `:40`), `command-palette-model.ts:31`, `title-search.tsx:25`.
- **New:** scope chips (`>`, `@`, `#`), "Needs you (N)" pinned section and action (F4-04), "Open view…" section, footer hints.
- **Machine:** palette state is local; scopes + results + selection are 3 coupled pieces, so extract `command-palette-machine.ts` if scopes are added.
- **Keys:** `⌘K`, `↵`, `⌘↵`, `Tab` scope.
- **E2E:** extend `command-palette.spec.ts`.

## 12 · Empty / loading / error
- **Reuse:** `project-sidebar.tsx:130` (only skeleton today), `screens/loading-screen.tsx:41`, `root-error-boundary.tsx:22`, `components/feedback.tsx:25`.
- **New:** the shared `ListSkeleton`, `EmptyState`, `InlineError`. Offline banner (**New**; no detection exists, F5-06): `navigator.onLine` plus a failed-RPC heuristic.
- **Boot failure:** replace `App.tsx:2168` raw text with a Retry card (F1-08).
- **E2E:** extend `boot.spec.ts`, `splash.spec.ts`.

## 13 · Before → After
- Documentation board only. No code. Keep in sync with `01-current-app-audit.md` problem ids P1-P16.

## 14 · Overlays
- **Reuse:** `add-project-dialog.tsx:297`, `add-project-machine.ts:90`, `user-menu.tsx:88`, `usage-modal.tsx:121`, `components/dialog.tsx`.
- **New:** `ToastRegion` (F4-07).
- **Note:** `usage-modal.tsx` splits into the limits popover (18a) and Settings → Usage (18b).
- **E2E:** extend `projects-and-workspaces.spec.ts`; new `toasts.spec.ts`.

## 15a · Connect · OAuth waiting
- **Reuse:** `provider-connections-settings-machine.ts:28`, `app-machine.ts` `authenticating` with `CANCEL_AUTH :500`.
- **RPC:** `Provider.startCodexLogin :329`, `Provider.cancelLogin :335`.
- **E2E:** extend `provider-onboarding.spec.ts`.

## 15b · Connect · Device code
- **Reuse:** `Provider.loginEvents :318` (`loginEvent.type === "device-code"`), `provider-auth-forms.tsx:27`.
- **New:** `DeviceCodeBlock` (20 px mono code, copy, countdown, Reopen browser).
- **E2E:** extend `provider-onboarding.spec.ts`.

## 15c · Connect · API key
- **Reuse:** `provider-auth-forms.tsx:27`, `Provider.setApiKey :341`.
- **States:** saving → verified / invalid (keeps input). Use `Provider.verifyModel`.
- **E2E:** extend `provider-onboarding.spec.ts`.

## 15d · Providers · accounts
- **Reuse:** `provider-connections-settings.tsx:222`, `provider-recovery.ts:15` (`entitlement` copy), `native-endpoint-login.tsx:10`.
- **New:** account row with default star and `Make default`/`Sign out`.
- **Data:** none beyond existing connections. **Q:** is a default account per runtime stored? `Config.setDefaultProviderModel` is per model.
- **E2E:** extend `provider-models.real.spec.ts` (real) or `provider-onboarding.spec.ts` (fake).

## 16a · Import · Sources
- **Reuse:** `screens/setup/resource-setup-step.tsx:10`, `renderer/mcp-import-prompt.tsx:39`, `mcp-import.ts` (cli-adapters).
- **Consolidate:** one flow replacing the onboarding step and the one-time dialog (§5j). Remove step `resources` from the machine (`app-machine.ts:512`) once the Home card exists.
- **RPC:** `AgentResources.detect :377`, `Mcp.importCandidates :1264`.
- **E2E:** extend `mcp-import-dialog.spec.ts`, `agent-imports.spec.ts`.

## 16b · Import · Review
- **New:** `ConflictBadge` (Keep mine / Replace / Keep both), `NeedsSecretsRow`, `NeedsSignInRow` (OAuth host, §6.6).
- **RPC:** `AgentResources.importFiles :383`, `Mcp.applyImport :1275`.
- **E2E:** extend `mcp-import-dialog.spec.ts`.

## 16c · Import · Result
- **New:** neutral result rows; red icon only on `Failed to start · View log`; `Connect` runs `Mcp.startAuthorization :1257`.
- **E2E:** extend `mcp-import-dialog.spec.ts`.

## 16d · MCP server detail
- **Reuse:** `McpServerDialog mcp-settings.tsx:284`.
- **New:** `ToolList` with toggles, `LogTail`, OAuth status row.
- **RPC:** `Mcp.status :1219`, `Mcp.reveal`. **RPC missing:** log tail. **Q:** where do MCP logs live today (`mcp-probe.ts`)?
- **E2E:** extend `mcp-recovery.spec.ts`.

## 17a · Plan review
- **Reuse (keep layout):** `screens/plan-review.tsx:142` (layout `:254-356`, `decisionError :156`), `plan-stage-card.tsx:224`, `plan-comment-layer.tsx:16`, `plan-comment-store.ts:4`, `plan-doc/*`.
- **Restyle only:** see §5k.2. `Request changes` uses `danger` (outline red), `Approve` uses the neutral primary.
- **Gaps:** stale banner, approve disabled while revising, unsaved-comment confirm (F2-04, F2-05); Plannotator disconnected card (F8-06).
- **RPC:** `Plan.decide :2180`.
- **E2E:** extend `plan-mode.spec.ts`, `rich-plan-scratchpad.spec.ts`.

## 17b · Plan executing
- **Reuse:** `plan-card.tsx:110`, `plan-progress-dock.tsx` (`PlanProgressStatus :18` includes blocked, failed, interrupted).
- **Draw:** failed and interrupted rows (F2-06).
- **E2E:** extend `plan-tools-any-mode.spec.ts`.

## 17c · Explanation
- **Reuse:** `screens/explanation-view.tsx:15` (empty text `:30`), `use-explanation-document.ts`, `Explanation.watch :1605`.
- **New:** skeleton-of-headings loading state; TOC rail.
- **E2E:** extend `rich-plan-scratchpad.spec.ts` or new `explanation.spec.ts`.

## 17d · Agent asks
- **Reuse:** `question-card.tsx:19` (copy `:154`), `approval-gate.tsx:20`.
- **RPC:** `Agent.answerQuestion :1046`, `Agent.decideGate :1035`.
- **Add:** timeline `needs` tick and rail badge hook (F4-01); "Switch session to Auto" link (`Agent.setMode :1057`).
- **E2E:** extend `queue-actions.spec.ts` or new `needs-you.spec.ts` (covers 03, 04b, 17d, notifications).

## 18a · Usage popover
- **Reuse:** `usage-modal.tsx:121` (limits part), `user-menu.tsx:88`.
- **RPC:** `Usage.get :1288`. Show relay quota statuses (F7-06, **Q** source: `core/src/remote.ts:137`).
- **E2E:** new `usage.spec.ts`.

## 18b · Settings · Usage
- **Reuse:** `UsageReportGroup` (`packages/core/src/runtime/usage-facts.ts:69`), `Usage.report :1293`, `usage-modal.tsx:101` (execution report).
- **New:** `KpiTile`, `ModelPerformanceTable` (sortable), `StackedMiniBar`, charts (**Q:** chart library; none in repo, prefer inline SVG).
- **RPC missing?** `Usage.report` takes no filters; range/runtime/project filters either run client-side or need a payload. **Q.**
- **Badges one line** (§6.4): `Subscription`, `API key`, runtime chips.
- **E2E:** in `usage.spec.ts`.

## 18c · Model detail drawer
- **New:** `Drawer` (480 px; reuse `components/dialog.tsx` Radix primitive), sparklines.
- **Data:** slowest-runs links need a run → turn id mapping. **Q:** present in `UsageReportGroup`?
- **E2E:** in `usage.spec.ts`.

## 19a · PR inbox
- **Reuse:** `pull-request-inbox.tsx:102`, `pull-request-inbox-filter-machine.ts:17`, `pull-request-inbox-machine.ts:44`, `use-pull-request-inbox.ts`.
- **Gap:** no Retry (`pull-request-inbox.tsx:73` only has `error`) (F2-02).
- **RPC:** `Github.inbox :1693`, `Github.teamPrs :1703`.
- **E2E:** extend `github-team-pr.spec.ts`.

## 19b · Issue inbox
- **Reuse:** `issue-inbox.tsx:93`, `issue-inbox-filter-machine.ts:17`, `use-issue-inbox.ts`.
- **Gap:** Retry (`issue-inbox.tsx:86`).
- **RPC:** `Github.issueInbox :1736`.
- **E2E:** extend `github-issues-inbox.spec.ts`.

## 20 · Subagents · dropdown
- **Reuse:** `app/subagent-tab-bar.tsx:7` (chip strip it replaces; History menu becomes `Finished · N`), `app/agent-roster.tsx:6` (Peer agents move into the popover under `Peers · N`), `composites/agent-card.tsx:7`, `app/subagent-fleet-machine.ts:191` (`subagentFleetMachine`), `renderer/session-chat-tabs.tsx:5` (`SessionSubagentTabs`).
- **New:** `SubagentPopover` in the lane header (`2 subagents ▾`: running, `Finished · N`, workflow tree, `Peers · N`); every row is one line (status word, agent, truncated task, elapsed) with `nowrap` on pills. No fleet tab and no "Open beside" (§6.16).
- **Fix:** Send button hard-coded `bg-blue` (`agent-roster.tsx:56`); swallowed stop errors (`conversation-pane.tsx:1099`, `:1102`). `AgentState` needs `failed` and `stopped` (`agent-card.tsx:4`).
- **Machine:** `subagent-fleet-machine.ts:191`; `SYNC` must not reset an open child.
- **RPC:** `Agent.controlSubagent :1150` (actions in `core/src/runtime/subagent-fleet.ts:153`), `Agent.stopSubagent :1118`, `Agent.subagentFleetSnapshot :1127`.
- **Sub-issues:** 8.1, 8.4, 8.6, 8.7.
- **Keys:** ⌘K "Go to subagent…".
- **E2E:** extend `subagents-outlive-turn.spec.ts`, `fleet-durable-status.spec.ts`.

## 20a · Subagent · viewing in place
- **Reuse:** `app/subagent-view.tsx:110` (`FleetAgentView`, header `renderAgentHeader :119`), `:95` (`AgentView`), `renderer/subagent-tab-store.ts` (selection it replaces), `renderer/conversation-pane.tsx:1099` (stop wiring), `components/provider-icon.tsx:85` (`ProviderIcon`).
- **New:** lane breadcrumb `Fix PR inbox › reviewer ▾` with `← Main` (Esc); 3-row meta strip from `SubagentFleetNode` (`core/src/runtime/subagent-fleet.ts:81`): (1) model + status/phase + elapsed + `Details ▾`, (2) `currentTool` mono · tokens · tool calls · cost (> 0 only) · `Background` pill, (3) `artifacts[]` chips; read-only composer bar with `Stop`.
- **Machine:** new `subagent-view-machine.ts` (selected child, lane content, header, bar state couple) with `*.test.ts`; main draft and scroll are preserved while a child is open.
- **Data:** none; null `SubagentFleetNode` fields are omitted.
- **Tokens:** `--sb-*` only; pills `nowrap`.
- **Keys:** Esc returns to main.
- **Sub-issues:** 8.2, 8.3, 8.8.
- **E2E:** new `apps/desktop/e2e/subagent-view.spec.ts`.

## 20b · Subagent view states
- **States:** Details expanded; attention (`attention.message` + `Reply`); failed (`terminal.summary` + `Retry` when `terminal.retryable`); stopped ("Stopped by you · 2m 10s"); loading skeleton; orchestrator with no transcript (`subagent-view.tsx` empty branch).
- **Reuse:** `ListSkeleton`/`InlineError` (2.6), `SubagentFleetTerminal`/`SubagentFleetAttention` (`core/src/runtime/subagent-fleet.ts:56`, `:72`).
- **Sub-issues:** 8.3, 8.5.
- **E2E:** `subagent-view.spec.ts`.

## 26a · PR view · Conversation
- **Reuse:** `composites/pull-request-view.tsx:201` (`PullRequestView`; `renderPullRequestBody :264`, `StatePill :45`, `LabelChip :63`), `composites/pr-timeline-entry.tsx:28`, `composites/pr-review-thread.tsx:136` (`PrReviewThreadView`), `composites/pr-review-composer.tsx:12`, `composites/pr-side-panel.tsx:113`, `renderer/pull-request-pane.tsx:13`, `renderer/use-pull-request.ts:62`.
- **New:** `ReadingShell` (shared with 26d, see 6.23), PR header + 28px sub-tabs, 280px right rail with merge box.
- **Machine:** none new; publish/stack state stays in `publish-machine.ts` and `pr-stack-machine.ts` (6.9).
- **RPC:** `Github.pr :1686`, `Github.submitReview :1910`, `Github.resolveThread :1933`, `Github.replyToThread :1946`, `Github.comment :1860`, `Github.merge :1959`.
- **Data:** `PullRequest` (`core/src/domain.ts:1652`); timeline items `:1536`, threads `:1604`.
- **Tokens:** neutral timeline verbs; no green/amber fills.
- **Keys:** ⌘⇧P (Checks), ←/→ sub-tabs.
- **Sub-issues:** 6.18, 6.19, 6.20.
- **E2E:** new `apps/desktop/e2e/pr-view.spec.ts`; extend `github-cli-pr.spec.ts`.

## 26b · PR view · Files & Checks
- **Reuse:** `composites/changes-review.tsx:176` (Changes renderer), `composites/pr-check-row.tsx:16`, `pull-request-view.tsx:639` (`CommitEvidence`), `:667` (`CheckEvidence`).
- **RPC:** `Github.files :1822`, `Github.diff :1829`.
- **Sub-issues:** 6.18, 6.21.
- **E2E:** extend `github-team-pr.spec.ts`, `pr-view.spec.ts`.

## 26c · PR view · merge & states
- **Reuse:** `pull-request-view.tsx:138` (`connectionMessage`, `publish`, `readOnly`), `pr-side-panel.tsx` (`renderDraftActions :152`, `renderConflictActions :173`, `behind :300`), `core/src/domain.ts:547` (`PublishCheckpoint`).
- **States:** blocked, conflicts, behind, draft, merged, not connected, no PR yet, loading, error + Retry, read-only team PR.
- **RPC:** `Github.teamPr :1714`, `Github.prBySlug :1761`, `Github.updateBranch :1982`, `Github.markReady :1971`.
- **Sub-issues:** 6.12, 6.13, 6.14, 6.20, 6.22.
- **E2E:** `github-publish.spec.ts`, `github-team-pr.spec.ts`, `pr-conflicts.spec.ts`.

## 26d · Issue view
- **Reuse:** `plugins/github-issues/src/ui.tsx:106` (`IssueTab`), `:72` (`Comment`), `:275` (`IssueMetadata`), `composites/issue-picker-list.tsx:116` (`IssueLabelChip`), `packages/plugin-sdk/src/ui.ts:58`/`:62` (SDK re-exports), `app/tab-contributions.ts:146` (`issueProviderId`).
- **New:** issue comment composer (`Comment` / `Close with comment`), rail (assignees, labels, linked workspace).
- **RPC:** `Github.issue :1804`, `Github.issueBySlug :1742`, `Github.issueCommentBySlug :1749`, `Github.issueCloseBySlug :1755`, `Github.closeIssue :1798`. Comment posting from the plugin's host half is **missing** (read-only today).
- **Data:** `IssueDetail` (`core/src/domain.ts:1805`); **Q:** `linkedPrs` (14.11).
- **Sub-issues:** 6.23, 6.24, 6.25, 14.11.
- **E2E:** new `apps/desktop/e2e/issue-view.spec.ts`; extend `github-issues-inbox.spec.ts`.

## 26e · Issue view · Linear & states
- **Reuse:** `plugins/linear/src/ui.tsx:478` (`IssueTab`), `:281` (`DetailView`), `:258` (`Metadata`), `:163` (`UnlinkedView`), `:143` (`Comment`), `:120` (`LinearMark`), `:333` (`LinearSetupFlyout`), `plugins/linear/src/linear-issue-machine.ts:73`, `renderer/plugin-loader.ts:472`.
- **States:** loading, unlinked ("No issue is linked to this session." + `Link issue`), couldn't load + Retry, closed banner (`Reopen`: no RPC exists, **Q**).
- **Sub-issues:** 6.25, 6.26.
- **E2E:** extend `linear-plugin.spec.ts`, `issue-view.spec.ts`.


## 21 · Browser preview
- **Reuse:** `app/preview-dock.tsx:27` (`PreviewToggleButton :136`), `preview-dock-view.tsx:15`, `preview-dock-machine.ts:118` (`NAVIGATE :33`, `REVEAL_BROWSER :35`, `SET_SIDE :32`).
- **New:** `IconButtonGroup` toolbar (back/forward/reload/open external, §6.9), device-width group, "Preview ready" transcript chip.
- **RPC:** `BrowserPreview.open :2135`, `.navigate :2151`.
- **Keys:** `⌘⇧B`.
- **E2E:** extend `previews.spec.ts`.

## 22a · Composer · @ + / menus
- **Reuse:** `mention-menu.tsx:10`, `slash-command-row.tsx:6`, `composer.tsx:514`.
- **E2E:** extend `composer-capabilities.spec.ts`.

## 22b · Composer · Model popover
- **Reuse:** `provider-model-browser.tsx:15`/`:99`, `ComposerSelect composer.tsx:200`, reasoning and environment chips, `EnvironmentDialog environment-dialog.tsx:36`.
- **Change:** reasoning and environment move into the popover (spec change 4).
- **Empty:** "Choose a model to start" (F1-14).
- **RPC:** `Agent.setModel`, `Agent.setReasoning`, `Provider.verifyModel`.
- **E2E:** extend `composer-capabilities.spec.ts`.

## 22c · Composer · Context, attachments, queue
- **Reuse:** `context-meter.tsx:68`, `components/attachment-thumb.tsx`, `queued-message-row.tsx:52`, `background-task-dock.tsx:150`/`:220`, `composer.tsx:456` (`ComposerMcpDialogs`).
- **Change:** ContextMeter becomes a ring on the send button with a detail popover.
- **RPC:** `Context.state :1302`, `Context.compactNow :1315`, `BackgroundTasks.list/stop/output`.
- **E2E:** extend `attachments.spec.ts`, `queue-actions.spec.ts`, `background-tasks.spec.ts`, `context-compaction.spec.ts`.

## 22d · Transcript states
- **Reuse:** `message-turn.tsx:122`, `thought-block.tsx:20`, `tool-call.tsx:111`, `context-divider.tsx:55`, `workspace-checkpoints-view.tsx:13`.
- **New cards:** "Opened #481 · stacked on #480" (F3-08), "PR #482 merged" (F2-13), "Explanation ready", failed tool with `Sign in to …` (F5-05).
- **Machine:** checkpoint revert uses `workspace-checkpoints-machine.ts:32` (preview then restore).
- **RPC:** `WorkspaceCheckpoints.preview :599`, `.restore :603`.
- **E2E:** extend `workspace-checkpoints.spec.ts`.

## 23 · Banners
- **Reuse:** `archived-banner.tsx:20`, `branch-drift-banner.tsx:18`, `runtime-recovery-card.tsx:24`, `components/callout.tsx:41`.
- **New variants:** provider-signed-out/limited, device offline, relay quota, offline (F5-01, F5-02, F5-06, F7-05, F7-06). Share one `BannerShell` (neutral body, red icon only on failure).
- **MCP card:** persist dismissal (replace module `Set`, `conversation-pane.tsx:120`), add waiting/cancel/failed (F5-04).
- **RPC:** `Sessions.resolveRuntimeRecovery :807`, `Sessions.continueOnEnvironment :860`.
- **E2E:** extend `branch-drift-recovery.spec.ts`, `mcp-recovery.spec.ts`, `pi-recovery.spec.ts`.

## 24a · Sidebar menus & quick open
- **Reuse:** `filter-menu.tsx`, `session-filters.ts:23`, `session-row.tsx:57`, `project-sidebar.tsx:81`, `components/context-menu.tsx:199`, `asset/file-quick-open.tsx:24`.
- **Row fix:** status word, separator, diff stat `nowrap shrink-0`; only branch truncates (`session-row.tsx:129`).
- **Rail badge:** amber needs-you count (F4-01); `ProjectAvatar` props `sessionCount`/`activeSessionCount` (`project-sidebar.tsx:16-17`) gain `needsYouCount`.
- **Keys:** `⌘1-9` projects (`project-navigation.ts:3`), `⌘P`.
- **E2E:** extend `sidebar-attention-layout.spec.ts`, `project-sidebar-activity.spec.ts`, `sidebar-identity.spec.ts`.

## 24b · Dialogs & system
- **Reuse:** `components/confirm-dialog.tsx:19`, `sign-in-dialog.tsx:14`, `session-sidebar.tsx:53` (`SidebarUpdate`), `:66` (`SidebarReleaseNotes`), `use-auto-update.ts:15`, `use-release-notes.ts:32`.
- **New:** `ToastRegion`, What's-new dialog, update states (F8-01..03), revoke and archive confirms (F7-04, F2-14).
- **Machine:** new `toast-machine.ts` (queue max 3, timers, hover pause); update states are already in the main-process updater.
- **Notifications:** payload `{ sessionId, kind, turnId }` (`notifications.ts:111`, `preload/index.ts:108`, `App.tsx:289`) (F4-02).
- **E2E:** extend `release-notes.spec.ts`; new `toasts.spec.ts`.

## 25a · Hover card + archived list (planned)
- **Reuse:** `session-hover-card.tsx:25`, `components/hover-card.tsx:26`, `session-sidebar.tsx:646` (archived), `session-archive-machine.ts`.
- **RPC:** `Sessions.restore :800`, `Sessions.delete :895`.
- **E2E:** new `archived-list.spec.ts`.

## 25b · Workspace setup progress / failure + device pairing (planned)
- **Reuse:** `new-workspace-view.tsx:84` (`EnvironmentStartupProgress`), `new-workspace-machine.ts:73` (`provisioningPhase`), `workspace-workflow-bar.tsx:16`.
- **RPC:** `WorkspaceWorkflow.retrySetup :608`, `.skipSetup :614`, `Environment.pairSsh :455`.
- **E2E:** extend `managed-environments.spec.ts`, `workspace-workflow.spec.ts`.

## 25c · Revert confirm / sign-in dialog / crash screen (planned)
- **Reuse:** `confirm-dialog.tsx:19`, `sign-in-dialog.tsx:14`, `root-error-boundary.tsx:22` (reload `:82`).
- **Boot failure card:** `App.tsx:2168`.
- **E2E:** extend `boot.spec.ts`, `workspace-checkpoints.spec.ts`.

## 25d · File viewer states (planned)
- **Reuse:** `asset/asset-view.tsx:30`, `file-browser-view.tsx:154`, `Asset.read :2289`.
- **States:** loading, too large, unsupported, error + Retry, binary.
- **E2E:** extend `asset-browser.spec.ts`, `file-browser-ide.spec.ts`.

## 25e · PR detail & conflicts (planned)
- **Reuse:** `pr-side-panel.tsx` (`renderDraftActions :152`, `renderConflictActions :173`), `pr-side-panel.tsx:37-51` merge methods.
- **New:** `Ask agent to resolve conflicts` (posts a prompt, F2-12), blocker rows with actions.
- **RPC:** `Github.updateBranch :1982`, `Github.markReady :1971`, `Github.merge :1959`.
- **E2E:** extend `github-publish.spec.ts`; new `pr-conflicts.spec.ts`.

## Companion boards · row y=14000 (missing states)
Each "+" board sits on the row below the original and draws the missing states for the listed gaps (`06-flow-gaps.md`).
- **01+** — gaps F1-01, F1-02, F1-03, F1-04, F1-15; sub-issues 9.1, 9.2, 13.7, 15.2, 15.3.
- **02a+** — gaps F1-06, F1-07; sub-issues 9.3, 15.5.
- **02b+** — gaps F1-09; sub-issues 9.4.
- **02c+** — gaps F1-10; sub-issues 9.5.
- **03+** — gaps F1-11, F4-05; sub-issues 9.6, 10.8.
- **08+** — gaps F2-01, F2-02, F2-03, F7-09; sub-issues 6.16, 6.17, 6.25, 9.7, 14.9.
- **09a+** — gaps F7-08; sub-issues 10.2.
- **09c+** — gaps F3-09; sub-issues 10.5, 14.3.
- **09f+** — gaps F4-06; sub-issues 10.11, 14.6.
- **09h+** — gaps F7-02, F7-03; sub-issues 10.13.
- **22b+** — gaps F1-14; sub-issues 5.2.
- **12+** — gaps F1-05; sub-issues 15.4.
- **22d+** — gaps F2-13, F3-08, F5-05; sub-issues 5.9, 5.10.
- **23+** — gaps F1-05, F5-01, F5-02, F5-03, F5-04, F5-06, F7-05, F7-06, F8-05; sub-issues 5.12, 5.13, 5.14, 5.15, 11.1, 15.4, 15.7.
- **24b+** — gaps F2-14, F3-07, F4-03, F4-07, F6-03, F7-04, F8-01, F8-02, F8-03; sub-issues 2.4, 10.13, 12.4, 13.3, 13.5, 13.6, 14.3, 15.8, 15.9.

## Companion boards · row y=15600 (missing states)
- **04b+** — gaps F4-01, F4-02, F8-07; sub-issues 12.1, 12.2, 13.10.
- **04f+** — gaps F6-01; sub-issues 8.1.
- **04m+** — gaps F3-01, F3-02, F3-03, F3-04, F3-09; sub-issues 6.8, 6.10, 6.11, 10.5, 14.1, 14.2, 14.3.
- **05+** — gaps F2-07, F2-08, F3-06; sub-issues 6.2, 6.3, 6.5, 14.4, 14.7.
- **06+** — gaps F2-09, F3-02; sub-issues 6.7, 6.8.
- **10+** — gaps F4-04; sub-issues 12.3.
- **17a+** — gaps F2-04, F2-05, F8-06; sub-issues 7.2, 7.3, 7.6.
- **17b+** — gaps F2-06; sub-issues 7.5.
- **17d+** — gaps F4-02, F6-06; sub-issues 12.2, 12.5.
- **24a+** — gaps F1-13, F2-13; sub-issues 3.8, 5.9, 10.12.
- **25a+** — gaps F3-05, F8-08; sub-issues 13.3, 13.8.
- **25b+** — gaps F1-12, F7-01, F7-07; sub-issues 9.8, 10.14.
- **25c+** — gaps F1-08, F1-15, F2-14, F8-04; sub-issues 9.2, 13.1, 13.2, 13.3, 13.7, 15.6.
- **25e+** — gaps F2-10, F2-11, F2-12; sub-issues 6.12, 6.13, 6.14.

## 14.10 MCP log tail (#532) — where MCP logs live
Nowhere on disk. `probeServer` used to spawn stdio servers with `stderr: "ignore"`, so there was no log to read. It now pipes stderr and keeps the last 500 lines per server name in an in-memory ring (`packages/cli-adapters/src/mcp-log.ts`), replaced on every probe. `Mcp.logTail { server, lines? }` returns the last `lines` (default 200, max 500); an unknown, remote (http/sse, no stderr) or never-probed server returns `{ lines: [] }`. The tail is lost on app restart and reflects only the most recent probe, not a long-running agent attachment. If board 16d needs live logs from agent sessions, the attachment launch path (`runtime/mcp/attachment.ts`) would need to feed the same ring.

## 14.8 Usage filters (#530)
- Range, runtime and project filtering stay client-side over `UsageReport.facts`; the `Usage.report` payload is unchanged.
- Slowest runs come from `slowestRuns(facts)` in `core/runtime/usage-facts.ts`; `turnRunId` is the parent turn's run id (`parentRunId ?? runId`), so a child run links to the turn that spawned it.
