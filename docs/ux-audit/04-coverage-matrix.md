# Feature → design-board coverage matrix

Sources: `03-redesign-spec.md` (§3–§5, §4 view map), code in `packages/ui/src` and `apps/desktop/src/renderer`.
Line refs are the export/declaration line where known (`file:line`); `file` alone means "see file". **Verify copy and lines in code before building each board.** This pass was a fast scout (file/export enumeration + spec read), not a line-by-line read of every body.
Gap: none / partial / missing.

## Shell, navigation, chrome
| Area | Feature | What it does | Boards | Gap | Notes |
|---|---|---|---|---|---|
| Shell | AppShell `app/app-shell.tsx:7` | window frame, reduced-motion | 04* | none | |
| Shell | TitleBar `app/title-bar.tsx:7` | platform-aware title bar | 04*, 13 | partial | Win/Linux controls overlay not drawn |
| Shell | TitleSearch `app/title-search.tsx:25` | search pill → palette | 04b, 10 | none | |
| Rail | ProjectSidebar `app/project-sidebar.tsx:81` | project rail, badges | 03, 04* | none | |
| Sidebar | SessionSidebar `app/session-sidebar.tsx:1160` (+SessionTree `session-tree.tsx:49`, session-filters.ts) | workspace list, Sessions/Explorer toggle, filters | 03, 04l, 12 | partial | Filter menu, sort, grouping, search-in-list not shown |
| Sidebar | SessionRow / SessionHoverCard `composites/session-row.tsx`, `session-hover-card.tsx:25` | row status + hover details | 00, 03 | partial | Hover card missing; drafts pencil in 00 only |
| Sidebar | Archived list (footer link) | restore archived | 14 (mention only) | partial | No list board |
| Rail | ViewRail `app/view-rail.tsx:76` | right icon rail w/ badges | 04g (replaced) | none | Removed by design |
| Views | tab-contributions `app/tab-contributions.ts:221` (conversation, files, browser, terminal, issue, explanation, plan, pr, review, changes, workflow) | view registry | 04g | partial | Only launcher; Browser, Workflow, Issue, Review, PR bodies missing |
| Tabs | TabBar `app/tab-bar.tsx:182`, ChatTabBar `chat-tab-bar.tsx:115`, SubagentTabBar `subagent-tab-bar.tsx:7` | tab strips | 04h-k, 04b | partial | Thread switcher + subagent chips not specified in a board |
| Layout | EditorGroups `editor-groups.tsx:117`, SessionSplit `session-split.tsx:96`, split-layout/shortcuts | splits, drag | 04h–k | none | |
| Layout | Narrow window | drawer | 04f | none | |
| Palette | CommandPalette `app/command-palette.tsx:50`, FileQuickOpen `asset/file-quick-open.tsx:24` | ⌘K / ⌘P | 10 | partial | Quick-open (⌘P) variant not shown |
| Terminal | TerminalDock `app/terminal-panel.tsx:53`, TerminalPanel `:358` | bottom dock / tab | 04j | partial | Multi-tab, resize, empty/error shell absent |
| Preview | PreviewDock + PreviewToggleButton `app/preview-dock.tsx:27,136` | browser preview dock | none | missing | See board 21 |
| Fleet | AgentRoster `app/agent-roster.tsx:6`, AgentView/FleetAgentView `subagent-view.tsx:95,110`, AgentCard `composites/agent-card.tsx:7` | subagent fleet | none | missing | Board 20 |
| Diff | DiffPanel `app/diff-panel.tsx:16` | side diff summary | 04c (right panel in spec) | partial | |

## Chat / transcript / composer
| Area | Feature | What | Boards | Gap | Notes |
|---|---|---|---|---|---|
| Transcript | ConversationView `app/conversation-view.tsx:314` + timeline rail (591-696) | transcript, turn rail | 04b/c/e/h | none | |
| Transcript | message-turn, thought-block, tool-call, visual-blocks, streaming-text, context-divider `:55` | turn rendering, collapsed tools, thinking, compaction divider | 04b | partial | Thought block, tool expanded states, context divider not drawn |
| Transcript | EmptyConversation `screens/empty-conversation.tsx:11` | empty chat | 03/12 | partial | |
| Transcript | Checkpoint revert on hover | rewind | 04b (card in spec) | partial | Confirm dialog missing |
| Composer | Composer `composites/composer.tsx:514` | main input | 00, 04* | partial | Single row only |
| Composer | MentionMenu `mention-menu.tsx:10` | @ files/sessions | none | missing | Board 22 |
| Composer | SlashCommandRow `slash-command-row.tsx:6` | / commands | none | missing | Board 22 |
| Composer | ProviderModelBrowser `provider-model-browser.tsx:99` + model chip | model picker | none | missing | Board 22 |
| Composer | Reasoning chip, Environment chip, Skills, Tools menu (`ComposerSelect :200`, `ComposerMcpDialogs :456`) | thinking level, env, MCP/skills | none (spec moves into model popover) | missing | Board 22 |
| Composer | Attachments (attachment-thumb/source) | drop/paste images | none | missing | |
| Composer | ContextMeter `context-meter.tsx:68` | usage ring | 00 (ring noted) | partial | popover detail missing |
| Composer | QueuedMessageRow `queued-message-row.tsx:52` | queued sends | none | missing | |
| Composer | BackgroundTaskDock `background-task-dock.tsx:150` + Output `:220` | bg tasks | none | missing | "Background tasks" |
| Composer | PlanProgressDock `plan-progress-dock.tsx` | plan tasks | 17b | none | |
| Composer | Stop / Send-branch (composer-stop, composer-send-branch), Follow agent | stop, branch send | none | missing | |
| Composer | ModeSwitch `mode-switch.tsx:17` | Plan/Build, Ask/Accept/Auto | 00, 04 | partial | |
| Banners | ArchivedBanner `archived-banner.tsx:20` | read-only, Restore/Delete | none | missing | Board 23 |
| Banners | BranchDriftBanner `branch-drift-banner.tsx:18` | branch changed | none | missing | Board 23 |
| Banners | RuntimeRecoveryCard `runtime-recovery-card.tsx:24` | runtime crashed/recover | 12 (partial) | partial | |
| Banners | Callout `components/callout.tsx:41`, provider-disconnected | tones | 12 | partial | |
| Agent asks | QuestionCard/QuestionSummary, ApprovalGate | question / approval | 17d | none | |
| Plan | PlanCard, PlanReview `screens/plan-review.tsx:142`, plan-doc, comment layer | plan | 17a/b | none | |
| Explain | ExplanationView `screens/explanation-view.tsx:15` | article | 17c | none | |
| Linked issue | LinkedIssueSelector, RepoPicker | pick issue/repo | 08 | partial | popovers |

## Changes / review / PR
| Area | Feature | What | Boards | Gap | Notes |
|---|---|---|---|---|---|
| Changes | ChangesReview `composites/changes-review.tsx` (ExplorerPanel `:123`, ChangedFilesExplorer `:176`, ReviewFileDiff `:293`, ReviewSidebar `:417`, OmittedFilesNotice `:71`), desktop `renderer/changes-review.tsx` | diff review | 04l (tree only), spec §4 #05 | missing | Board 05 |
| Review | ReviewCodeView `review-code-view.tsx:302`, ReviewFindings `review-findings.tsx:318`, ReviewFindingRow `:181`, ReviewTray `review-tray.tsx:19`, InlineCommentComposer, review-file-rail/tree/filter | line comments, AI findings | none | missing | Board 05 |
| PR | PullRequestView `pull-request-view.tsx:201`, PrSidePanel `pr-side-panel.tsx:113`, pr-check-row, pr-review-thread/group/composer, pr-timeline-entry, PrGlyph | PR / checks | 04m (stack only) | partial | Board 06 |
| PR | PullRequestInbox `pull-request-inbox.tsx:102` + filter machine | PR list | none | missing | Board 19 |
| Issues | IssueInbox `issue-inbox.tsx:93` | issue list | 08 (list sample) | partial | Board 19 |
| Workflow | workflow tab / Workflow bar | multi-agent run | none | missing | Board 06 section |

## Settings
| Area | Feature | What | Boards | Gap | Notes |
|---|---|---|---|---|---|
| Settings | SettingsView `settings-view.tsx:263` NAV (general, projects, devices, providers, context, plan, agents, runtime, permissions(Soon), connectors, github, themes, plugins, keybindings(Soon)); SettingsDialog | frame/nav | 09a | partial | |
| Settings | GeneralSection `:944` (+ ToggleRow, FontSizeRow, offload status priming/ready/failed) | general | 09a | none | Offload states partial |
| Settings | Providers (`provider-connections-settings.tsx`) | | 09b, 15* | none | |
| Settings | GithubSection `:1238` | | 09c | none | |
| Settings | MCP `mcp-settings.tsx` | | 09d, 16d | none | |
| Settings | Themes `themes-settings.tsx` | | 09e | none | |
| Settings | Notifications | split | 09a? | partial | Not own board |
| Settings | Projects (`project-settings`, project-workflow-settings), Routines (`routines-settings-view.tsx`) | | none | missing | 09f/09g |
| Settings | DevicesSection `:484` (online/incompatible/revoked, pairing) | | none | missing | 09h |
| Settings | Agents & skills `agents-settings.tsx` | | none | missing | 09i |
| Settings | ContextSection `:718`, Plan | | none | missing | 09j |
| Settings | Runtime / RuntimeInspector `runtime-inspector.tsx:12` | | none | missing | 09k |
| Settings | Plugins `plugins-settings.tsx` (+secret machine) | | none | missing | 09l |
| Settings | Web search `web-search-settings.tsx` | | none | missing | 09m |
| Settings | Offload compute | | none | missing | 09n |
| Settings | Permissions / Keybindings stubs `StubSection :693` | Soon | none | missing | 09n |
| Settings | Usage (RunStats `run-stats.tsx:19`) | | 18* | none | |

## Onboarding, auth, overlays, states
| Area | Feature | What | Boards | Gap | Notes |
|---|---|---|---|---|---|
| Auth | LoginScreen `login-screen.tsx:51`, MagicLinkForm, NativeEndpointLogin, SignInDialog `sign-in-dialog.tsx:14` | | 01, 15* | partial | In-app SignInDialog missing |
| Setup | SetupScreen `setup-screen.tsx:72` | | 02a–c | none | |
| Home | Home | | 03 | none | |
| New | NewWorkspaceView | | 08 | none | |
| Overlays | AddProjectDialog `:297`, UserMenu `:88`, UsageModal `:121` | | 14, 18 | none | |
| Overlays | EnvironmentDialog `environment-dialog.tsx:36` | | none | missing | Board 22 |
| Overlays | ConfirmDialog `confirm-dialog.tsx:19` | | none | missing | Board 24 |
| Overlays | Update widget / release notes ("What's new") | | 14 (menu row) | partial | Board 24 |
| Overlays | Context menus, HoverCard, Tooltip | | none | partial | |
| States | LoadingScreen `loading-screen.tsx:86`, Skeleton, root ErrorBoundary | | 12 | partial | Root error boundary missing |
| Files | AssetBrowser/AssetView/Loading/TooLarge/Unsupported/Error, CsvTable, file-browser-view | file viewer | 04h | partial | Non-text/error states missing |
| Desktop | mcp-import-prompt, plugin-pane-host | | 16 | partial | Plugin panes missing |

## Gaps (prioritised)
**P0**
1. **05 · Changes review** — file tree (+/−, status letters), turn filter ("All turns ▾"), unified diff with per-hunk Keep/Revert, ReviewFindings rows (severity), ReviewTray "Your review" with removable comments, InlineCommentComposer, OmittedFilesNotice, empty/loading/error.
2. **06 · Checks** — readiness checklist (git, CI, review threads, todos, description), PR timeline, review threads with reply/resolve, merge CTA disabled with reason, Workflow section.
3. **22 · Composer menus** — mention menu, slash commands, model browser, reasoning chip, environment chip + EnvironmentDialog, skills, tools/MCP menu, attachments, context meter popover, queued messages, background task dock, stop/send-branch, follow agent.
**P1**
4. **19 · PR inbox & Issue inbox** — filters, rows, empty/error.
5. **20 · Subagent fleet** — roster, agent cards, subagent view, thread switcher chips.
6. **21 · Browser preview** — dock, toggle, "Preview ready" chip, loading/error.
7. **09f–09n Settings remaining** — Projects+workflow, Routines, Devices (online/incompatible/revoked, pairing), Agents & skills, Context & Plan, Runtime inspector, Plugins, Web search, Offload, Soon stubs, Notifications.
**P2**
8. **23 · Banners** — archived (Restore/Delete; copy "This session is archived and now read-only…"), branch drift, runtime recovery, callouts, provider disconnected.
9. **24 · Dialogs & system** — ConfirmDialog, SignInDialog, update widget/release notes, root ErrorBoundary, hover cards, context menus, archived list, file viewer error states, checkpoint revert confirm.
10. Terminal dock details (tabs, resize), sidebar filter/sort menu, ⌘P quick open.
