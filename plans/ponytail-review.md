---
title: Ponytail review of project navigation changes
revision: 2
---

## Context
Review the current uncommitted project rail, scoped sessions/explorer, add-project dialog, pinned-session removal, and native preview focus fix. The goal is to keep the root-cause behavior while removing avoidable state, duplicated conditions, dead compatibility UI, and tests that do not prove behavior.

> [!IMPORTANT]
> This is a review-and-simplify pass over the existing working tree. It must preserve the requested three-column layout and the three add-project sources.

## Approach
Trace each new behavior from desktop wiring through UI state to the existing services, then make only findings-backed changes. Prefer deletion, existing helpers, and one owner for each piece of state.

### Confirmed review findings

| Finding | Minimal correction |
|---|---|
| `SessionConversation` writes the remembered session in both `selectSession` and the active-session effect. | Keep the effect as the single persistence path. |
| Core project-switch/remembered-session behavior has helper tests and a manual story, but no component-level behavioral test. | Add one focused `SessionConversation` test covering project scope, remembered selection, and project-scoped creation. |
| The dialog shows three acquisition choices while `AddProjectMethod` still exposes a fourth hidden `browse` choice. | Keep native Finder as an action inside `existing`; remove `browse` from the method union and selection branch. |
| `add-project-dialog.stories.tsx` duplicates the existing interactive add-project harness in `new-workspace-view.stories.tsx`. | Delete the duplicate story and extend/reuse `AddProjectFlow`. |
| `sidebar-identity.spec.ts` dropped attention ordering and the `Needs Input` assertion while adapting to project scope. | Put idle and attention sessions in the same project scope and restore those behavioral assertions. |
| The completed project plan claims automated coverage in files that only had persistent-session tests deleted. | Correct the verification notes after adding the focused coverage. |

> [!NOTE]
> Repeated project/session filtering in the 60px rail is small and readable at expected list sizes; no cache or index is planned. The shared file-browser registry already ensures Explorer and Files use the same actor, so no new state layer is needed.

## Files to modify
- `packages/ui/src/screens/session-conversation.tsx` — remove the duplicate remembered-session write
- `packages/ui/src/screens/session-conversation.test.tsx` — add focused navigation behavior coverage
- `packages/ui/src/composites/add-project-machine.ts` — model exactly the three visible acquisition methods
- `packages/ui/src/composites/add-project-machine.test.ts` — drive Finder through the existing-local flow
- `packages/ui/src/composites/add-project-dialog.stories.tsx` — delete the duplicate preview harness
- `packages/ui/src/composites/new-workspace-view.stories.tsx` — retain the existing interactive add-project story
- `apps/desktop/e2e/sidebar-identity.spec.ts` — restore weakened attention assertions within project scope
- `plans/project-session-navigation.md` — correct verification claims

Review-only unless a concrete issue appears during execution:
- `packages/ui/src/app/session-sidebar.tsx`
- `packages/ui/src/asset/asset-browser.tsx`
- `apps/desktop/src/main/preview-view.ts`

## Reuse
- `projectIdForSession`, `sessionsForProject`, and `preferredSessionId` in `packages/ui/src/app/project-navigation.ts`
- Existing `ProjectService.register`, `ProjectService.createDirectory`, `ProjectService.clone`, and GitHub clone flow
- Existing `AssetRepositoryTree` / file-browser actor for Explorer
- Existing renderer-controlled native preview visibility sets in `apps/desktop/src/main/preview-view.ts`

## Review navigation state and rendering <!-- id: review-navigation -->
Prove that project selection, remembered sessions, splits, and Explorer have one minimal state path.

### Approach
- Trace project and active-session selection in both directions.
- Check whether local storage reads/writes and project synchronization are duplicated or can be reduced.
- Check whether the sidebar API and conditional fragments added more indirection than needed.

- [x] Remove the eager local-storage write from `selectSession`; let the existing active-session effect persist successful selection changes.
- [x] Add one component test that switches projects, restores a remembered session, scopes visible sessions, and starts a session for an empty project.
- [x] Keep `workspaceView` local to `SessionConversation`; it has one owner and no persistence requirement.
- [x] Keep `splitSessions` as the full set so mixed-project split controls can resolve every pane.

### Technical explanation
The new selection logic is concentrated in `SessionConversation`. The active-session effect already synchronizes the project and persists the selected session whenever the parent accepts a selection. Writing in `selectSession` as well is redundant and can record a selection before the parent accepts it. The focused test will exercise the component rather than merely retesting pure helpers.

### Acceptance
- [x] Project switch restores the remembered session (test: packages/ui/src/screens/session-conversation.test.tsx::restores each project's remembered session)
- [x] Empty-project selection calls project-scoped creation (test: packages/ui/src/screens/session-conversation.test.tsx::starts a session for an empty project)
- [x] Explorer follows the focused session worktree (test: apps/desktop/e2e/sidebar-attention-layout.spec.ts::groups chats by attention and opens session views in a responsive two-thirds shell)
- [x] Mixed-project splits render once above project-scoped groups (test: packages/ui/src/app/session-sidebar.test.tsx::draws ONE pill for a split that spans two repo groups)

### Files
- `packages/ui/src/screens/session-conversation.tsx` — M
- `packages/ui/src/screens/session-conversation.test.tsx` — A
- `packages/ui/src/app/session-sidebar.tsx` — R
- `packages/ui/src/app/project-navigation.ts` — R

> complexity: medium

## Review project acquisition <!-- id: review-add-project -->
Keep one clear three-choice flow and remove duplicated state-machine/UI eligibility logic where possible.

### Approach
- Trace generic clone and GitHub clone to the existing project controller.
- Review URL-to-name parsing, loading-state transitions, destination selection, and reset behavior.
- Check whether the hidden `browse` method is still needed or can become an event/detail of the local-repository flow.

- [x] Remove `browse` from `AddProjectMethod` and the top-level `SELECT` branch.
- [x] Keep `BROWSE` as an action from the existing-local directory screen and leave `method` as `existing` while Finder runs.
- [x] Update the acquisition test to reach Finder through `existing` → `BROWSE`.
- [x] Keep the duplicated two-state remote URL transitions: introducing a parent compound state would add more code than it removes.
- [x] Delete `packages/ui/src/composites/add-project-dialog.stories.tsx`; use the existing `AddProjectFlow` harness.
- [x] Preserve `ProjectService.createDirectory` and its new behavior test rather than reimplementing `git init`.

### Technical explanation
The dialog exposes three choices, but the machine still models `browse` as a fourth acquisition method left over from the old menu. Finder is only another way to select an existing local repository, so it needs an event/state, not a separate submission method. Remote URL transitions must remain available while GitHub repositories are loading and after they load; a hierarchical XState refactor would be larger than the current duplication.

### Acceptance
- [x] HTTPS and SSH URLs derive the expected destination name (test: packages/ui/src/composites/add-project-machine.test.ts::derives a destination name from HTTPS and SSH URLs)
- [x] URL clones call the generic clone service (test: packages/ui/src/composites/add-project-machine.test.ts::browses a destination and clones an arbitrary Git URL)
- [x] GitHub picker clones retain installation identity (test: packages/ui/src/composites/add-project-machine.test.ts::loads installation repositories, chooses a clone destination, and clones with identity)
- [x] Finder registers through the existing-local method (test: packages/ui/src/composites/add-project-machine.test.ts::opens Finder from the existing local repository flow)
- [x] New local directories contain `.git` (test: packages/cli-adapters/src/projects.test.ts::creates and initialises a new local repository)

### Files
- `packages/ui/src/composites/add-project-machine.ts` — R/M
- `packages/ui/src/composites/add-project-dialog.tsx` — R
- `packages/ui/src/composites/add-project-machine.test.ts` — M
- `packages/ui/src/composites/add-project-dialog.stories.tsx` — D
- `packages/ui/src/composites/new-workspace-view.stories.tsx` — R/M only if the three choices are not already reachable
- `packages/cli-adapters/src/projects.test.ts` — R

> complexity: medium
> depends: review-navigation

## Review deletions and preview fix <!-- id: review-cleanup -->
Confirm removed pinned-session code is complete and the native preview fix stays at the shared visibility owner.

### Approach
- Search all persistent-session UI references and distinguish compatibility data from removed UI.
- Verify blur/focus lifecycle removal has no leftover listeners or redundant visibility bookkeeping.
- Remove stale tests/comments only when they no longer describe reachable behavior.

- [x] Keep domain decoding and RPC compatibility for stored `persistent` values; no UI callers remain.
- [x] Add one regression case proving legacy persistent data renders as a normal row with no pin action.
- [x] Leave the preview fix at `setOwnerVisible`; no blur/focus listeners or secondary focus state remain.
- [x] Keep the single E2E regression proving blur does not hide a visible preview.
- [x] Restore attention ordering and `Needs Input` assertions in `sidebar-identity.spec.ts` by placing the compared sessions in the same selected project.
- [x] Correct `plans/project-session-navigation.md` so its verification section names tests that actually exist.

### Technical explanation
The preview change deletes focus-specific hiding from the shared native-view service, which is the smallest root-cause fix. Explicit renderer-owned visibility still routes through `setOwnerVisible`. Stored persistent fields and the lone RPC client method remain intentionally compatible. The sidebar identity E2E currently lost unrelated assertions during project-scoping edits; those should be restored rather than accepting weaker coverage.

### Acceptance
- [x] Stored persistent sessions render as ordinary rows without pin controls (test: packages/ui/src/app/session-sidebar.test.tsx::renders persistent data as an ordinary session without pin controls)
- [x] A visible browser preview remains visible after window blur (test: apps/desktop/e2e/previews.spec.ts::retains each session browser while Files owns two split panes)
- [x] Explicit session/tab changes still hide inactive native views (test: apps/desktop/e2e/previews.spec.ts::restores each session's URL, history, scroll, visibility, and cookies)
- [x] Attention order and state label survive project scoping (test: apps/desktop/e2e/sidebar-identity.spec.ts::sidebar prioritises attention and exposes session identity at a glance)

### Files
- `apps/desktop/src/main/preview-view.ts` — R
- `apps/desktop/src/main/preview-view.test.ts` — R
- `apps/desktop/e2e/previews.spec.ts` — R
- `apps/desktop/e2e/sidebar-identity.spec.ts` — M
- `packages/ui/src/app/session-sidebar.test.tsx` — M
- `plans/project-session-navigation.md` — M
- Persistent-session UI files and exports — R

> complexity: low
> depends: review-add-project

## Verification
- `pnpm exec vitest run packages/ui/src/screens/session-conversation.test.tsx packages/ui/src/app/project-navigation.test.ts packages/ui/src/app/project-sidebar.test.tsx packages/ui/src/composites/add-project-machine.test.ts apps/desktop/src/main/preview-view.test.ts packages/cli-adapters/src/projects.test.ts`
- `pnpm --filter @jingler/ui typecheck && pnpm --filter @jingler/desktop typecheck && pnpm --filter @jingler/cli-adapters typecheck`
- `pnpm exec biome check <touched files> && git diff --check`
- Build desktop, then run focused `sidebar-identity.spec.ts`, `sidebar-attention-layout.spec.ts`, and the blur regression in `previews.spec.ts`.
- Manually run existing Storybook flows: project/session switching and `New workspace / AddProjectFlow` for all three project sources.

## Execution results
All 29 steps passed. Focused UI/service tests, UI/desktop/CLI-adapter typechecks, Explorer layout E2E, sidebar identity E2E, browser restoration E2E, and browser-blur E2E passed.

The browser restoration assertion now matches the existing multi-pane model: focusing Chat does not close an adjacent Browser surface, and switching sessions restores each session's Browser pane. Closing Browser still destroys only that session's native resource.

The existing `Screens/New Session / AddProjectFlow` story renders all three project sources, so the duplicate focused story was removed.
