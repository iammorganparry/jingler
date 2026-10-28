# Epic QA findings — `epic/redesign`

Grounded against each issue's acceptance criteria. Severity: **P0** regression or broken core flow · **P1** acceptance criterion not met · **P2** UX polish / test gap.

## Baseline (epic @ 19fc68f6)

| Check | Result |
|---|---|
| `pnpm lint` (biome + oxlint complexity) | pass |
| `pnpm typecheck` (CI env) | pass |
| Unit tests, 17 projects | pass (~6,200 tests) |
| Full e2e (460 tests) | **406 passed, 49 failed, 5 skipped** (2.0h, epic @ 19fc68f6) |

### Final e2e failure clusters (by failing locator)

| # | Count | Locator | Cause | Fix side |
|---|---|---|---|---|
| F1 | 13 | `button "E2E"` (plugins.spec) | Plugin views live in "More views" unless pinned (spec §3c, #383). Spec predates it. | spec (default taken: follow §3c) |
| F2 | 9 | `Close pull request details` | `e2e/pull-request.ts` helper expects the pre-#861 floating rail | spec helper |
| F3 | 4 | `header-link-pr` (pr-stack ×4) | #858 hides the `pr` link chip when a session has >1 PR (SessionPrsChip replaces it) | spec, check UX |
| F4 | 6 | `Obsidian`, `Linked`, `Files`, `Explanation` buttons | Views not pinned → in overflow (same as F1) | spec |
| F5 | 2 | `editor-tab-strip` (responsive ×2) | Untriaged | ? |
| F6 | 2 | `Creating session` (project-config ×2) | Send-button creation state changed (#478?) | ? |
| F7 | 13 | misc: Chat 2 tab, Cmd-J, benchmark controls ×2, Web search region, sidebar CSS, model picker, plan text, `Store`, `Scoped`, conversation-scroll, project-sidebar | Untriaged — highest regression risk | ? |

### e2e failures so far (clusters)

| # | Cluster | Specs | Likely cause | Sev |
|---|---|---|---|---|
| E1 | PR details helper | chat.spec ×4 (593/632/664/1013), github-publish.spec ×2 (268/313) | `e2e/pull-request.ts` waits for "Close pull request details", which #861's Drawer no longer renders. Stale spec helper. | P1 |
| E2 | Plugin tab never appears | plugins.spec ×9+ | Plugin views no longer render as header buttons; they're behind "More views" unless pinned (#383/#384 header views). Either specs are stale or plugins lost discoverability. Needs a decision. | P0 until triaged |
| E3 | Chat 2 tab missing | parallel-chats.spec:38 | "New chat" exists but no `tab "Chat 2"`. Chat tab bar redesign? | P1 |
| E4 | Benchmark controls | multi-chat-perf.spec ×2 | "Missing benchmark control" | P2 |
| E5 | Click timeouts | architecture-figure, browser-control-mcp, obsidian-plugin ×2 | Click target moved/hidden (likely same header-view change as E2) | P1 |
| E6 | Misc | asset-browser:41, assets:404 (Cmd-J), chat.spec:75 (#744, known) | Untriaged | P1 |

## Known gaps from closing comments

| # | Issue | Gap | Sev |
|---|---|---|---|
| G1 | #478 | No wake RPC: Resume/Retry on the managed-environment chip do nothing; local creation never shows "Installing dependencies" | P1 |
| G2 | #442 | Desktop PR pane never passes `linkedIssue`, so the rail's Linked issue section never shows | P1 |
| G3 | #421 | Quota reset date is a placeholder and the banner never clears; held offline sends are lost if the pane unmounts | P1 |
| G4 | #419 | "Limited until" banner depends on a label the backend may not send; account choice uses a raw radio | P1 |
| G5 | #561 | Picked PR store not cleared on session switch; "This session" filter untested | P1 |
| G6 | #563 | Timeline rail not scoped; shared-checkout children not scoped; PR scoping has no e2e | P2 |
| G7 | #560 | Agent trees built only from the active checkout's uncommitted diff (committed child work invisible?) | P1 — verify in scenario B |
| G8 | #865 | Subagent child worktrees not reclaimed on archive | P2 |
| G9 | #502 | No project filter (`UsageFact` has no `projectId`) | P2 |
| G10 | #432 | "Rebase onto main" hardcoded to main; e2e doesn't prove retargeting | P2 |
| G11 | #427 | PR filter uses GitHub per-PR files, not #526 git ranges | P2 |
| G12 | #448 | Linear setup flyout uses raw input/button/select; Linear assignees use GitHub avatars | P2 |
| G13 | #442 | `LabelChip` applies GitHub's hex colour inline; Stack section isn't `PrStackRail` | P2 |
| G14 | #838 | Bundled whisper-cli signing and non-arm64 builds only checkable in a real release | P2 |
| G15 | #838 | Hold-to-talk key not in Keybindings, not checked against F7–F9 bindings | P2 |
| G16 | #425 | Dismissals in localStorage; Undo has no e2e | P2 |
| G17 | #415 | Merged-PR card / Archive / Keep open have no e2e | P2 |
| G18 | #475 | e2e never forces loadFailed/completionFailed | P2 |
| G19 | #420, #416, #433, #443 | Some states unit/story only (Connected/Retry, real failed MCP call, squash restack, failing checks) | P2 |
| G20 | all | No Paper parity screenshots for most redesigned views | P2 |
| G21 | #744 | `chat.spec.ts:75` fails on a clean epic | P1 |

## Scenario findings (real agents)

_To fill during scenarios A–H in `06-epic-qa-plan.md`._

## Agent QA (visible app, qa-epic @ eff72d77)

| ID | Scenario | Issue | Expected | Actual | Severity |
|---|---|---|---|---|---|
| Q1 | A | Changes / #427, #560 | Changes shows the session's work so far, so the user can follow it live and review it after the agent commits | `Sessions.diff`/`diffStat` diff the worktree against `HEAD` only (packages/cli-adapters/src/workspace.ts:535-555). Once the agent committed `da17517` (2 files, +7/−2) Changes showed "No changes yet · Changed 0" and the sidebar row had no diff stat. Same root cause as G7 | P1 |
| Q2 | setup | env | QA app agent runs work | First run failed "Could not prepare the embedded pi-subagents runtime": inherited `PI_CODING_AGENT_DIR` from the operator's Jingler. Launch-env issue, not an app bug; launch script now clears `PI_*`/`JINGLER_*` | — |
| Q3 | B | Subagent isolation / #560, #563 | Prompt asked for each subagent in its own worktree; chip popover reflects real isolation | Popover lists both children as "Shared checkout". The parent made `sub/version` / `sub/readme` worktrees itself with raw `git worktree add`, then they vanished and both commits (aa22193, ab28175) landed on the parent branch. Jingler-managed child worktrees were never used | P1 |
| Q4 | B | Subagent tool | Subagent launch from the real agent succeeds, or the error names the bad field so the agent can correct it | Every `subagent` call failed with `invalid-input: Tool input failed validation`. Root cause: packages/cli-adapters/src/runtime/tools/tool-registry.ts:271 discards the Effect ParseError from `Schema.decodeUnknownEither` and returns a fixed string, so neither the agent nor the transcript shows which field failed. The agent retried blind, gave up, and fell back to raw `git worktree add` (cause of Q3). Fix: include `ParseResult.TreeFormatter.formatErrorSync(decoded.left)` (bounded) in the message, plus a unit test | P1 |
| Q5 | B | Changes / Q1 | Parent Changes shows the two child commits | "No changes yet · Changed 0" again after both children committed (same root cause as Q1) | P1 (dup Q1) |
| Q6 | C | Multi-checkout / #670 | Each repo's work shows under its own checkout group and updates live | Groups render per repo (QA-WEB, QA-API) but both say "No changes yet" after the agent committed 7f4165f and 607ac59 (Q1 root cause) | P1 (dup Q1) |
| Q7 | C | Multi-checkout labels / #670 | Group header and chat checkout chip show the checkout's branch | Both group headers read `· MAIN` and the chat chip reads `qa-api · main`, while both worktrees are on `feat/health-status-and-cors` | P2 |
| Q8 | C→D | Multi-checkout follow-up turn / #670 | After the agent uses `switch_checkout`, the user can keep chatting in the same session | Every later turn fails with "Plan belongs to a different workspace". packages/cli-adapters/src/runtime/agent/shared-planning.ts:203 compares the stored plan `cwd` (first checkout, qa-web worktree) with the turn's `spec.cwd` (now the active checkout, qa-api worktree) and throws. A multi-repo session is dead after its first switch. Fix: key/compare plan state by session (or accept any of the session's attached checkout paths) instead of the active cwd, plus a unit test switching checkout between turns | P0 |
| Q9 | D | PR view draft state / #443 | After "Mark ready for review" succeeds, the Draft pill and draft banner go away | GitHub reports draft=false right after the click, but the PR header still shows the "Draft" pill 5s later and on re-read. The view doesn't refetch after markReady | P2 |
| Q10 | D | Mark ready discoverability | Draft PR actions visible in the PR view | At 1440px "Mark ready for review" only exists inside the folded "Pull request details" drawer; the header has no ready/merge action for a draft | P2 |
| Q11 | D (multi-repo) | Per-repo PR tracking / #670, #561 | A session spanning qa-web + qa-api tracks both PRs, each tied to its repo | sessions.json stores `prs=[{number:1}]` with no repo, and both `checkouts[]` have no PR. qa-api#2 (opened by the same agent) is untracked; the row shows a bare "#1" with no repo, and there is no session PRs chip. #670 acceptance ("track changes/PRs per repo") fails | P1 |
| Q12 | B | Session status | Row status matches the run | Session B row read "Running 15m · 2 agents" after its agent had stopped; it read "Settled" after an app restart. Status went stale until relaunch | P2 |
| Q13 | D | Archive worktree cleanup / #865 | Archive removes a clean, pushed worktree, or shows "Worktree kept" | Archive (with confirm) hid the row and set archivedAt, but `fierce-knuth` (clean, pushed, PR merged) stayed on disk with no badge. Expected on the epic: #865 shipped to `main` via #867, which epic/redesign doesn't contain yet. Re-check after main is merged into the epic | — (not an epic regression) |
| Q14 | E | Issue Reopen / #447 | A closed issue shows the neutral closed banner with Reopen (Github.reopenIssue RPC) | After "Close issue" the view shows a "Closed" pill and no Reopen anywhere. `ClosedIssueBanner` (packages/ui/src/composites/issue-rail.tsx:107) is defined but never mounted outside its own file/stories | P1 |
| Q15 | F | Home reachability / #476 | With a session blocked on a question, Home shows "Needs you" with Answer/Allow; the user can get back to Home | There is no Home button, and closing the last pane (⌃⇧W) leaves an empty editor group (`editor-groups-empty`, EmptyEditor in packages/ui/src/app/editor-groups*) instead of `group === null`, so `showEmpty` (jingler-app.tsx:1221) stays false and Home / HomeCards never render. The Needs-you card from a real question is unreachable once any session has been opened | P1 |
| Q16 | F | Session pane / #327 | After the last pane is closed, clicking a session row opens it again | Click, double-click and Enter on a sidebar row all leave `editor-groups-empty` ("Nothing open. Pick a chat in the sidebar.") with 0 editor groups. The empty state tells the user to do exactly the thing that doesn't work; the app is stuck until reload. Repro: open session → ⌃⇧W until no pane → click any row | P0 |
| Q16a | F | Q16 cause (hypothesis) | — | split-layout `show()` (packages/ui/src/app/split-layout.ts:233) only adds a group when the session has none, so the session pane likely still exists; ⌃⇧W closed the chat tab in the session's own editor groups (#327, editor-groups.tsx:190 renders EmptyEditor when root is null) and selecting an already-shown session never reopens its chat. Survives reload (persisted layout). Fix lane to confirm | — |
| R1 | re-check @ 46629934 | Q14–Q16 after #893 | — | Q14: Reopen shows on a closed issue and reopens it on GitHub. Q15: closing the last tab returns to Home ("Good afternoon", chip row, import card). Q16: clicking the row reopens the session. All fixed | — |
| Q17 | G | Settings shortcut | Home's shortcut list says "⌘, Settings", so ⌘, opens Settings | ⌘, does nothing. No keybinding or menu accelerator exists (only the palette "Open Settings" and the footer menu item). packages/ui/src/screens/empty-conversation.tsx:201 advertises a shortcut that isn't wired | P2 |
| Q18 | G | MCP empty state / #890 | MCP servers page points at importable servers when some are detected | Settings → MCP servers says "No servers configured yet." with only Add server, while Home's import card says "Found 24 servers you can import". The page has no Import entry point | P3 |
| R2 | G | Usage, Voice, MCP import | — | Usage (ranges, provider filter, Export JSON), Voice (speech models, Dictation, F9), MCP list, and the Home import dialog (24 servers grouped by source) all render and work. Not imported, to avoid copying the operator's real configs into qa-home | — |
| R3 | H | Offline banner / #421 | — | CDP offline emulation: `navigator.onLine` false, "Offline — agents keep running locally" banner shows; clears when back online | — |
| Q19 | operator | Home composer / #476 | Home uses the shared Composer like New session | packages/ui/src/screens/empty-conversation.tsx:124 renders a plain Textarea (since 7e55248c). Fix lane: swap in Composer, keep Home's chip row and hand-off flow | P2 |
| Q3a | B re-run @ f74e5adb | Q3 cause | Subagents can be launched in Jingler-managed worktrees | After #892 there are no validation errors, but the agent reports (correctly) that its `subagent` tool exposes only agent/context/thinking/timeout/parallel/chain, with no worktree isolation. packages/cli-adapters/src/runtime/subagents/pi-child-launcher.ts has no worktree option; subagent-capability-broker.ts `resolveChildCwd` only honours a child cwd that already exists in the same repo. So children always share the parent checkout. Fix needs a design decision: add an isolation/worktree field to the child launch that creates a managed worktree | P1 (feature gap, not a regression) |
| Q20 | B re-run @ f74e5adb | Changes live refresh / #427 | Changes updates as subagents edit the shared worktree | Header diff stat read `+16 −1` and the worktree had 3 modified files (README.md, src/server.js, test/server.test.js), but Changes stayed "No changes yet · Changed 0" through the run and after it settled. A reload showed all 3 files. Child-tool edits don't trigger the parent's diff refetch | P1 |
| Q21 | B re-run | Subagent workflow schema | The agent can run a chain/parallel workflow | The `subagent` tool schema has `async?: false`, but workflows need `async: true`, so every workflow call fails validation and the agent falls back to sequential foreground calls | P2 |
| R4 | B re-run | Q4 after #892 | — | Validation errors now name the field (the full schema shows in the message), and the agent corrected its call. Fixed | — |
| R5 | H crash recovery @ f74e5adb | Interrupted turn resume | — | Killed the app (SIGKILL) 15s into a turn. On relaunch the row read "Interrupted", the session offered Resume; Resume finished the turn (`// crash-test` written to src/server.js) and the row went to Settled. Works |  — |
| R6 | H @ f74e5adb | Limit/signed-out cards, provisioning progress, auth (#419/#478) | — | Not reproducible against real accounts, so covered by e2e: managed-environments, provider-onboarding, usage, auth specs 38/38 passed | — |
