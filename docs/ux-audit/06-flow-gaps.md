# Flow gap audit — states the redesign does not yet define

Method: eight end-to-end flows traced through `apps/desktop/src/renderer`, `packages/ui/src`, `packages/cli-adapters/src` and `packages/contracts/src`. Every `file:line` was checked with `rg`. A gap is a step where code has a state (or needs one) and no board in `02 · Improved` draws it.

Rules applied to every proposal (spec §6): primary button is neutral (`--text-1` fill), red only for destructive or failure icons, no traffic-light lists, badges and pills one line (`nowrap`, `flex-shrink:0`), one skeleton/empty/error pattern (§5h).

Board ids: existing = `00 01 02a-c 03 04b-m 05 06 07 08 09a-n 10 12 13 14 15a-d 16a-d 17a-d 18a-c 19a-b 20 21 22a-d 23 24a-b`. `25a-e` are the planned boards: **25a** hover card + archived list, **25b** workspace setup progress/failure (+ device pairing), **25c** revert confirm / sign-in dialog / crash screen, **25d** file viewer states, **25e** PR detail and conflicts.

## Summary

| Flow | Gaps |
|---|---|
| 1. Sign in → first message | 15 |
| 2. Issue → plan → PR → merge → archive | 14 |
| 3. PR stack | 9 |
| 4. Agent needs you in another workspace | 7 |
| 5. Provider / MCP auth expiry mid-run | 6 |
| 6. Subagent fleet | 7 |
| 7. Paired device / remote run | 9 |
| 8. Update, crash, runtime recovery | 8 |
| **Total** | **75** |

### Five most important
1. **Dead ends in sign-in and boot (F1-01, F1-02, F1-08).** `oauthPending` has no exit (`auth-machine.ts:130`), `error` only has RESET (`:145`), and a boot failure renders raw red text with no Retry (`App.tsx:2168`) although the machine has `RETRY` (`app-machine.ts:668`). A user can be stuck with no way out.
2. **No toast system exists (F4-07).** `rg toast` finds only comments (`auto-route.ts:83`, `active-session.ts:15`). The spec's "Needs you · Jump", "Dismiss · Undo", "Couldn't stop · Retry" all depend on it. Build it first.
3. **Needs-you has no rail count and no landing spot (F4-01, F4-02).** `ProjectAvatar` only takes `sessionCount` / `activeSessionCount` (`project-sidebar.tsx:16-17`). The notification click carries only `sessionId` (`preload/index.ts:108`) and never reaches the question.
4. **Mid-run auth recovery is a composer lock, not a flow (F5-01, F5-04).** Provider expiry disables the composer (`conversation-pane.tsx:1511`). MCP "needs sign-in" cards are dismissed via a module-level `Set` (`:120`) and have no waiting/cancel/failed states.
5. **PR stacks have no data model or restack contract (F3-01, F3-03).** One `prNumber` (`domain.ts:553`, `:622`) and only `Github.updateBranch` (merge base into head, `contracts/src/index.ts:1982`). There is no rebase/retarget RPC.

---

## Flow 1 — Sign in → onboarding → first project → first workspace → first message

1. Boot: `app-machine` `loading` (`app-machine.ts:282`) behind the splash hold (`loading-screen.tsx:74`).
2. Auth: `auth-machine` `checking` (`auth-machine.ts:74`) → `signedOut` (idle / sending / magicLinkSent / oauthPending / error) or `signedIn`.
3. OAuth or magic link; the `jingler://auth/callback` deep link re-enters `checking` (`App.tsx:2073`).
4. Onboarding `setup.workspace` → `github` → `provider` → `resources` (`app-machine.ts:323-512`) → `starting` (`:577`).
5. Projects registered from the repos folder; Home; ⌘N New workspace (`new-workspace-view.tsx:491`).
6. Provisioning (`new-workspace-view.tsx:84`) → session opens → empty conversation (`empty-conversation.tsx:11`) → first message.

| ID | Gap | Flow step | Proposed UI | Board | Source |
|---|---|---|---|---|---|
| F1-01 | OAuth pending has no way out. Closing the browser leaves the wall stuck. | 3 | Under the button: "Finish signing in in your browser…" + secondary `Cancel` and text link `Copy sign-in link`. After 2 min show "Still waiting? Try again". Needs a `CANCEL` event to `idle`. | 01 | `auth-machine.ts:130`, `:145` |
| F1-02 | Error state offers only RESET, no retry of the failed action; magic-link failure copy is a fixed string. | 3 | Inline red line under the field with the cause, `Retry` (re-runs last provider/email) and `Use a different method`. | 01 | `auth-machine.ts:117`, `:145` |
| F1-03 | Magic link sent: no resend, no expiry, only RESET. | 3 | "Check morgan@… — link expires in 15 min", `Resend` (30 s cooldown, shows "Sent again ✓"), `Use a different email`. **Q:** expiry value comes from the auth server. | 01 | `auth-machine.ts:122` |
| F1-04 | Deep link with `?error=` is parsed but the renderer only reacts to `payload.ok`, so a denied OAuth shows nothing. | 3 | Return to idle with the error line "GitHub sign-in was cancelled" + Retry. | 01 | `deep-link.ts:45`, `App.tsx:2073` |
| F1-05 | `checking` failure silently becomes signed-out, so an offline boot looks like a sign-out. | 2 | Top hairline banner "Can't reach Jingler — you can keep working locally" + `Retry`; show the app, not the wall. | 12 / 23 | `auth-machine.ts:85` |
| F1-06 | A failed folder scan jumps to the global `failure` state and kills onboarding. | 4 | Stay on step 1; inline error "Couldn't read ~/code — permission denied" + `Choose another folder`. | 02a | `app-machine.ts:338-358` |
| F1-07 | Zero repositories found has no copy. | 4 | "No git repositories in ~/code" + `Choose another folder` + `Clone a repository` (opens Add project → Clone URL). | 02a | `setup-screen.tsx:260` |
| F1-08 | Boot failure is raw `Failed to load: {error}` in red mono with no button, while `RETRY` exists. | 1 | Centred card "Jingler couldn't start", short cause, details disclosure, `Retry` (primary), `Copy diagnostics` (uses `RuntimeDiagnostics.export`, `contracts/src/index.ts:275`). | 25c | `App.tsx:2168`, `app-machine.ts:668` |
| F1-09 | GitHub step error is a red Callout with no action. | 4 | "GitHub didn't respond" + `Try again` + `Skip for now`. | 02b | `setup-screen.tsx:172`, `github-connection-machine.ts:183` |
| F1-10 | Provider step: `loadFailed` (RETRY_PROVIDER) and `completionFailed` have no drawn UI; only the sign-in sheet is drawn. | 4 | Card-level error row "Couldn't load providers · Retry" and, on completion failure, "Couldn't save setup · Retry" above the CTA. CTA stays disabled with the reason. | 02c | `app-machine.ts:398`, `:451` |
| F1-11 | Import is now an optional Home card, but the old one-time flag `jingler:mcp-import-prompt:v1` and the `detectFailed` / `importFailed` states have no equivalent. | 4→5 | Home card states: detecting (skeleton), found (counts), failed ("Couldn't scan Claude Code · Retry"), dismissed (`Not now` persists; card reappears as a row in Settings → MCP servers). | 03 / 16a | `mcp-import-prompt.tsx:20`, `app-machine.ts:534`, `:566` |
| F1-12 | Workspace provisioning has phases and a failure that returns to the form, but no progress/failure board and no cancel. | 6 | Replace the composer with a phase list (Creating worktree · Installing dependencies · Starting agent) with a spinner on the current row, `Cancel`, and on failure the failed row in red + `Retry` / `Edit`. | 25b | `new-workspace-machine.ts:73`, `:560`; `new-workspace-view.tsx:84`, `:165` |
| F1-13 | A project whose folder moved shows only a small yellow dot. | 5 | Rail tile menu: "Folder not found" + `Locate folder…` / `Remove project`; sidebar banner on that project. | 24a | `project-sidebar.tsx:10`, `:74` |
| F1-14 | Composer disabled because no model/connection is selected has no first-run copy. | 6 | Disabled composer line "Choose a model to start" + `Select model` opening the 22b popover. | 22b | `conversation-pane.tsx:1506`, `:1515` |
| F1-15 | **Q:** the sign-in wall may no longer be shown. `App.tsx` offers `SignInDialog` from the sidebar footer when signed out ("The app runs signed out"). Board 01 assumes a full wall. | 2 | Confirm product intent. If optional, board 01 is the dialog skin (25c) and onboarding must not require auth. | 01 / 25c | `App.tsx:2116`, `sign-in-dialog.tsx:14` |

## Flow 2 — New workspace from an issue → agent works → plan review → executing → Changes → PR → Checks → merge → archive

1. ⌘N → "Start from" issue (`new-workspace-machine.ts:154-159`, RPC `Sessions.createFromIssueWithProgress`, `contracts/src/index.ts:731`).
2. Session created, issue linked (`Sessions.linkIssue`, `:739`).
3. Agent plans: `PlanApprovalCard` (`plan-card.tsx:110`) → `PlanReview` (`plan-review.tsx:142`) → `Plan.decide` (`:2180`).
4. Executing: `PlanProgressDock` (`plan-progress-dock.tsx`).
5. Changes review (`changes-review.tsx:176`, `review-findings.tsx:318`).
6. Create PR: `Github.createPr` streams a `PublishCheckpoint` (`:1850`, `domain.ts:547`).
7. Checks: `PullRequestView` / `PrSidePanel` (`pull-request-view.tsx:201`, `pr-side-panel.tsx:113`).
8. Merge: `onMerge(method)` (`pull-request-view.tsx:175`); the sweep closes the session (`pr-sweep.ts`).
9. Archive: `sessionArchiveMachine` (`session-archive-machine.ts`), banner Restore/Delete.

| ID | Gap | Flow step | Proposed UI | Board | Source |
|---|---|---|---|---|---|
| F2-01 | Issue provider unavailable is plain error text. | 1 | Under the `from` chip: "Linear isn't connected" + `Connect` (jumps to Settings → Plugins, 09l). | 08 | `new-workspace-machine.ts:315`, `:424` |
| F2-02 | "Start from" list has no skeleton, empty, error or Retry (neither inbox has a Retry). | 1 | Skeleton rows, "No assigned issues" + `Search all issues`, "Couldn't load issues" + `Retry`. | 08 / 19b | `issue-picker-list.tsx:15`, `issue-inbox.tsx:86`, `pull-request-inbox.tsx:73` |
| F2-03 | **Q:** an issue already linked to another workspace has no handling. | 1 | Warning row on the issue: "Already open in 'Fix PR inbox pagination'" + `Open it` / `Create another`. Needs a lookup over sessions' linked issues. | 08 | `contracts/src/index.ts:739` |
| F2-04 | Plan stale, or approval attempted while the agent is revising, has no drawn state. | 3 | Pinned footer: `Approve` disabled with reason "Agent is revising this plan"; stale banner "Plan changed since you opened it · Reload". | 17a | `plan-card.tsx:142`, `plan-review.tsx:142`, `:340` |
| F2-05 | Unsaved plan comment drafts are lost silently on Request changes / tab close. | 3 | ConfirmDialog "Discard 1 unsaved comment?" with `Keep editing` (primary) and `Discard`. | 17a | `plan-comment-store.ts:4`, `plan-comment-layer.tsx:16` |
| F2-06 | Plan execution has `blocked`, `failed`, `interrupted` stage states; 17b draws only done/current. | 4 | Neutral icon rows; failed gets a red icon plus "Step 3 failed" + `Retry step` / `Ask agent`. Interrupted: "Stopped by you" + `Resume`. | 17b | `plan-progress-dock.tsx:18`, `:21` |
| F2-07 | Review findings must be dismissable (§6.2) but there is no dismiss action or persistence. `Review.*` has no dismiss RPC. | 5 | `×` Dismiss on each row, "Dismissed (3) · Show", Undo in the toast. **Data:** persist dismissals per session in the review store. | 05 | `review-findings.tsx:181`, `review-store.ts:14`, `contracts/src/index.ts:1660` |
| F2-08 | Per-hunk/file revert is still wired (`onRevertFile`, `onRevertLines`) though §6.1 removes Keep/Revert. | 5 | Remove the buttons. **Q:** keep `Workspace.revertFile` as a context-menu "Discard file changes"? | 05 | `changes-review.tsx:278-279`, `contracts/src/index.ts:661`, `:667`, `rpc-client.ts:740`, `:748` |
| F2-09 | Publishing is a multi-step checkpoint with `failed` and `no-changes`, but 06 shows only a CTA. | 6 | `Create PR` expands to a three-row stepper (Commit · Push · Open PR); failure marks the failing row and shows `Retry from push` (uses `resumeFrom`). No changes: "Nothing to publish". | 06 | `publish-machine.ts:59`, `:61`; `domain.ts:547`; `pull-request-view.tsx:532` |
| F2-10 | Draft PR has a distinct "Mark ready" path that 06 does not show. | 7 | `Draft` pill beside the title + secondary `Mark ready for review`; inline error from `markReadyError`. | 25e | `pr-side-panel.tsx:88`, `:90`, `:152` |
| F2-11 | Merge blocked reasons (behind, conflicts, review required) and the merge-method choice (merge, squash, rebase) are not drawn. | 8 | Checklist row per blocker with its action ("Branch is 3 commits behind main · `Update branch`"). Merge is a split button `Squash and merge ▾`. A failed merge shows `mergeError` under it. | 25e | `pr-side-panel.tsx:37-51`, `:173`, `:300`; `pull-request-view.tsx:179` |
| F2-12 | Conflicts: copy says "conflicts need the code" and stops. No hand-off to the agent. | 8 | `Ask agent to resolve conflicts` posts a prompt into the chat and shows "Agent is resolving…" with the file list. | 25e | `pr-side-panel.tsx:192` |
| F2-13 | After merge nothing changes in-app except a notification and a silent session close. | 8 | Transcript card "PR #482 merged" + `Archive workspace` / `Keep open`; sidebar row shows Merged; toast. | 22d / 24a | `notifier.ts:76`, `pr-sweep.ts:49`, `domain.ts:349` |
| F2-14 | Archive confirmation (live terminal history) and archive failure have no dialog board. | 9 | ConfirmDialog "Archive this workspace? Terminal history is saved" with `Archive` as the final (red outline) button; failure keeps the dialog open with the error + Retry. | 25c / 24b | `session-archive-machine.ts:33`, `:41`; `domain.ts:567` |

## Flow 3 — PR stack: create stacked PR, rebase after the base merges, merge the stack

1. Agent opens PR #480; later PR #481 branched from it, then #482.
2. Sidebar row shows the PR glyph from a single status (`pr-glyph.tsx:52`).
3. Base #480 merges.
4. Upper PRs must be retargeted to `main` and rebased.
5. Merge #481, then #482 (or "Merge stack").

| ID | Gap | Flow step | Proposed UI | Board | Source |
|---|---|---|---|---|---|
| F3-01 | Data model has one PR per session; `createPr` takes only `sessionId`. | 1 | **Data:** `Session.prs: [{ number, branch, base, state, checks }]` ordered base-up, replacing `prNumber`. Sidebar glyph becomes `⑂ 3` coloured by worst state. | 04m | `domain.ts:553`, `:622`; `contracts/src/index.ts:1839`, `:1850`; `pr-glyph.tsx:52` |
| F3-02 | No way to choose "stack on" when creating a PR. **Q:** is the layer branch created by the agent or by Jingler? | 1 | In the Create PR stepper: `Base: main ▾` with an option `Stack on #481` defaulting to the top of the stack. | 06 / 04m | `contracts/src/index.ts:1850` |
| F3-03 | No retarget/rebase action after the base merges. Only `Github.updateBranch`, which merges base into head. | 3-4 | Stack rail row badge "Base merged" + `Rebase onto main`; bulk `Restack` in the rail header. **Contract:** new `Github.restack`. **Q:** gh CLI or local `git rebase` in the worktree (conflict handling)? | 04m | `contracts/src/index.ts:1982`, `use-pull-request.ts:45` |
| F3-04 | Merge order and "Merge stack" progress are undefined. | 5 | Upper PRs disabled with "Merge #481 first". `Merge stack` shows a per-PR list with spinner then ✓, halts at the first failure with `Resume`. Squash/rebase on a lower PR triggers an automatic restack row. | 04m | `pull-request-view.tsx:175`, `use-pull-request.ts:34` |
| F3-05 | Hover mini-list of the stack on the sidebar row is described but not drawn. | 2 | Extend the hover card with a stack list (number, title, state word, checks icon). | 25a | `session-hover-card.tsx:25` |
| F3-06 | Changes needs a "PR: #481 ▾" scope; the PR diff RPCs are per session, not per layer. **Q:** per-layer commit ranges. | 5 | Filter next to the turn filter; empty state "No commits in this layer". | 05 | `contracts/src/index.ts:1822`, `:1829` |
| F3-07 | Merge/close notifications and `alreadyNotified` are keyed per session, so a stack would announce once or never. | 3 | One notification per PR: "#480 merged (stacked under #481)". Key the guard on (session, PR number). | 24b | `pr-sweep.ts:33`, `notifier.ts:76` |
| F3-08 | Transcript card "Opened #481 · stacked on #480" has no source event. | 1 | New card kind emitted when `publish` completes; links into the header switcher. | 22d | `App.tsx:813`, `publish-machine.ts:54` |
| F3-09 | `closeOnMerge` would archive the session when the first PR merges and drop the remaining layers. | 5 | Archive only when every PR in `prs[]` is merged or closed; setting copy: "Close workspace when the whole stack is merged". | 04m / 09c | `pr-sweep.ts:49`, `domain.ts:349` |

## Flow 4 — Agent asks a question or needs permission while the user is in another workspace

1. Run enters `needs-input` or `needs-approval` (`domain.ts:261`).
2. `notificationFor` fires once on the edge (`notifier.ts:41`).
3. Main shows the OS notification; click sends `NOTIFICATION_ACTIVATED_CHANNEL` (`notifications.ts:26`, `:111`).
4. Renderer selects the session (`App.tsx:289`).
5. Sidebar row turns amber; rail tile should show a count; Home lists "Needs you".
6. User answers (`Agent.answerQuestion`, `Agent.decideGate`, `contracts/src/index.ts:1046`, `:1035`).

| ID | Gap | Flow step | Proposed UI | Board | Source |
|---|---|---|---|---|---|
| F4-01 | The rail tile has no needs-you count; it only knows session counts. | 5 | Amber count badge (one line, `nowrap`) top-right of the tile, derived from sessions with a blocked `SessionActivity`. | 00 / 04b | `project-sidebar.tsx:16-17`, `domain.ts:261` |
| F4-02 | Notification click carries only `sessionId`, so it can open the wrong project and never lands on the question. | 4 | Payload gains `kind` and `turnId`. Click switches project, selects the workspace, scrolls to the blocked card and focuses option 1; the timeline gets an amber tick. | 04b / 17d | `preload/index.ts:108`, `App.tsx:289`, `notifications.ts:111` |
| F4-03 | Body text is generic and tool approvals are labelled "approve a plan". **Q:** does `needs-approval` cover tool gates too? | 2 | Title = workspace name, body = first line of the question or "Run `pnpm test`?". | 24b | `notifier.ts:55` |
| F4-04 | No keyboard path to the next blocked workspace. | 5 | Palette section "Needs you (3)" pinned first, plus a "Go to next workspace that needs you" action. **Q:** shortcut. | 10 | `command-palette-model.ts:31` |
| F4-05 | A question that is no longer pending (run stopped, workspace archived) has no state on its Home card. **Q:** does the backend reject stale answers? | 6 | Card turns neutral: "No longer waiting · Dismiss". | 03 | `contracts/src/index.ts:1046` |
| F4-06 | OS permission denied or notifications unsupported fails silently. | 2 | Settings → Notifications warning row "Notifications are blocked by macOS" + `Open System Settings`. | 09f | `notifications.ts:11`, `contracts/src/index.ts:1540` |
| F4-07 | No in-app toast component. | 5 | Bottom-right stack of up to 3: success, error with `Retry`, "Needs you" with `Jump`. Auto-dismiss 6 s, pause on hover, `Esc` dismisses. Skip when the user is already looking at that session (rule in `active-session.ts:15`). | 24b | `auto-route.ts:83`, `active-session.ts:15` |

## Flow 5 — Provider auth expires mid-run; an MCP OAuth server needs sign-in mid-run

1. Run is streaming; provider token or entitlement fails.
2. `providerRecoveryOf` returns a recovery message (`provider-recovery.ts:22`); composer disables (`conversation-pane.tsx:1515`).
3. User reconnects in Settings; `providerRebindOf` swaps the pinned connection (`provider-recovery.ts:89`).
4. MCP server reports `needs-auth` (`mcp-probe.ts:164`, `mcp.ts:39`); a `RuntimeRecoveryCard` appears (`conversation-pane.tsx:137`).
5. Connect → `Mcp.startAuthorization` (`contracts/src/index.ts:1257`) → browser.

| ID | Gap | Flow step | Proposed UI | Board | Source |
|---|---|---|---|---|---|
| F5-01 | The in-flight run fails with a generic error and the user must hunt for Settings. Subscription must never fall back to an API key. | 1-3 | Transcript card "Claude Code signed out during this run" + `Reconnect` (opens the 15a Connect sheet in place) + after success `Resume run`. Copy: "Your subscription won't fall back to an API key." Composer shows the amber line from §5h. | 23 / 15a | `provider-recovery.ts:15`, `conversation-pane.tsx:1511` |
| F5-02 | A usage limit hit mid-run has no state. | 1 | Banner "Limited until 16:40" + `Switch model` / `Switch account`. Usage popover row shows the same reset time. | 23 / 18a | `contracts/src/index.ts:1288` |
| F5-03 | Rebind only happens when the replacement is unambiguous; the ambiguous case has no UI. | 3 | Recovery card lists the signed-in accounts as radio rows + `Use this account`. | 23 | `provider-recovery.ts:89` |
| F5-04 | MCP recovery card has no waiting, cancel or failure states, and dismissal lives in a module-level `Set` that is lost on reload. | 4-5 | Card states: `Needs sign-in · Connect` → "Waiting for browser… · Cancel" → "Connected" (auto-hide) or "Sign-in failed · Retry". Persist dismissal per server. Reuse `authorizing` from the auth state. | 23 / 16d | `conversation-pane.tsx:120`, `:137`, `:153`; `mcp.ts:39`; `mcp-settings.tsx:45` |
| F5-05 | A tool call that failed on auth shows a generic failure row. | 4 | Failed tool row action `Sign in to Linear` that starts the same flow. | 22d | `tool-call.tsx:111` |
| F5-06 | No offline detection anywhere. | 1 | Top hairline banner "Offline — agents keep running locally". A send that needs a provider queues with "Waiting for connection" (reuse queued row). | 23 | `queued-message-row.tsx:52` |

## Flow 6 — Subagent fleet: spawn, follow, stop, failure

1. Parent run spawns subagents; the fleet projection updates (`subagent-fleet-machine.ts:140`).
2. Chips in the lane header; roster and agent cards (`agent-roster.tsx:6`, `agent-card.tsx:7`, `subagent-tab-bar.tsx:7`).
3. Open one: `FleetAgentView` (`subagent-view.tsx:110`).
4. Control: steer / follow-up / interrupt / stop / resume / reply (`subagent-fleet.ts:153`).
5. Agent ends or fails; `SYNC` may reset the selection (`subagent-fleet-machine.ts:205`).

| ID | Gap | Flow step | Proposed UI | Board | Source |
|---|---|---|---|---|---|
| F6-01 | Spawning is silent unless the fleet is open. | 1 | Transcript row "Spawned 3 subagents" and a pulsing "3 subagents" chip in the lane header. Overflow becomes `+N`. | 20 / 04f | `subagent-tab-bar.tsx:7`, `subagent-fleet-machine.ts:140` |
| F6-02 | "Follow" exists only as the Files follow toggle for the main agent. | 3 | Follow toggle in the subagent view header. **Q:** follow that subagent's file edits? | 20 | `composer.tsx:308`, `:310` |
| F6-03 | Stop swallows errors (`.catch(() => { })`) and has no pending state. | 4 | Stop → spinner → "Stopped". On failure a toast "Couldn't stop researcher · Retry". | 20 / 24b | `conversation-pane.tsx:1099`, `:1102` |
| F6-04 | `AgentCard` knows working / flagged / done, but runs end as completed / stopped / failed. | 5 | Neutral icon rows; failed gets a red icon, reason text, and `Resume` / `View transcript`. | 20 | `agent-card.tsx:4`, `subagent-fleet.ts:50`, `subagent-fleet-machine.ts:31` |
| F6-05 | Roster message failure is bare text; the Send button is hard-coded `bg-blue`, which breaks §6.10. | 4 | Inline "Not delivered · Retry"; Send uses the neutral primary variant. | 20 | `agent-roster.tsx:53`, `:56` |
| F6-06 | A subagent asking a question does not reach the Needs-you count or the timeline. | 4 | Needs-you tick in the parent timeline, the amber count includes children, and the subagent view shows the `QuestionCard`. | 20 / 17d | `subagent-fleet.ts:153`, `question-card.tsx:19` |
| F6-07 | A finished subagent disappears and selection jumps back to main. | 5 | Move to a "Done (3)" group in the chip menu and toast "researcher finished" with `View`. | 20 | `subagent-fleet-machine.ts:205` |

## Flow 7 — Paired device / remote run

1. Settings → Devices → pair (`DevicesSection`, `settings-view.tsx:484`; `Environment.pairSsh`, `contracts/src/index.ts:455`; `suggestHosts`, `:451`).
2. Device agent enrols and holds the relay connection (`apps/device-agent/src/control-connection.ts`, result `stopped` or `revoked`, `:236`).
3. New workspace picks an environment (`new-workspace-machine.ts:513`); startup progress (`new-workspace-view.tsx:84`).
4. Run executes remotely; connection drops or reconnects.
5. Revoke or rename the device (`Environment.revoke`, `:467`; `rename`, `:461`).

| ID | Gap | Flow step | Proposed UI | Board | Source |
|---|---|---|---|---|---|
| F7-01 | The pairing wizard has no board: host suggestions, bootstrap progress, failure. | 1 | 480px sheet: Host (suggestions list) → "Installing device agent…" steps → "Paired ✓" or the failing step + log tail + `Retry`. Empty list: "No owned machines yet" + `Pair a machine`. | 25b | `settings-view.tsx:560`, `environment-machine.ts:81` |
| F7-02 | Device states `offline` and `reconnecting` exist; the list styles only online / incompatible / revoked. | 2 | One-line neutral status text: Online · Offline · Reconnecting… (spinner) · Incompatible (red icon) · Revoked. No green or yellow fills. | 09h | `domain.ts:36-46`, `settings-view.tsx:566-572`, `:1112` |
| F7-03 | **Q:** Incompatible device has no remedy copy. | 2 | "Device agent v0.8 is older than this app needs" + `How to update` (link). Exact command to be taken from `apps/device-agent/README.md`. | 09h | `control-connection.ts:16`, `settings-view.tsx:569` |
| F7-04 | Revoke has no confirmation listing what will stop. | 5 | ConfirmDialog "Revoke Studio-Mac? 2 workspaces run on it and will stop." Final button `Revoke` (red). | 24b | `contracts/src/index.ts:467`, `control-connection.ts:236` |
| F7-05 | A device that drops mid-run shows nothing in the workspace. | 4 | Lane banner "Studio-Mac went offline — the run is paused" with `Continue on this Mac…` (uses `Sessions.continueOnEnvironment`). Returns to normal on reconnect. | 23 | `contracts/src/index.ts:860` |
| F7-06 | Relay quota, rate limit and concurrency statuses have no UI. | 4 | Banner "Remote runs are paused — relay quota reached. Local runs aren't affected." + usage row with reset date. Copy and numbers are placeholders. | 23 / 18a | `core/src/remote.ts:137`, `:760`, `:818` |
| F7-07 | Managed environments sleep, pause, restore and fail; only provisioning has a progress view. | 3 | Header chip "Waking workspace…" with elapsed time, or "Paused · Resume". Failed: reason + `Retry`. | 25b | `domain.ts:49`, `new-workspace-view.tsx:84` |
| F7-08 | Offload compute status (priming / ready / failed) is a status line with no retry. | 1 | Status row in Settings → General: "Priming…" / "Ready" / "Failed · Retry". | 09a | `offload-settings-machine.ts:27`, `contracts/src/index.ts:1327` |
| F7-09 | The environment choice is missing from the New workspace chip row. | 3 | `This Mac ▾` chip, shown only when a device or managed environment exists; menu rows with status words. | 08 | `new-workspace-machine.ts:513`, `environment-dialog.tsx:36` |

## Flow 8 — App update, release notes, crash recovery, runtime recovery

1. Updater state arrives (`use-auto-update.ts:15`): available → downloading → downloaded, plus error and manual installer.
2. Sidebar card or account-menu row (`session-sidebar.tsx:53`, `:141`).
3. App relaunches on a new version; one-time notes (`use-release-notes.ts:32`).
4. Renderer crash is caught by `RootErrorBoundary` (`root-error-boundary.tsx:22`).
5. A run's runtime or MCP server fails; `RuntimeRecoveryCard` (`runtime-recovery-card.tsx:24`) and `Sessions.resolveRuntimeRecovery` (`contracts/src/index.ts:807`).

| ID | Gap | Flow step | Proposed UI | Board | Source |
|---|---|---|---|---|---|
| F8-01 | The spec draws only "Restart to update"; the code has five states. | 1-2 | Account-menu row: "v1.9.0 available · Download" → "Downloading 42%" → "Restart to update" → "Update failed · Retry" → manual "Open installer". Dismiss collapses it to a compact button. | 24b | `session-sidebar.tsx:53-61`, `use-auto-update.ts:5`, `:40` |
| F8-02 | Installing quits the app while agents run. | 2 | ConfirmDialog "3 agents are running. Restarting stops them." `Restart anyway` / `Wait`. **Q:** do runs resume after relaunch? | 24b | `use-auto-update.ts:40` |
| F8-03 | Release notes appear once and cannot be reopened; several skipped versions are not shown together. | 3 | Account menu `What's new (v1.9.0)` opens a dialog listing every version since last run (icon `jingler-icon-color.png`). | 24b | `session-sidebar.tsx:66`, `use-release-notes.ts:7`, `release-notes.ts:49` |
| F8-04 | The crash screen is plain text with one button. | 4 | Card: "Jingler hit an error", "Agents keep running in the background", `Reload window` (primary), `Copy error details`, `Open logs`. | 25c | `root-error-boundary.tsx:52`, `:82` |
| F8-05 | Recovery cards are drawn for MCP only; runtime-crashed and provider variants are not. | 5 | Three variants of one card: MCP server, Provider, Runtime ("The agent process exited unexpectedly" · `Restart runtime` · `Inspect`). Neutral body, red icon only on failure. | 23 | `runtime-recovery-card.tsx:15-21`, `conversation-pane.tsx:145`, `:843` |
| F8-06 | Plannotator recovery has an RPC but no UI. **Q:** where is it surfaced today? | 5 | Card inside the plan tab: "Plan reviewer disconnected" + `Reopen`. | 17a | `contracts/src/index.ts:1101`, `plannotator-recovery.ts` |
| F8-07 | **Q:** after a crash or relaunch, workspaces that were mid-run have no "Interrupted" state. | 4-5 | Sidebar word "Interrupted" and a transcript card with `Resume`. | 04b | `pi-recovery.spec.ts` (existing coverage to extend) |
| F8-08 | Archived list has no board (footer link only). | 2 | "Archived (14)" opens a searchable list with `Restore` and `Delete` (destructive, confirm). | 25a | `session-sidebar.tsx:646`, `contracts/src/index.ts:800` |
