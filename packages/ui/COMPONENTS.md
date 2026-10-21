# UI component catalog

**Views compose only these. Add a missing primitive here first, in its own PR (with a story and test), then use it.** See `AGENTS.md` (standing rules).

Rules: no hardcoded colours (`--sb-*` tokens); every view/state has a Storybook story compared with its Paper board; status-bearing atoms never wrap (badges, pills, chips, kbd are one line).

Paths are relative to `packages/ui/src/`. *Story* = a `*.stories.tsx` imports the file. *Redesign* = the epic-1/2 issue that restyles or replaces it (GitHub numbers from `docs/ux-audit/issue-map.json`); feature restyles live in the other epics of `docs/ux-audit/05-backlog.md`.

## Atoms

Primitives in `components/`. Prefer these over raw elements.

| Component | File | Purpose | Key props | Story | Redesign |
|---|---|---|---|---|---|
| AsyncButton | `components/async-button.tsx` | Button that shows pending and success state while an async action runs. | — | yes | — |
| AttachmentSourceProvider | `components/attachment-source.tsx` | Context provider telling thumbnails where to load attachment bytes from. | — | no | — |
| AttachmentThumb | `components/attachment-thumb.tsx` | Image attachment thumbnail with filename. | — | yes | — |
| AuthDivider | `components/auth-divider.tsx` | Labelled hairline divider ("or with email"). | — | no | — |
| Avatar | `components/avatar.tsx` | Author avatar, sizes 16/20/24/32: image → initials fallback, mono Jingler mark for agents, optional one-line count badge, focusable button with `onClick`. | initial, src, size, agent, label, count, onClick | yes | #378 (2.13) |
| AvatarStack | `components/avatar.tsx` | Non-wrapping row of avatars overlapping by 6px, `max` collapses extras into `+N`. | children, max, size | yes | #378 (2.13) |
| Avatar | `components/avatar.tsx` | User avatar image from a GitHub login. | — | yes | #378 (2.13) |
| CommentRow | `components/comment-row.tsx` | Plain review comment row: muted severity label, message, action slot, Dismiss icon button; no fill. | severity, location, action, onDismiss | yes | #380 (2.15) |
| Badge | `components/badge.tsx` | Status / count badge (BeUI AnimatedBadge). One line by construction (nowrap, shrink-0). | children, tone, size, className, title | yes | #361 (1.3) |
| Breadcrumb, AgentEditsMarker | `components/breadcrumb.tsx` | Mono 11px path trail under a tab strip with a right-aligned slot; `AgentEditsMarker` renders `● N agent edits` (hidden at 0). | crumbs, children, count | yes | #403 (4.8) |
| BootFailureCard | `screens/boot-failure-card.tsx` | Boot failure card: "Jingler couldn't start", cause, raw error behind Details, primary Retry, Copy diagnostics. Red only on the icon. | error, onRetry, getDiagnostics | yes | #511 (13.1) |
| Button | `components/button.tsx` | Base button: primary, secondary, ghost, destructive. | children, pressScale, ripple | yes | #360 (1.2) |
| ButtonGroup | `components/button-group.tsx` | Joined group of buttons. | — | no | — |
| BannerShell | `components/banner-shell.tsx` | Neutral notice: icon (red only when failed), truncating message, up to two one-line actions, dismiss; top/lane/card placements. | icon, failed, actions, onDismiss, placement | yes | #376 (2.11) |
| ReadingShell, ReadingActionsMenu | `components/reading-shell.tsx` | Shared PR/issue reading surface: header (title + grey identifier, meta line, actions), 720px column, 280px rail (stacks below the wide tier); `⋯` menu with destructive items. | title, identifier, meta, actions, rail, items | yes | #445 (6.23) |
| Callout | `components/callout.tsx` | Inline notice with a leading glyph; tones share BannerShell neutral styling, only red colours the glyph. | children, glyph, className | no | #376 (2.11) |
| Card, CardHeader | `components/card.tsx` | Bordered panel surface (Card, CardHeader). | — | no | — |
| Checkbox | `components/checkbox.tsx` | Checkbox. | checked, onCheckedChange, indeterminate, label, tone | yes | — |
| ChipMenu | `components/chip-menu.tsx` | Compact Command picker anchored to a composer control. | — | no | — |
| CodeChip | `components/code-chip.tsx` | Rendered code reference chip (file, range). One line; label truncates. | — | no | — |
| Command, CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator, CommandShortcut | `components/command.tsx` | cmdk primitives: Command, CommandDialog, Input, List, Item… | — | yes | — |
| ConfirmDialog | `components/confirm-dialog.tsx` | Yes/no modal; neutral confirm by default, `destructive` = the only solid red button, Cancel focused first, Esc cancels. | open, onOpenChange, title, destructive, onConfirm | no | #375 (2.10) |
| ContextMenu | `components/context-menu.tsx` | Right-click menu. | — | yes | — |
| DeviceCodeBlock | `components/device-code-block.tsx` | OAuth device-code step: 20px mono user code, copy, expiry countdown, Reopen browser. | code, verificationUri, expiresInSeconds, onReopenBrowser | yes | #483 (10.4) |
| Dialog, DialogTrigger, DialogPortal, DialogClose, DialogOverlay, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription, DialogBody | `components/dialog.tsx` | Modal dialog primitives (Dialog, Header, Body, Footer…). | — | no | #373 (2.8) |
| Drawer, DrawerTrigger, DrawerContent, DrawerClose, DrawerTitle, DrawerDescription | `components/drawer.tsx` | 480px right sheet on the Dialog primitive; full-window scrim, focus trap, Esc, focus return. | open, onOpenChange, defaultOpen | yes | #373 (2.8) |
| DiffPeek | `components/diff-peek.tsx` | Single-file diff peek, virtualised for large patches. | — | no | — |
| DiffStat | `components/diff-stat.tsx` | Added/removed line counts (+313 −23). | — | no | — |
| Eyebrow, ClaudeGlyph | `components/eyebrow.tsx` | Uppercase tracked section label; ClaudeGlyph. | — | yes | — |
| InlineStatus, IndeterminateBar | `components/feedback.tsx` | InlineStatus message and IndeterminateBar. | — | yes | #371 (2.6) |
| FileChangeList | `components/file-change-list.tsx` | List of changed files with on-demand per-file diffs. | — | no | — |
| FileChip | `components/file-chip.tsx` | Inline file link with Material icon and diff evidence. | path, added, removed, onOpen, className, children | yes | — |
| FileIcon | `components/file-icon.tsx` | Material Icon Theme glyph chosen from a file name. | — | no | — |
| FilterMenu | `components/filter-menu.tsx` | Menu of filter axes, each opening a value flyout. | — | no | — |
| GithubMark | `components/github-mark.tsx` | GitHub octocat mark. | — | no | — |
| HoverCard | `components/hover-card.tsx` | Detail popover on hover intent and focus; elevated surface, r8, 150ms delay, Esc closes. | — | no | #374 (2.9) |
| HtmlPreview | `components/html-preview.tsx` | Opt-in preview for an html fenced block in agent output. | — | yes | — |
| IconButtonGroup | `components/icon-button-group.tsx` | One bordered unit of icon buttons with tooltips, pressed state and arrow-key focus (browser toolbar). | items, label, className | yes | #366 (2.1) |
| Input | `components/input.tsx` | Plain text field (BeUI Input geometry). | — | no | — |
| CommentComposer | `components/comment-composer.tsx` (+ `comment-composer-machine.ts`) | Issue comment box under a thread: Textarea, `Comment` primary, `Close with comment` secondary; failed post keeps the draft and shows an inline error. | post, canClose | yes | #446 (6.24) |
| Textarea | `components/textarea.tsx` | Multi-line field sharing Input's border, focus ring and disabled states. | — | yes | #446 (6.24) |
| Kbd, KbdChip | `components/kbd.tsx` | Monospace keyboard chip; onFill variant for primary surfaces. One line (nowrap, shrink-0). KbdChip formats `mod+k` as ⌘K on macOS, Ctrl+K elsewhere. | shortcut, mac, onFill | yes | #361 (1.3), #374 (2.9) |
| Kbd | `components/kbd.tsx` | Monospace keyboard chip; onFill variant for primary surfaces. One line (nowrap, shrink-0). | — | yes | #361 (1.3), #374 (2.9) |
| KpiTile, StackedMiniBar | `components/kpi-tile.tsx` | Usage metric tile with one-line partial marker and a labelled "No data" placeholder for a missing value; inline-SVG stacked bar from a number array (empty/zero renders an empty track). | label, value, delta, partial, values | yes | #379 (2.14) |
| LinearMark | `components/linear-mark.tsx` | Linear logo mark. | — | no | — |
| ModelPerformanceTable | `components/model-performance-table.tsx` | Per-model usage rows sortable by any column (model, runs, success, duration, tokens, cost); cost shows "partial" below full coverage. | groups, sortBy, direction, onSort | yes | #502 (11.2) |
| ThinkingOrb, Spinner, Skeleton | `components/loading.tsx` | ThinkingOrb, Spinner and Skeleton. | — | yes | #371 (2.6) |
| ListSkeleton, EmptyState, InlineError | `components/feedback.tsx` | List loading rows at real height, empty state with next action, load error with Retry. | rows, rowHeight, title, action, message, onRetry | yes | #371 (2.6) |
| Markdown | `components/markdown.tsx` | Markdown renderer with math (KaTeX) and code. | — | no | — |
| MermaidDiagram | `components/mermaid-diagram.tsx` | Mermaid diagram renderer. | — | no | — |
| OAuthButton | `components/oauth-button.tsx` | OAuth provider button (GitHub octocat etc.). | provider, mode, onClick, disabled, className | no | — |
| PierreFileTree | `components/pierre-file-tree.tsx` | Large repository file tree (Pierre). | paths, gitStatus, path, status, selectedPaths, focusedPath | no | — |
| Pill | `components/pill.tsx` | Status lozenge with optional leading dot. One line by construction (nowrap, shrink-0). | children, dot, pulse, className, title | yes | #361 (1.3) |
| ProviderIcon | `components/provider-icon.tsx` | Brand marks for agent providers (Claude, Codex…); providerLabel/providerColor helpers. | — | no | — |
| ProviderSignedOutCard, ProviderResumeCard, ProviderLimitBanner, ProviderAccountChoice | `composites/provider-recovery-cards.tsx` | Chat recovery states: signed-out Reconnect, Resume run, "Limited until HH:MM" banner, signed-in account radio choice. | title, message, limit, accounts, onUse | yes | #419 (5.13) |
| ResizeHandle | `components/resizable.tsx` | ResizeHandle for persisted drag-resizable widths. | — | no | — |
| SearchField (alias SearchInput) | `components/search-input.tsx` | 32px search field: leading magnifier, clear button, Esc clears, optional count and kbd hint. | value, onChange, placeholder, kbd, count | yes | #367 (2.2) |
| FilterChips | `components/filter-chips.tsx` | Single-select row of one-line chips with counts; radiogroup, ←/→/Enter. | options, value, onChange, ariaLabel | yes | #367 (2.2) |
| SegmentedControl | `components/segmented-control.tsx` | 28px segmented control (24px at size sm); active segment on the surface token; arrow keys move selection. | items, value, onChange, size, fullWidth, aria-label | yes | #368 (2.3) |
| SelectGroup, SelectLabel | `components/select.tsx` | SelectGroup / SelectLabel re-exports over the BeUI Select. | — | no | — |
| SignalBars | `components/signal-bars.tsx` | Ascending signal-strength bars. | — | no | — |
| Spin | `components/spin.tsx` | Box carrying a looping keyframe spin for icons. | active, animation, className, children | no | — |
| StatusDot | `components/status-dot.tsx` | Status dot, optionally glowing / pulsing. | status, tone, size, glow, pulse, className | yes | #362 (1.4) |
| StatusRow, Stepper | `components/status-row.tsx` | Neutral status line (red only when failed); numbered done/current/upcoming stepper with aria-current. | icon, failed, steps, current | yes | #370 (2.5) |
| NeedsSignInRow | `components/needs-sign-in-row.tsx` | MCP import-review row for an OAuth server: host + "Sign in after import" (StatusRow styling). | host | yes | #487 (10.8) |
| NeedsSecretsRow | `components/needs-secrets-row.tsx` | MCP import-review row for a candidate missing an env/header secret value (StatusRow styling). | — | yes | #487 (10.8b) |
| McpImportResult | `composites/mcp-import-result.tsx` | MCP import result step: neutral rows; Connect on needs-auth, red `Failed to start` + View log on failed. | rows, onConnect, onViewLog | yes | #488 (10.9) |
| ConflictBadge | `components/conflict-badge.tsx` | MCP import-review badge for a name clash with an existing server: "Conflict" tag + Keep mine / Replace / Keep both (SegmentedControl). Read-only (no `onChange`) until `Mcp.applyImport` accepts a resolution. | value, onChange | yes | #487 (10.8b) |
| SettingsCard, SettingsRow | `components/settings-row.tsx` | Bordered card of rows; row = label + wrapping help left, fixed control right. | title, label, help, control | yes | #372 (2.7) |
| Toast, ToastRegion | `components/toast.tsx` | Bottom-right notification stack (success, error + Retry, Needs you + Jump, info); queue, 6 s timeout and hover-pause live in `components/toast-machine.ts`. | variant, title, description, action, onDismiss | yes | #369 (2.4) |
| VirtualList | `components/virtual-list.tsx` | Windowed, searchable list with fixed row height: only visible rows mount, ↑/↓/Home/End move the active row and scroll it into view, Enter selects, sticky group headers, selection kept while the `query` filters. | items, getKey, getText, getGroup, renderRow, onSelect, query, activeKey, onActiveKeyChange | yes | #377 (2.12) |
| Toggle | `components/toggle.tsx` | Switch toggle. | checked, defaultChecked, onCheckedChange, disabled, label, ariaLabel | yes | #372 (2.7) |
| Tooltip | `components/tooltip.tsx` | Tooltip (BeUI Tooltip). | — | no | #374 (2.9) |
| Toggle | `components/toggle.tsx` | Switch toggle. | checked, defaultChecked, onCheckedChange, disabled, label, ariaLabel | yes | #372 (2.7) |
| Tooltip | `components/tooltip.tsx` | Tooltip (BeUI Tooltip); optional `shortcut` renders a KbdChip. | — | no | #374 (2.9) |

## Atoms — BeUI base

Vendored BeUI primitives; the Jingler atoms above wrap them. Import the Jingler wrapper, not these, unless building a new atom.

| Component | File | Purpose | Key props | Story | Redesign |
|---|---|---|---|---|---|
| ActionSwapText | `components/beui/action-swap.tsx` | Text that swaps between two labels. | value, children, animation, className | no | — |
| ActionSwapRollText | `components/beui/action-swap-roll.tsx` | Text that rolls between two labels. | — | no | — |
| AgentCodeLine, AgentCode | `components/beui/agent-code.tsx` | Agent code line / block display. | code, language, className | no | — |
| AgentDisclosure | `components/beui/agent-disclosure.tsx` | Transform-only reveal for collapsible agent content. | open, openHeight | no | — |
| AnimatedBadge | `components/beui/animated-badge.tsx` | Animated badge base for Badge. | status, size, children, icon, showIcon, pulse | no | — |
| CodeBlock | `components/beui/code-block.tsx` | Syntax-highlighted code block. | code, language, filename, fileIcon, status, showLineNumbers | no | — |
| ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuCheckboxItem, ContextMenuRadioGroup, ContextMenuRadioItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuShortcut | `components/beui/context-menu.tsx` | BeUI context menu (item, checkbox, radio, label, separator). | children, open, defaultOpen, onOpenChange, className | no | — |
| MotionTabs | `components/beui/controls.tsx` | MotionTabs: BeUI Tabs behind SegmentedControl. | — | no | — |
| — | `components/beui/feedback.tsx` | BeUI feedback helpers. | — | no | — |
| FileDiff | `components/beui/file-diff.tsx` | Inline file diff. | file, fileIcon, lines, status, open, defaultOpen | no | — |
| Loader | `components/beui/loader.tsx` | BeUI loader. | variant, size, speed, label, className | no | — |
| SharedLayoutIndicator, PreviewRail, Dock | `components/beui/overlays.tsx` | SharedLayoutIndicator, PreviewRail (timeline rail: item `kind` ticks amber needs-you / red failed / blue checkpoint, `meta` caption, `renderActions` interactive hover card), Dock. | items, label, activeId, defaultActiveId, onActiveChange, onItemSelect | no | — |
| MorphPopover, MorphPopoverTrigger, MorphPopoverContent | `components/beui/popover-morph.tsx` | Popover whose panel morphs from the trigger corner. | children, open, defaultOpen, onOpenChange, anchorRef, interactionRef | no | — |
| Select, SelectTrigger, SelectValue, SelectSearch, SelectContent, SelectItem | `components/beui/select.tsx` | BeUI Select with search. | value, defaultValue, onValueChange, open, defaultOpen, onOpenChange | yes | — |
| ToolResultOutput, ToolResult | `components/beui/tool-result.tsx` | Tool result output block. | tool, title, children, status, kind, meta | no | — |
| Tooltip | `components/beui/tooltip.tsx` | BeUI tooltip. | content, children, side, delay, className, wrapperClassName | no | — |

## Molecules and organisms — composites

| Component | File | Purpose | Key props | Story | Redesign |
|---|---|---|---|---|---|
| AddProjectDialog | `composites/add-project-dialog.tsx` | Add a project (repo) dialog. | open | yes | — |
| AgentCard | `composites/agent-card.tsx` | Agent card: file target, tokens, status line; done/stopped are neutral icon rows, failed is a red icon + reason + Resume / View transcript. | file, state, tokens, status, reason, onResume, onViewTranscript | yes | #466 (8.7) |
| AgentsResourceList | `composites/agents-resource-list.tsx` | Searchable, windowed list of imported agents & skills: search, All/Agents/Skills + source chips with counts, per-row enable toggle, reveal and remove. | resources, query, kind, source, onQueryChange, onKindChange, onSourceChange | no | #494 (10.15) |
| AgentsSettings | `composites/agents-settings.tsx` | Settings › Agents & skills. | resources, models, modelAssignments, delegationEnabled, detection, selectedCandidateIds | no | #494 (10.15) |
| ApprovalGate | `composites/approval-gate.tsx` | Human-in-the-loop approval gate for tool calls. | — | yes | — |
| ArchivedBanner | `composites/archived-banner.tsx` | Read-only banner for archived sessions (Restore / Delete). | reason, prNumber, base, onRestore, onDelete | no | #376 (2.11) |
| AuthCard | `composites/auth-card.tsx` | Sign-in card chrome: brand mark, heading, tinted background. | title, subtitle, children, className | yes | — |
| BackgroundTaskDock, BackgroundTaskOutput | `composites/background-task-dock.tsx` | Dock of background tasks with output viewer. | — | no | — |
| UnreachableBanner | `composites/unreachable-banner.tsx` | Top hairline notice when the auth server can't be reached: app stays usable, Retry re-checks. | onRetry | yes | #538 (15.4) |
| BranchDriftBanner | `composites/branch-drift-banner.tsx` | Banner when the shared checkout drifted off the pinned branch. | — | no | #376 (2.11) |
| ImportSessionsList | `composites/import-sessions-list.tsx` | Import step: sessions found in other apps, grouped by source, searchable, multi-select with Import / Skip. | candidates, status, error, query, selected, onToggle, onImport, onSkip, onRetry | yes | #613 (16.5) |
| OmittedFilesNotice, ExplorerPanel, ChangedFilesExplorer, ReviewFileDiff, ReviewSidebar | `composites/changes-review.tsx` | Changes review: explorer, file diff, sidebar, omitted-files notice. | branch, worktreePath, filter, onFilterChange, localAvailable, prAvailable | yes | — |
| PrFilter | `composites/pr-filter.tsx` | "PR: #481 ▾" select narrowing the Changes explorer to one layer of a PR stack. | layers, value, onChange | yes | #427 (6.5) |
| CommandMenu | `composites/command-menu.tsx` | `/` command palette: Commands / Skills groups, match highlight, keyboard footer. | skills, activeIndex, query, onSelect, onHover | yes | #407 (5.1) |
| CheckoutSwitcher | `composites/checkout-switcher.tsx` | Session header: active `repo · branch` menu and per-checkout PR chips for a multi-repo session. Renders nothing for one checkout. | — | yes | #670 |
| Composer | `composites/composer.tsx` | Prompt composer: input, chips, attachments, send/stop. | skills, files, onAddMcp, mcpServers, onSetMcpApiKey, onSetMcpAuth | yes | — |
| ContextDivider | `composites/context-divider.tsx` | Transcript divider marking context compaction. | — | yes | — |
| ContextMeter | `composites/context-meter.tsx` | Neutral usage ring around the composer send button (red only when compaction stalled); click opens a popover with the breakdown, status/progress and `Compact now`. | tokens, breakdown, triggerAt, phase, preparing, digestReady, onCompactNow, children | yes | #410 (5.4) |
| DiscardCommentsDialog | `composites/discard-comments-dialog.tsx` | "Discard N unsaved comment(s)?" ConfirmDialog (destructive) shown before Approve, Request changes or closing the Plan tab with drafts. | open, count, onOpenChange, onDiscard | yes | #452 (7.3) |
| DiscardFileMenu | `composites/discard-file-menu.tsx` | Right-click a file row → "Discard file changes" → ConfirmDialog (danger). Wraps a Pierre tree. | paths, onDiscard | yes | #424 (6.2) |
| PairingSheet | `composites/pairing-sheet.tsx` | 480px Drawer wizard to pair an owned machine: host + SSH suggestions -> "Installing device agent…" step -> "Paired ✓", or the failing step with its error as a log tail and Retry. | open, state, values, hosts, environment, error, onRetry | yes | #493 (10.14) |
| InlineCommentComposer | `composites/inline-comment-composer.tsx` | Inline comment box anchored under a diff range. | — | no | — |
| IssueInbox | `composites/issue-inbox.tsx` | Global GitHub issue list with detail pane. | issues, viewerLogin, warnings, onActivate, onRefresh, refreshing | yes | — |
| IssuePickerList, IssueLabelChip | `composites/issue-picker-list.tsx` | Open-issue results list for new-session-from-issue; IssueLabelChip. | — | yes | — |
| LinkedIssueSelector | `composites/linked-issue-selector.tsx` | Pick the issue linked to a workspace. | items, value, onValueChange, icon, variant, disabled | yes | — |
| MagicLinkForm | `composites/magic-link-form.tsx` | Email magic-link input and submit. | state, mode, email, name, sentEmail, onEmailChange | yes | — |
| McpServerForm, McpServerDialog, McpAuthSetupDialog, McpApiKeyDialog, McpBrand, McpSettings | `composites/mcp-settings.tsx` | Settings › MCP servers with forms and auth dialogs. | servers, parseError, loading, statuses, probing, probe | no | — |
| McpServerDetailDialog, ToolCount, LogTail, OAuthRow | `composites/mcp-server-detail-dialog.tsx` | One server's detail: reported tool count, refreshed log tail, "OAuth · Signed in as …" row. | server, open, toolCount, logLines, logLoading, oauthAccount | yes | #486 |
| MentionMenu | `composites/mention-menu.tsx` | `@` file mention palette on VirtualList: Files header, match highlight, middle-truncated paths, keyboard footer, "No matches for “query”". | files, activeIndex, query, onSelect, onHover | yes | #377 (2.12), #407 (5.1) |
| AutocompleteMenu | `composites/autocomplete-menu.tsx` | Graphite popover shell shared by the `@` and `/` menus: trigger/query header, keyboard footer, No-matches state. | trigger, query, empty | yes | #407 (5.1) |
| HighlightMatch | `components/highlight-match.tsx` | Emphasises the first case-insensitive match of a query inside text. | text, query | yes | #407 (5.1) |
| PlanProgressContext, ToolStopContext, SubagentEntryContext, MessageTurn | `composites/message-turn.tsx` | One transcript turn: text, tool calls, thinking. | — | yes | — |
| ModeSwitch | `composites/mode-switch.tsx` | Plan/Build and permission-mode switch. | — | yes | — |
| NativeEndpointLogin | `composites/native-endpoint-login.tsx` | Sign-in against a native endpoint. | — | no | — |
| NewWorkspaceView | `composites/new-workspace-view.tsx` | New workspace screen: composer, chips, Start-from list. | open, projects, environments, providerCatalog, agentEndpointCatalog, defaultConnectionId | yes | — |
| PhaseNode | `composites/phase-node.tsx` | Workflow phase node. | — | yes | — |
| PlanApprovalCard, PlanCard | `composites/plan-card.tsx` | Plan card and approval card in the transcript. | — | yes | — |
| PlanChangeBlock, PlanRevisionDiff | `composites/plan-change-block.tsx` | Proposed per-file diff in a plan. | path, patch | no | — |
| PlanCommentLayer | `composites/plan-comment-layer.tsx` | Floating 20px Avatar per plan comment thread at its anchored line (agent = Jingler mark, reply-count badge, −6px stacking); hover/focus opens the 320px thread card, click pins, Esc closes; hovered range tinted stronger. | container, content, comments, editable, onReply, onResolve | no | #453 (7.4) |
| PlanTaskList, PlanProgressDock, PlanProgressRow | `composites/plan-progress-dock.tsx` | Plan task list / progress dock; neutral icon rows, failed row red with `Step N failed` + `Retry step` / `Ask agent`, interrupted `Stopped by you` + `Resume`, blocked line. | document, onOpenStage, onStageAction | yes | #454 (7.5) |
| PlanStageCard | `composites/plan-stage-card.tsx` | Plan stage card with SCM-style change letters. | stage, number, stages, onComment | no | — |
| STEP, PlanStepList | `composites/plan-step-list.tsx` | Legacy plan step list. | — | no | — |
| PluginsSettings | `composites/plugins-settings.tsx` | Settings › Plugins. | catalog, loadErrors, pluginIcons, actionError, onDismissActionError, onSetEnabled | no | — |
| PrCheckRow | `composites/pr-check-row.tsx` | One CI check row. | — | no | — |
| PrStackRail | `composites/pr-stack-rail.tsx` | Checks-tab stack rail (Graphite style): h36 layer rows joined by a 1px line, base first, selected layer marked neutrally. | layers, selected, onSelect | yes | #431 (6.9) |
| PrSwitcher | `composites/pr-switcher.tsx` | Header stack switcher `PR #482 ▾ 2/3`: base-up menu, merged layers dimmed with a tick; ⌥[ / ⌥] step down/up. | layers, selected, onSelect, onStep | yes | #431 (6.9) |
| PrStatusGlyph | `composites/pr-glyph.tsx` | PR state glyph (PrStatusGlyph). | — | yes | #381 (2.16) |
| PrPickerList | `composites/pr-picker-list.tsx` | Open-PR results list for new-session-from-PR. | — | yes | — |
| PrReviewComposer | `composites/pr-review-composer.tsx` | Sticky PR review composer. | — | no | — |
| PrReviewGroup | `composites/pr-review-group.tsx` | Group of review threads from one review. | — | no | — |
| PrReviewThreadView | `composites/pr-review-thread.tsx` | Inline review thread with reply/resolve. | — | no | — |
| MergeSplitButton | `composites/merge-split-button.tsx` | `Squash and merge ▾` split button: merge, squash or rebase; choice remembered; disabled with the first blocker as tooltip; `mergeError` shown under it. | connected, onMerge, merging, blockedReason, mergeError | yes | #435 (6.13) |
| PrSidePanel | `composites/pr-side-panel.tsx` | PR right rail: reviewers, checks, merge box. | pr, connected, onMerge, merging, mergeError, onClosePr | no | — |
| WorkflowSection | `composites/workflow-section.tsx` | Collapsible Workflow section for the Checks rail: one-row summary, expands to setup retry/skip and run/stop, mirroring the conversation workflow bar. | lifecycle, commands, runs, error, onRetrySetup, onSkipSetup, onStartRun, onStopRun, onArchiveWithoutCleanup | yes | #437 (6.15) |
| PrTimelineEntry | `composites/pr-timeline-entry.tsx` | PR timeline entry. | — | no | — |
| ProjectWorkflowSettings | `composites/project-workflow-settings.tsx` | Per-project workflow settings. | projects, loading, routines | yes | — |
| ProviderAuthForms | `composites/provider-auth-forms.tsx` | Credential entry for provider auth. | busy, mode, authKinds, apiProviderId, pendingAuthKind, onConnectClaude | no | — |
| ProviderConnectionsSettings | `composites/provider-connections-settings.tsx` | Settings › Providers accounts. | catalog, nativeEndpointLogin, endpointCatalog, defaultConnectionId, defaultModelId, busy | no | — |
| ProviderModelBrowser | `composites/provider-model-browser.tsx` | Model browser grouped by provider. | — | no | — |
| PullRequestInbox, InboxFilterSelect, InboxMessage | `composites/pull-request-inbox.tsx` | Global PR list with read-only detail. | prs, teamControls, teams, teamId, queue, onTeam | yes | — |
| PullRequestView | `composites/pull-request-view.tsx` | Pull Request tab: header, timeline, composer. | pr, connected, connectionMessage, connectionActionLabel, busy, viewerLogin | yes | — |
| QuestionCard | `composites/question-card.tsx` | Docked AskUserQuestion card. | — | yes | — |
| QuestionSummary | `composites/question-summary.tsx` | Answered-question record in the transcript. | — | no | — |
| QueuedMessageRow | `composites/queued-message-row.tsx` | Queued composer message with send-now / hand-off / edit / remove icons. | text, images, onSendNow, onHandoff, onEdit, onRemove | no | — |
| RepoPicker | `composites/repo-picker.tsx` | Repo picker for new workspace. | — | no | — |
| ReviewCodeView | `composites/review-code-view.tsx` | Code Review diff view. | entries, selection, scrollRequest, drafts, reviewThreads, findingsByPath | no | — |
| ReviewFileRail | `composites/review-file-rail.tsx` | Review file rail. | — | yes | — |
| TurnFilter, reviewTurnsOf, narrowToTurn | `composites/turn-filter.tsx`, `composites/review-turns.ts` | "All turns ▾" select over the agent turns that changed files; narrowToTurn narrows the file list and diff. | turns, value, onChange | yes | #423 (6.1) |
| ReviewFileTree | `composites/review-file-tree.tsx` | Review file tree. | files, activePath, statusByPath, query, onSelectFile | no | — |
| ReviewFindingRow, ReviewFindings | `composites/review-findings.tsx` | Review findings list and rows. | finding, sent, canRoute, review, onSendToAgent | yes | — |
| ReviewTray | `composites/review-tray.tsx` | Pending inline comments tray. | — | yes | — |
| RoutinesSettingsView | `composites/routines-settings-view.tsx` | Settings › Routines. | templates, template, templateLoad, projects, projectId, models | yes | — |
| RunStats | `composites/run-stats.tsx` | Live run elapsed time. | — | no | — |
| RuntimeInspector | `composites/runtime-inspector.tsx` | Settings › Runtime inspector. | snapshot, loading, exported, error, onRefresh, onExport | no | — |
| RuntimeRecoveryCard | `composites/runtime-recovery-card.tsx` | Actionable runtime recovery card. | label, kind, title, message, icon, detail | no | #376 (2.11) |
| SessionHoverCard | `composites/session-hover-card.tsx` | Hover card for a sidebar session row. | — | no | — |
| SessionRow | `composites/session-row.tsx` | Sidebar session row. | — | no | #381 (2.16) |
| SettingsDialog | `composites/settings-dialog.tsx` | Settings dialog shell. | — | no | — |
| SettingsView, DevicesSection | `composites/settings-view.tsx` | Full settings page; DevicesSection. | key, label, icon, ready | yes | — |
| SignInDialog | `composites/sign-in-dialog.tsx` | Optional sign-in dialog from the sidebar footer: a standard dialog panel hosting the flattened auth card, every LoginState. | open, onOpenChange | yes | #517 (13.7) |
| SlashCommandRow | `composites/slash-command-row.tsx` | Row in the slash-command palette. | — | yes | — |
| StreamingText | `composites/streaming-text.tsx` | Markdown-preserving streaming text. | — | yes | — |
| ThemesSettings | `composites/themes-settings.tsx` | Settings › Themes. | themes, skipped, activeId, onSelect, onDuplicate, onDelete | no | — |
| ThoughtBlock | `composites/thought-block.tsx` | Agent reasoning line in the transcript. | — | yes | — |
| ToolCall | `composites/tool-call.tsx` | Tool-call row with collapsible output. | status, name, target, meta, filePath, children | yes | — |
| UsageLimits | `composites/usage-limits.tsx` | Limits-only usage summary in the account menu: neutral row per provider limit window (`Limited until 16:40`, no status fills) plus a labelled-placeholder relay quota row. | usage, loading | yes | #501 (11.1) |
| ModelDetailDrawer | `composites/model-detail-drawer.tsx` | Per-model drill-down opened from a ModelPerformanceTable row: aggregate stats, duration sparkline, slowest runs (run ids only; not yet linked to turns). Built on Drawer. | open, detail, onOpenChange | yes | #503 (11.3) |
| UsageModal | `composites/usage-modal.tsx` | Usage & limits modal. | — | no | — |
| UserMenu | `composites/user-menu.tsx` | Account menu; embeds UsageLimits (refreshes usage on open) above Settings / Usage & limits. | user, usage, onLoadUsage, onOpenSettings, onOpenUsage, onSignOut, onSignIn, ghConnected, whatsNew | yes | — |
| VisualBlocks | `composites/visual-blocks.tsx` | Structured visual blocks for plans and explanations. | blocks, className | no | — |
| VisualCallPathDiff | `composites/visual-call-path.tsx` | Call-path diff visual. | — | no | — |
| WebSearchSettings | `composites/web-search-settings.tsx` | Settings › Web search. | status, loading, busy, error, onSave, onClear | yes | — |

## Molecules and organisms — app shell

| Component | File | Purpose | Key props | Story | Redesign |
|---|---|---|---|---|---|
| DropZoneOverlay, resolveDropEdge | `app/drop-zone-overlay.tsx` | Drag-to-split overlay for an editor group: five labelled zones (left, right, top, bottom, centre) in the `--sb-brand` tint, hovered zone filled and outlined; `resolveDropEdge` maps pointer position to a zone. | edge, rejected, zones | yes | #402 (4.7) |
| PeerAgentRow | `app/agent-roster.tsx` | One peer agent row in the SubagentChip popover: status, task, touched files, ghost `Message` button with inline send box. | agent, onMessage | no | #465 (8.6) |
| AppShell | `app/app-shell.tsx` | Window frame: title bar plus routed content. | — | no | — |
| HeaderViewButtons | `app/header-view-buttons.tsx` | Pinned view launchers in the workspace header (Changes N, Checks a/b, Terminal, Browser); neutral pressed state, one-line count badges, shortcut tooltips. | views, activeId, onOpen | yes | #383 (3.1) |
| ViewOverflowMenu | `app/view-overflow-menu.tsx` | ⋯ menu listing every view and plugin view, each with "Pin to header"; a sixth pin is refused with a tooltip. | views, pinned, onOpen, onPinnedChange | yes | #383 (3.1) |
| ChatTabBar | `app/chat-tab-bar.tsx` | Chat tab strip. | chats, closedChats, activeChatId, onSelectChat, onCreateChat, onRenameChat | yes | — |
| ChatLaneHeader | `app/chat-lane-header.tsx` | Thread switcher dropdown, new chat, and follow-agent toggle replacing the chat tab strip in redesign 4.3. | chats, activeChatId, onSelectChat, onCreateChat, followAgent, onToggleFollowAgent | yes | #398 (4.3) |
| ArchivedList, ArchivedEntry | `app/archived-list.tsx` | Sidebar "Archived (N)" entry opening a searchable Dialog of archived workspaces, each with Restore and a destructive Delete (caller confirms with ConfirmDialog). | open, onOpenChange, sessions, onRestore, onDelete | yes | #513 (13.3) |
| ChatDrawer | `app/chat-drawer.tsx` | Narrow-window (<1100px) chat lane: 400px overlay on the content area only (never the sidebar or rail), scrim, Esc/scrim close, focus returns to opener. Built on Drawer. | open, onOpenChange, container | yes | #400 (4.5) |
| PALETTE, CommandPalette | `app/command-palette.tsx` | Global ⌘K palette. | — | yes | — |
| ConversationView | `app/conversation-view.tsx` | Chat transcript, composer and queue. | messages, hasMoreHistory, loadingHistory, onLoadEarlier, mode, skills | no | — |
| DiffPanel | `app/diff-panel.tsx` | Right-hand worktree diff rail. | — | no | — |
| EditorGroups | `app/editor-groups.tsx` | Split tree of editor groups. | onOpenCheckpoints, sessionId, layout, revision, describe, renderBody | no | — |
| JinglerApp | `app/jingler-app.tsx` | Top-level app composition. | onOpenCheckpoints, sessions, user, update, releaseNotes, onSignOut | yes | — |
| PreviewDock, PreviewToggleButton | `app/preview-dock.tsx` | Browser preview dock and toggle: IconButtonGroup nav (back · forward · reload · open external; back/forward disabled without history), URL field, device-width group, loading spin, load-error InlineError with Retry. ⌘⇧B toggles. | embedded, dock, onDockChange, visible, onToggle, url, canGoBack, canGoForward, onBack, onForward, onOpenExternal, loading, error | yes | #468 (8.9) |
| ProjectSidebar | `app/project-sidebar.tsx` | 56px project rail. | — | no | — |
| SessionPrsChip | `app/session-prs-chip.tsx` | Header chip for a session's open PRs, main + subagents: `PRs · N ▾`; popover row shows PR number, owning agent, branch (mono), state word; row opens that PR's view. | rows, onSelect | yes | #561 (6.28) |
| SessionSidebar | `app/session-sidebar.tsx` | Sessions and Explorer sidebar. | search, workspaceView, forceCollapsed, expandRequest, onWorkspaceViewChange, explorer | yes | — |
| SessionSplit | `app/session-split.tsx` | Chat + content split layout. | onOpenCheckpoints, group, sessions, emptyState, renderConversation, session | no | — |
| SessionTree | `app/session-tree.tsx` | Session chats, views and open files tree. | — | no | — |
| PluginPaneState | `app/plugin-pane-state.tsx` | Plugin dock pane states: loading skeleton, empty, and crashed (message + Retry) on EmptyState/ListSkeleton. | variant, pluginId, message, onRetry | yes | #521 (13.11) |
| SubagentTabBar | `app/subagent-tab-bar.tsx` | Subagent chip strip. | — | no | — |
| SubagentChip | `app/subagent-chip.tsx` | Lane-header `N subagents ▾` chip; popover lists running children then a `Done (N)` group, then `Peers · N` with a Message button per peer; row shows child branch (mono, truncates first), `+N −N` and PR number, or `Shared checkout`; row opens that child. | subagents, onOpenSubagent, peers, onMessagePeer | yes | #460 (8.1) |
| SubagentMetaStrip | `app/subagent-meta-strip.tsx` | Up to 4-row strip under the subagent breadcrumb: provider, model, status · phase, elapsed, `Details ▾` key/value grid (run id, started), current tool, usage, Background pill, worktree branch (or `Shared checkout`) + diff stat + PR chip that opens the PR view, artifact chips. Null fields omitted; pills never truncate. | node, providerId, onOpenArtifact, onOpenPullRequest | yes | #462 (8.3) |
| SubagentReadOnlyBar | `app/subagent-readonly-bar.tsx` | Replaces the composer in a subagent view: `Subagent of <main> · read-only` + Stop (pending then stopped line); attention message + Reply; terminal summary + Retry. | node, mainTitle, onStop, onReply, onRetry | yes | #462 (8.3) |
| AgentView, FleetAgentView | `app/subagent-view.tsx` | Read-only child agent transcript. | node, messages, providerId, loading, error, controlOutcome | no | — |
| TabBar | `app/tab-bar.tsx` | Content tab strip. | — | yes | — |
| TerminalDock, TerminalPanel | `app/terminal-panel.tsx` | Terminal dock, and the Terminal view's resizable panel (drag handle default 240, height persisted per session, tab strip, "No terminals" empty state, exited shell Restart). | dock, onDockChange, visible, onToggle, tabs, activeId; panel: sessionId, tabs, activeId, onNew, onRestart | yes | #469 (8.10) |
| TitleBar | `app/title-bar.tsx` | Window title bar; draws WindowControls when platform is set and not darwin. | title, actions, platform, windowControls | yes | #394 (3.11) |
| WindowControls | `app/window-controls.tsx` | Minimize / maximize-restore / close for Windows and Linux; red hover on Close only. | maximized, onMinimize, onToggleMaximize, onClose | yes | #394 (3.11) |
| TitleSearch | `app/title-search.tsx` | Global sidebar search. | — | no | — |

## Planned (not built yet)

Epic 2 (#365). Build in this order; each is its own PR into `epic/redesign`, and views wait on it.

| Component | Replaces / extends | Issue |
|---|---|---|
| ListSkeleton, EmptyState, InlineError | `Skeleton`, `InlineStatus` | #371 (2.6) |
| VirtualList (searchable) | none (new) | #377 (2.12) |
| SessionRow / PrGlyph stack slot | `SessionRow`, `PrStatusGlyph` | #381 (2.16) |

Token and button rules that every atom follows: #359 (1.1 Graphite palette), #360 (1.2 neutral primary Button), #361 (1.3 one-line Badge/Pill/Kbd).
