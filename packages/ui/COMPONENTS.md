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
| Avatar | `components/avatar.tsx` | User avatar image from a GitHub login. | — | yes | #378 (2.13) |
| Badge | `components/badge.tsx` | Status / count badge (BeUI AnimatedBadge). One line by construction (nowrap, shrink-0). | children, tone, size, className, title | yes | #361 (1.3) |
| Button | `components/button.tsx` | Base button: primary, secondary, ghost, destructive. | children, pressScale, ripple | yes | #360 (1.2) |
| ButtonGroup | `components/button-group.tsx` | Joined group of buttons. | — | no | #366 (2.1) |
| Callout | `components/callout.tsx` | Inline notice with a leading glyph and tone. | children, glyph, className | no | #376 (2.11) |
| Card, CardHeader | `components/card.tsx` | Bordered panel surface (Card, CardHeader). | — | no | — |
| Checkbox | `components/checkbox.tsx` | Checkbox. | checked, onCheckedChange, indeterminate, label, tone | yes | — |
| ChipMenu | `components/chip-menu.tsx` | Compact Command picker anchored to a composer control. | — | no | — |
| CodeChip | `components/code-chip.tsx` | Rendered code reference chip (file, range). One line; label truncates. | — | no | — |
| Command, CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator, CommandShortcut | `components/command.tsx` | cmdk primitives: Command, CommandDialog, Input, List, Item… | — | yes | — |
| ConfirmDialog | `components/confirm-dialog.tsx` | Yes/no modal for destructive or irreversible actions. | — | no | #375 (2.10) |
| ContextMenu | `components/context-menu.tsx` | Right-click menu. | — | yes | — |
| Dialog, DialogTrigger, DialogPortal, DialogClose, DialogOverlay, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription, DialogBody | `components/dialog.tsx` | Modal dialog primitives (Dialog, Header, Body, Footer…). | — | no | #373 (2.8) |
| DiffPeek | `components/diff-peek.tsx` | Single-file diff peek, virtualised for large patches. | — | no | — |
| DiffStat | `components/diff-stat.tsx` | Added/removed line counts (+313 −23). | — | no | — |
| Eyebrow, ClaudeGlyph | `components/eyebrow.tsx` | Uppercase tracked section label; ClaudeGlyph. | — | yes | — |
| InlineStatus, IndeterminateBar | `components/feedback.tsx` | InlineStatus message and IndeterminateBar. | — | yes | #371 (2.6) |
| FileChangeList | `components/file-change-list.tsx` | List of changed files with on-demand per-file diffs. | — | no | — |
| FileChip | `components/file-chip.tsx` | Inline file link with Material icon and diff evidence. | path, added, removed, onOpen, className, children | yes | — |
| FileIcon | `components/file-icon.tsx` | Material Icon Theme glyph chosen from a file name. | — | no | — |
| FilterMenu | `components/filter-menu.tsx` | Menu of filter axes, each opening a value flyout. | — | no | — |
| GithubMark | `components/github-mark.tsx` | GitHub octocat mark. | — | no | — |
| HoverCard | `components/hover-card.tsx` | Detail popover opening on hover intent and focus. | — | no | #374 (2.9) |
| HtmlPreview | `components/html-preview.tsx` | Opt-in preview for an html fenced block in agent output. | — | yes | — |
| Input | `components/input.tsx` | Plain text field (BeUI Input geometry). | — | no | — |
| Kbd | `components/kbd.tsx` | Monospace keyboard chip; onFill variant for primary surfaces. One line (nowrap, shrink-0). | — | yes | #361 (1.3), #374 (2.9) |
| LinearMark | `components/linear-mark.tsx` | Linear logo mark. | — | no | — |
| ThinkingOrb, Spinner, Skeleton | `components/loading.tsx` | ThinkingOrb, Spinner and Skeleton. | — | yes | #371 (2.6) |
| ListSkeleton, EmptyState, InlineError | `components/feedback.tsx` | List loading rows at real height, empty state with next action, load error with Retry. | rows, rowHeight, title, action, message, onRetry | yes | #371 (2.6) |
| Markdown | `components/markdown.tsx` | Markdown renderer with math (KaTeX) and code. | — | no | — |
| MermaidDiagram | `components/mermaid-diagram.tsx` | Mermaid diagram renderer. | — | no | — |
| OAuthButton | `components/oauth-button.tsx` | OAuth provider button (GitHub octocat etc.). | provider, mode, onClick, disabled, className | no | — |
| PierreFileTree | `components/pierre-file-tree.tsx` | Large repository file tree (Pierre). | paths, gitStatus, path, status, selectedPaths, focusedPath | no | — |
| Pill | `components/pill.tsx` | Status lozenge with optional leading dot. One line by construction (nowrap, shrink-0). | children, dot, pulse, className, title | yes | #361 (1.3) |
| ProviderIcon | `components/provider-icon.tsx` | Brand marks for agent providers (Claude, Codex…); providerLabel/providerColor helpers. | — | no | — |
| ResizeHandle | `components/resizable.tsx` | ResizeHandle for persisted drag-resizable widths. | — | no | — |
| SearchInput | `components/search-input.tsx` | Search / filter input with leading magnifier. | — | no | #367 (2.2) |
| SegmentedControl | `components/segmented-control.tsx` | Segmented control (BeUI segment Tabs). | — | no | #368 (2.3) |
| SelectGroup, SelectLabel | `components/select.tsx` | SelectGroup / SelectLabel re-exports over the BeUI Select. | — | no | — |
| SignalBars | `components/signal-bars.tsx` | Ascending signal-strength bars. | — | no | — |
| Spin | `components/spin.tsx` | Box carrying a looping keyframe spin for icons. | active, animation, className, children | no | — |
| StatusDot | `components/status-dot.tsx` | Status dot, optionally glowing / pulsing. | status, tone, size, glow, pulse, className | yes | #362 (1.4) |
| Toggle | `components/toggle.tsx` | Switch toggle. | checked, defaultChecked, onCheckedChange, disabled, label, ariaLabel | yes | #372 (2.7) |
| Tooltip | `components/tooltip.tsx` | Tooltip (BeUI Tooltip). | — | no | #374 (2.9) |

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
| SharedLayoutIndicator, PreviewRail, Dock | `components/beui/overlays.tsx` | SharedLayoutIndicator, PreviewRail (timeline rail), Dock. | items, label, activeId, defaultActiveId, onActiveChange, onItemSelect | no | — |
| MorphPopover, MorphPopoverTrigger, MorphPopoverContent | `components/beui/popover-morph.tsx` | Popover whose panel morphs from the trigger corner. | children, open, defaultOpen, onOpenChange, anchorRef, interactionRef | no | — |
| Select, SelectTrigger, SelectValue, SelectSearch, SelectContent, SelectItem | `components/beui/select.tsx` | BeUI Select with search. | value, defaultValue, onValueChange, open, defaultOpen, onOpenChange | yes | — |
| ToolResultOutput, ToolResult | `components/beui/tool-result.tsx` | Tool result output block. | tool, title, children, status, kind, meta | no | — |
| Tooltip | `components/beui/tooltip.tsx` | BeUI tooltip. | content, children, side, delay, className, wrapperClassName | no | — |

## Molecules and organisms — composites

| Component | File | Purpose | Key props | Story | Redesign |
|---|---|---|---|---|---|
| AddProjectDialog | `composites/add-project-dialog.tsx` | Add a project (repo) dialog. | open | yes | — |
| AgentCard | `composites/agent-card.tsx` | Running-agent card: file target, tokens, status line. | — | yes | — |
| AgentsSettings | `composites/agents-settings.tsx` | Settings › Agents & skills. | resources, models, modelAssignments, delegationEnabled, detection, selectedCandidateIds | no | — |
| ApprovalGate | `composites/approval-gate.tsx` | Human-in-the-loop approval gate for tool calls. | — | yes | — |
| ArchivedBanner | `composites/archived-banner.tsx` | Read-only banner for archived sessions (Restore / Delete). | reason, prNumber, base, onRestore, onDelete | no | #376 (2.11) |
| AuthCard | `composites/auth-card.tsx` | Sign-in card chrome: brand mark, heading, tinted background. | title, subtitle, children, className | yes | — |
| BackgroundTaskDock, BackgroundTaskOutput | `composites/background-task-dock.tsx` | Dock of background tasks with output viewer. | — | no | — |
| BranchDriftBanner | `composites/branch-drift-banner.tsx` | Banner when the shared checkout drifted off the pinned branch. | — | no | #376 (2.11) |
| OmittedFilesNotice, ExplorerPanel, ChangedFilesExplorer, ReviewFileDiff, ReviewSidebar | `composites/changes-review.tsx` | Changes review: explorer, file diff, sidebar, omitted-files notice. | branch, worktreePath, filter, onFilterChange, localAvailable, prAvailable | yes | — |
| CommandMenu | `composites/command-menu.tsx` | `/` command palette for skills and built-in commands. | — | no | — |
| Composer | `composites/composer.tsx` | Prompt composer: input, chips, attachments, send/stop. | skills, files, onAddMcp, mcpServers, onSetMcpApiKey, onSetMcpAuth | yes | — |
| ContextDivider | `composites/context-divider.tsx` | Transcript divider marking context compaction. | — | yes | — |
| ContextMeter | `composites/context-meter.tsx` | Context-window usage ring and popover. | tokens, breakdown, triggerAt, phase, preparing, digestReady | yes | — |
| EnvironmentDialog | `composites/environment-dialog.tsx` | Pick or create a workspace environment. | open, state, values, host, hosts, environment | no | — |
| InlineCommentComposer | `composites/inline-comment-composer.tsx` | Inline comment box anchored under a diff range. | — | no | — |
| IssueInbox | `composites/issue-inbox.tsx` | Global GitHub issue list with detail pane. | issues, viewerLogin, warnings, onActivate, onRefresh, refreshing | yes | — |
| IssuePickerList, IssueLabelChip | `composites/issue-picker-list.tsx` | Open-issue results list for new-session-from-issue; IssueLabelChip. | — | yes | — |
| LinkedIssueSelector | `composites/linked-issue-selector.tsx` | Pick the issue linked to a workspace. | items, value, onValueChange, icon, variant, disabled | yes | — |
| MagicLinkForm | `composites/magic-link-form.tsx` | Email magic-link input and submit. | state, mode, email, name, sentEmail, onEmailChange | yes | — |
| McpServerForm, McpServerDialog, McpAuthSetupDialog, McpApiKeyDialog, McpBrand, McpSettings | `composites/mcp-settings.tsx` | Settings › MCP servers with forms and auth dialogs. | servers, parseError, loading, statuses, probing, probe | no | — |
| MentionMenu | `composites/mention-menu.tsx` | `@` file/session mention palette. | — | no | — |
| PlanProgressContext, ToolStopContext, MessageTurn | `composites/message-turn.tsx` | One transcript turn: text, tool calls, thinking. | — | yes | — |
| ModeSwitch | `composites/mode-switch.tsx` | Plan/Build and permission-mode switch. | — | yes | — |
| NativeEndpointLogin | `composites/native-endpoint-login.tsx` | Sign-in against a native endpoint. | — | no | — |
| NewWorkspaceView | `composites/new-workspace-view.tsx` | New workspace screen: composer, chips, Start-from list. | open, projects, environments, providerCatalog, agentEndpointCatalog, defaultConnectionId | yes | — |
| PhaseNode | `composites/phase-node.tsx` | Workflow phase node. | — | yes | — |
| PlanApprovalCard, PlanCard | `composites/plan-card.tsx` | Plan card and approval card in the transcript. | — | yes | — |
| PlanChangeBlock, PlanRevisionDiff | `composites/plan-change-block.tsx` | Proposed per-file diff in a plan. | path, patch | no | — |
| PlanCommentLayer | `composites/plan-comment-layer.tsx` | Margin comment threads over plan text. | container, content, comments, editable, onReply, onResolve | no | — |
| PlanTaskList, PlanProgressDock | `composites/plan-progress-dock.tsx` | Plan task list / progress dock. | — | yes | — |
| PlanStageCard | `composites/plan-stage-card.tsx` | Plan stage card with SCM-style change letters. | stage, number, stages, onComment | no | — |
| STEP, PlanStepList | `composites/plan-step-list.tsx` | Legacy plan step list. | — | no | — |
| PluginsSettings | `composites/plugins-settings.tsx` | Settings › Plugins. | catalog, loadErrors, pluginIcons, actionError, onDismissActionError, onSetEnabled | no | — |
| PrCheckRow | `composites/pr-check-row.tsx` | One CI check row. | — | no | — |
| PrStatusGlyph | `composites/pr-glyph.tsx` | PR state glyph (PrStatusGlyph). | — | yes | #381 (2.16) |
| PrPickerList | `composites/pr-picker-list.tsx` | Open-PR results list for new-session-from-PR. | — | yes | — |
| PrReviewComposer | `composites/pr-review-composer.tsx` | Sticky PR review composer. | — | no | — |
| PrReviewGroup | `composites/pr-review-group.tsx` | Group of review threads from one review. | — | no | — |
| PrReviewThreadView | `composites/pr-review-thread.tsx` | Inline review thread with reply/resolve. | — | no | — |
| PrSidePanel | `composites/pr-side-panel.tsx` | PR right rail: reviewers, checks, merge box. | pr, connected, onMerge, merging, mergeError, onClosePr | no | — |
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
| SignInDialog | `composites/sign-in-dialog.tsx` | Optional sign-in dialog from the sidebar footer. | open, onOpenChange | no | — |
| SlashCommandRow | `composites/slash-command-row.tsx` | Row in the slash-command palette. | — | yes | — |
| StreamingText | `composites/streaming-text.tsx` | Markdown-preserving streaming text. | — | yes | — |
| ThemesSettings | `composites/themes-settings.tsx` | Settings › Themes. | themes, skipped, activeId, onSelect, onDuplicate, onDelete | no | — |
| ThoughtBlock | `composites/thought-block.tsx` | Agent reasoning line in the transcript. | — | yes | — |
| ToolCall | `composites/tool-call.tsx` | Tool-call row with collapsible output. | status, name, target, meta, filePath, children | yes | — |
| UsageModal | `composites/usage-modal.tsx` | Usage & limits modal. | — | no | — |
| UserMenu | `composites/user-menu.tsx` | Account menu. | user, onOpenSettings, onOpenUsage, onSignOut, onSignIn, ghConnected | yes | — |
| VisualBlocks | `composites/visual-blocks.tsx` | Structured visual blocks for plans and explanations. | blocks, className | no | — |
| VisualCallPathDiff | `composites/visual-call-path.tsx` | Call-path diff visual. | — | no | — |
| WebSearchSettings | `composites/web-search-settings.tsx` | Settings › Web search. | status, loading, busy, error, onSave, onClear | yes | — |

## Molecules and organisms — app shell

| Component | File | Purpose | Key props | Story | Redesign |
|---|---|---|---|---|---|
| AgentRoster | `app/agent-roster.tsx` | Peer-agents disclosure with message box. | — | no | — |
| AppShell | `app/app-shell.tsx` | Window frame: title bar plus routed content. | — | no | — |
| ChatTabBar | `app/chat-tab-bar.tsx` | Chat tab strip. | chats, closedChats, activeChatId, onSelectChat, onCreateChat, onRenameChat | yes | — |
| PALETTE, CommandPalette | `app/command-palette.tsx` | Global ⌘K palette. | — | yes | — |
| ConversationView | `app/conversation-view.tsx` | Chat transcript, composer and queue. | messages, hasMoreHistory, loadingHistory, onLoadEarlier, mode, skills | no | — |
| DiffPanel | `app/diff-panel.tsx` | Right-hand worktree diff rail. | — | no | — |
| EditorGroups | `app/editor-groups.tsx` | Split tree of editor groups. | onOpenCheckpoints, sessionId, layout, revision, describe, renderBody | no | — |
| JinglerApp | `app/jingler-app.tsx` | Top-level app composition. | onOpenCheckpoints, sessions, user, update, releaseNotes, onSignOut | yes | — |
| PreviewDock, PreviewToggleButton | `app/preview-dock.tsx` | Browser preview dock and toggle. | embedded, dock, onDockChange, visible, onToggle, url | yes | — |
| ProjectSidebar | `app/project-sidebar.tsx` | 56px project rail. | — | no | — |
| SessionSidebar | `app/session-sidebar.tsx` | Sessions and Explorer sidebar. | search, workspaceView, forceCollapsed, expandRequest, onWorkspaceViewChange, explorer | yes | — |
| SessionSplit | `app/session-split.tsx` | Chat + content split layout. | onOpenCheckpoints, group, sessions, emptyState, renderConversation, session | no | — |
| SessionTree | `app/session-tree.tsx` | Session chats, views and open files tree. | — | no | — |
| SubagentTabBar | `app/subagent-tab-bar.tsx` | Subagent chip strip. | — | no | — |
| AgentView, FleetAgentView | `app/subagent-view.tsx` | Read-only child agent transcript. | node, messages, providerId, loading, error, controlOutcome | no | — |
| TabBar | `app/tab-bar.tsx` | Content tab strip. | — | yes | — |
| TerminalDock, TerminalPanel | `app/terminal-panel.tsx` | Terminal dock and panel. | dock, onDockChange, visible, onToggle, tabs, activeId | yes | — |
| TitleBar | `app/title-bar.tsx` | Window title bar; draws WindowControls when platform is set and not darwin. | title, actions, platform, windowControls | yes | #394 (3.11) |
| WindowControls | `app/window-controls.tsx` | Minimize / maximize-restore / close for Windows and Linux; red hover on Close only. | maximized, onMinimize, onToggleMaximize, onClose | yes | #394 (3.11) |
| TitleSearch | `app/title-search.tsx` | Global sidebar search. | — | no | — |
| ViewRail | `app/view-rail.tsx` | Right view rail. | — | no | — |

## Planned (not built yet)

Epic 2 (#365). Build in this order; each is its own PR into `epic/redesign`, and views wait on it.

| Component | Replaces / extends | Issue |
|---|---|---|
| IconButtonGroup | `ButtonGroup` | #366 (2.1) |
| SearchField, FilterChips | `SearchInput` | #367 (2.2) |
| SegmentedControl 28px | `SegmentedControl` | #368 (2.3) |
| Toast, ToastRegion, toast-machine | none (new) | #369 (2.4) |
| StatusRow, Stepper | ad-hoc status lists | #370 (2.5) |
| ListSkeleton, EmptyState, InlineError | `Skeleton`, `InlineStatus` | #371 (2.6) |
| SettingsCard, SettingsRow | `Toggle` rows in settings | #372 (2.7) |
| Drawer | `Dialog` | #373 (2.8) |
| HoverCard / Tooltip / Kbd restyle | existing | #374 (2.9) |
| ConfirmDialog destructive rule | `ConfirmDialog` | #375 (2.10) |
| BannerShell | `Callout`, archived/branch-drift banners | #376 (2.11) |
| VirtualList (searchable) | none (new) | #377 (2.12) |
| Avatar, AvatarStack | `Avatar` | #378 (2.13) |
| KpiTile, StackedMiniBar | none (new) | #379 (2.14) |
| CommentRow | none (new) | #380 (2.15) |
| SessionRow / PrGlyph stack slot | `SessionRow`, `PrStatusGlyph` | #381 (2.16) |

Token and button rules that every atom follows: #359 (1.1 Graphite palette), #360 (1.2 neutral primary Button), #361 (1.3 one-line Badge/Pill/Kbd).
