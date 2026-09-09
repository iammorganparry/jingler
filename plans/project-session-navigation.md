---
title: Projects first, sessions beside them
revision: 2
---

## Context
Rework navigation to follow the supplied reference: a project sidebar, an adjacent workspace column with Sessions / Explorer tabs, and the active content on the right. Explorer means the actual file tree, not another session list. Keep Jingler's existing visual language unless requested otherwise.

Initial inspection: Jingler currently combines repository grouping, session rows, filters, global destinations, and account actions in `packages/ui/src/app/session-sidebar.tsx`. Desktop file browsing already exists in `apps/desktop/src/renderer/file-browser-view.tsx`. This is a layout and navigation change, not a new project or file system backend.

## Approach
- Separate project navigation from the selected project's sessions.
- Reuse existing session actions, activity, split groups, and file browsing.
- Keep Jingler styling. Project clicks reopen the last-used session; Explorer follows the focused session's worktree.
- Store last-used session per project in existing browser-storage style, validate stored IDs against available sessions, and synchronize project selection for command search, notifications, session creation, and split-pane focus.
- Match sessions by projectId first, then origin repoPath plus environment; use legacy repo names only when uniquely resolvable. Keep unmatched/ambiguous legacy sessions reachable in an Unassigned group rather than silently hiding or misassigning them.
- Preserve mixed-project splits as existing groups; list a group under projects containing its sessions and focus that project's member on selection. Explicit focus on another member updates the selected project and Explorer.
- Start with approximately 220px project and 300px workspace columns, using existing resize controls. Collapse projects to a keyboard/click-accessible rail first, then place workspace navigation in a dismissible overlay at narrow widths. Keep existing themes and reduced-motion behavior.

## Files to modify
Candidate files; refine after tracing the complete rendering and selection flow:
- `packages/ui/src/app/session-sidebar.tsx` — separate global/project navigation from sessions.
- `packages/ui/src/app/jingler-app.tsx` — coordinate project selection with workspace content.
- `apps/desktop/src/renderer/App.tsx` — connect desktop file browsing to the new navigation.
- `apps/desktop/src/renderer/file-browser-view.tsx` — reuse the file tree in Explorer without duplicating file state.
- `apps/desktop/e2e/sidebar-attention-layout.spec.ts` — update layout expectations and cover project-scoped navigation.

## Reuse
- `SessionRow`, `SplitRow`, existing sidebar action callbacks, and the shared `Avatar` / `HoverCard` components.
- Session filtering/grouping in `packages/ui/src/app/session-filters.ts`.
- Existing resizable-width controls and width-tier responsiveness.
- `useFileBrowser` and existing file-open/close behavior.

## Separate project and session navigation <!-- id: project-navigation -->
Make projects the first column and selected-project sessions the second.

### Approach
- Use Project.id and Session.projectId / repoPath from `packages/core/src/domain.ts`; no schema or server changes. Keep identity resolution in one small tested repo-local helper, `packages/ui/src/app/project-navigation.ts`.
- Split the existing sidebar body into project navigation and workspace content in the same module; thread project props through SessionConversation.
- Move global destinations and account actions to the project column. Keep session search, attention grouping, persistent sessions, filters, and row actions in the workspace column; remove redundant repository grouping/filter controls there.
- Wire project selection and per-project last-used sessions in JinglerApp using the existing session selection callbacks. Default New Session to the selected project; reuse the Add Project dialog.
- Preserve session actions and existing attention indicators.

- [x] Implement project selection and the adjacent project-scoped session list.

### Acceptance
- [x] Selecting a project lists only its sessions; selecting a session opens its existing content.
- [x] Projects without sessions remain reachable; global destinations and account actions remain reachable.

### Files
- `packages/ui/src/app/session-sidebar.tsx` — M
- `packages/ui/src/app/project-navigation.ts` — A
- `packages/ui/src/app/project-navigation.test.ts` — A
- `packages/ui/src/app/jingler-app.tsx` — M
- `packages/ui/src/screens/session-conversation.tsx` — M

> complexity: medium

## Place file browsing in Explorer <!-- id: workspace-explorer -->
Switch the workspace column between Sessions and the real file tree.

### Approach
- Add a renderExplorer slot alongside renderFiles and thread it through JinglerApp and SessionConversation; keep filesystem calls in desktop code.
- Reuse AssetFileTree and extract the existing loading/error/retry tree wrapper in `packages/ui/src/asset/asset-browser.tsx` for shared use. Allow the main file canvas to omit its embedded tree so Explorer is the only visible tree.
- Render the Explorer tree from the existing session browser actor; open files through the existing onOpenFile path into the main content area. Retain per-file actor instances for editors (the current browser intentionally keys these by session plus file); do not replace them with a single draft or add new independent state.
- Keep quick-open and Files entry points working, routing tree navigation to Explorer. Preserve dirty-file confirmation, asset previews, follow-agent, and debugger behavior.
- Label the focused worktree; show existing loading/error/retry behavior for unavailable worktrees. No main-checkout fallback.

- [x] Wire Sessions / Explorer tabs to the existing file browsing flow.

### Acceptance
- [x] Explorer opens files from the chosen root without losing session or editor state.

### Files
- `apps/desktop/src/renderer/App.tsx` — M
- `apps/desktop/src/renderer/file-browser-view.tsx` — M
- `packages/ui/src/asset/asset-browser.tsx` — M
- `packages/ui/src/index.ts` — M (export shared tree wrapper if needed)
- `packages/ui/src/app/jingler-app.tsx` — M
- `packages/ui/src/screens/session-conversation.tsx` — M

> complexity: medium
> depends: project-navigation

## Verify navigation and responsive layout <!-- id: navigation-verification -->
Protect existing session behavior while testing the new column structure.

### Approach
- Extend existing UI and desktop tests rather than adding a new test harness.
- Check narrow windows, keyboard access, resizing, and split sessions.

- [x] Add behavioral coverage and run affected tests and type checks.

### Acceptance
- [x] Project switching, Explorer switching, session creation, and file opening pass automated checks.
- [x] Narrow layouts keep all navigation reachable without squeezing active content out of view.

### Files
- `packages/ui/src/app/session-sidebar.test.tsx` — M
- `packages/ui/src/app/session-sidebar.responsive.test.tsx` — M
- `apps/desktop/e2e/sidebar-attention-layout.spec.ts` — M

> complexity: medium
> depends: workspace-explorer

## Verification
Implemented and verified. Behavioral coverage:
- `packages/ui/src/app/project-navigation.test.ts`: project identity beats duplicate names; legacy fallback is environment-scoped; ambiguous sessions stay reachable; stale remembered selection falls back safely.
- `packages/ui/src/screens/session-conversation.test.tsx`: project-scoped lists, remembered session restoration, and empty-project creation.
- `packages/ui/src/app/session-sidebar.test.tsx`: session identity, split placement, and legacy persistent data rendered as ordinary rows.
- `packages/ui/src/app/session-sidebar.responsive.test.tsx`: existing sidebar width-tier behavior; not a project-rail integration test.
- `apps/desktop/e2e/sidebar-attention-layout.spec.ts`: attention order and Explorer/file layout at desktop widths.
- `packages/ui/src/screens/project-session-flow.stories.tsx`: manual interactive project navigation preview, not an automated integration test.
- `apps/desktop/e2e/sidebar-attention-layout.spec.ts`: switching A → B → A restores sessions; Explorer follows focused worktree; opening a file preserves unsaved edits across navigation; no duplicate visible file tree.
- Existing file-browser-machine and use-file-browser tests must remain green; add focused coverage if integration changes require it.

Run:
```sh
pnpm exec vitest run packages/ui/src/app/project-navigation.test.ts packages/ui/src/app/session-sidebar.test.tsx packages/ui/src/app/session-sidebar.responsive.test.tsx packages/ui/src/asset/asset-browser.test.tsx apps/desktop/src/renderer/file-browser-machine.test.ts apps/desktop/src/renderer/use-file-browser.test.ts
pnpm --filter @jingler/ui typecheck
pnpm --filter @jingler/desktop typecheck
pnpm --filter @jingler/desktop e2e -- sidebar-attention-layout.spec.ts sidebar-identity.spec.ts
```
Manually check 1500px, 900px, and 700px layouts in the visible in-app preview when available, including project switching, Explorer tab keyboard navigation, resizing, split focus, and global destinations. Use the repository's Electron E2E harness for native-only behavior.

This reuses installed components and repo-local APIs without changing external SDK calls or adding dependencies. If implementation requires changing Pierre or framework integration APIs, consult current official docs against installed versions before that change.

## Confirmed decisions
- Adopt the reference's layout only; retain Jingler's existing styling.
- Explorer follows the active session's worktree, with an explicit branch/worktree label.

## Additional findings
- The actual sidebar/content composition is in `packages/ui/src/screens/session-conversation.tsx:297`; this file must change in both navigation stages.
- Registered projects already reach `JinglerApp` separately from repositories. Reuse these so projects with no sessions appear; reuse the existing Add Project dialog and project-scoped new-session request instead of creating another onboarding flow.
- The existing sidebar translates repository paths to display names. New project selection must use durable identity, not display names, to avoid merging unrelated checkouts with the same name. Trace session-to-project mapping before implementation.
- `FileBrowserView` currently embeds tree and editor together in `AssetBrowser`. Separate their placement while retaining the existing controller, unsaved-change confirmation, debugger integration, quick-open, and follow-agent behavior. Do not mount a second editor or duplicate browser state to populate Explorer.
- Preserve cross-project split groups; Explorer follows the focused pane, not an arbitrary group member.
- Keep global search, pull requests, Memory, and account/settings in the project column. Do not add the reference's Notes or other unrelated features.

## Open decisions
None. Project selection reopens its last-used available session; if none was previously selected, choose the most recently updated non-archived session. Empty projects show a project-scoped New Session prompt and Explorer explains that a session is needed. Archived sessions remain accessible through the existing filter.

## Verification commands identified
- `pnpm exec vitest run packages/ui/src/app/session-sidebar.test.tsx packages/ui/src/app/session-sidebar.responsive.test.tsx`
- `pnpm --filter @jingler/ui typecheck`
- `pnpm --filter @jingler/desktop typecheck`
- Desktop E2E uses `apps/desktop/scripts/run-e2e.mjs`; confirm argument forwarding before specifying the focused command.
