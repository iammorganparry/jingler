# E2E triage (epic/redesign)

| Test | Verdict | Evidence | Fix |
|---|---|---|---|
| parallel-chats.spec.ts:38 | stale | 549e0568 "per-session IDE editor groups (#327)": chats are no longer `role=tab`; sidebar session-tree rows (`button`) + `region "Editor group: <title>"` replace them | Locators updated to region / sidebar-row button; same assertions kept. Passes solo. |
| assets.spec.ts:404 | flaky | passes solo (11s) on merged epic/redesign; baseline failure was selection timing under concurrent e2e load | none |
| responsive.spec.ts:72, :84 | stale | 549e0568 (#327): chat-only groups render the chat-lane header, not `editor-tab-strip` (that testid only exists with file tabs) | Locator -> bar ancestor of the "New tab" launcher; same overflow/visibility asserts. Both pass solo. |
| web-search.spec.ts:36 | stale | `SettingsCard` (components/settings-row.tsx) renders a plain `<section>` + `<h3>`, no aria-label, so it has no `region` role; no commit ever labelled it | Locator -> section containing h3 "Web search"; all later asserts unchanged. Passes solo. |
| sidebar-identity.spec.ts:55 | stale | 193dbbd7 "restyle the project rail (#390)": rail moved from bg-panel to bg-canvas (--sb-canvas #0b0b0c), no longer equals sidebar bg | toHaveCSS now asserts the rail's canvas rgb(11, 11, 12); other asserts kept. Passes solo. |
| rich-plan-scratchpad.spec.ts:47, asset-browser.spec.ts:41, projects-and-workspaces.spec.ts:270, multi-chat-perf.spec.ts:116/:159 | not reached | | |
| chat.spec.ts:75 | known #744 | not fixed | |
| pr-stack.spec.ts:70 | real regression | 8a448af7 (#561) chip row sets a per-session PR request (session-pr-request.ts) that overrides the machine's selection in pull-request-pane.tsx; ⌥[ stepped the machine's stale selection (482) so the shown PR never changed | stepFromShownPr syncs the machine to the shown PR, clears the request, then steps; unit test session-pr-request.test.ts; spec unchanged and passes solo |
| chat.spec.ts:593 | real regression | Error context: click on option "Squash and merge" blocked, the "Pull request details" drawer dialog (pull-request-view.tsx:644, modal) subtree intercepts pointer events. MorphPopoverContent (components/beui/popover-morph.tsx:269) portals to document.body at z-[9999] without pointer-events-auto, so it inherits the modal's body pointer-events:none; ChipMenu in MergeSplitButton was unclickable inside the drawer | Added `pointer-events-auto` to the popover portal wrapper; spec unchanged and passes solo |
| chat.spec.ts:664 | stale | Page snapshot: details rail only shows "Checks 1/1 passing" (pr-side-panel.tsx RailInfoSections, 3bf2884b #442); per-check rows (PrCheckRow, with the "Details for build" link) render only in the Checks evidence tab (pull-request-view.tsx CheckEvidence) | Spec opens the Checks tab via the "Pull request sections" tablist; same link href + duration asserts kept. Passes solo |
| chat.spec.ts:1013 | stale | Error context: click on subagent-chip blocked, `drawer-scrim` (modal PR details drawer in a narrow group, pull-request-view.tsx:640) intercepts pointer events; the spec opened the drawer to start the review and never closed it | Spec presses Escape to dismiss the drawer when its scrim is visible, then clicks the chip; same Reviewer menuitem assert kept. Passes solo |
| github-publish.spec.ts:268 | stale | Page snapshot: Draft badge still renders in the PR header h2 (pr-view-header.tsx:132 via ReadingHeader titleAdornment, reading-shell.tsx:71), but in a narrow group the details drawer is modal so the header is aria-hidden and getByRole(heading) skips it | Heading locator uses includeHidden: true; same visible/removal asserts kept. Passes solo |
| pr-conflict-resolve.spec.ts:9 | stale | Error context: click on header-view-checks blocked, the modal "Pull request details" drawer (pull-request-view.tsx:640) subtree intercepts pointer events; spec opened the drawer to click "Ask agent to resolve conflicts" and never closed it | Spec presses Escape when drawer-scrim is visible, then clicks the header; same conflict-prompt asserts kept. Passes solo |

## lane e2e-editor

| Test | Verdict | Evidence | Fix |
|---|---|---|---|
| architecture-figure.spec.ts:46 | stale | Plan is no longer a pinned header button: header shows Changes/Terminal/Browser + "More views" (page snapshot; packages/ui/src/app/view-overflow-menu.tsx:102, tab-contributions.ts:256) | `openView(window, "plan")`; same figure asserts. Passes solo. |
| browser-control-mcp.spec.ts:26 | stale | 549e0568 (#327): chats are no longer `role=tab`/`editor-tab-chat-*`; chat-only group renders `region "Editor group: Chat 1"` with the composer (page snapshot; packages/ui/src/app/editor-groups.tsx:459) | Click composer inside the chat editor-group region; rest unchanged. Passes solo. |
| obsidian-plugin.spec.ts:7 | stale | At 900px (<1100px) the chat lane is an overlay drawer behind the "Ask" pill (responsive.spec.ts:126), so only `region "Editor group: Obsidian"` exists and no `Resize editor group 1` separator (page snapshot; editor-groups.tsx:320) | Viewport 1200px so the chat/Obsidian split exists; divider dragged to x=880 so the Obsidian pane still narrows below 400px; all stacked-layout asserts kept. Passes solo. |
| sidebar-attention-layout.spec.ts:50 | stale | Files is no longer a view (900d20d9 removed the files tab contribution; open-files absent from the More views menu in page snapshot); files open from the sidebar Explorer as file tabs. Below 1100px chat folds into the Ask-pill drawer (single group) | Open README.md via explorerTree, assert editor-tab-file-README.md + 2 groups at 1500px; at 900px assert 1 group and chat returns via Show chat lane. Passes solo. |
| project-config.spec.ts:6, :78 | stale (not a regression) | a94f9c64 (#478) replaced the composer with `WorkspaceProvisioning` (data-testid workspace-provisioning, Cancel button) while `submitting`; new-workspace-view.tsx:430. Progress is user-visible and already unit-tested (new-workspace-view.test.tsx:100-121: composer gone, Cancel shown, view closes on resolve). Send button never shows "Creating session" in this flow | Specs assert the provisioning pane, no Send button/textbox during creation, and pane gone + 1 session saved after. Both pass solo. |

## lane e2e-last

| Test | Verdict | Evidence | Fix |
|---|---|---|---|
| asset-browser.spec.ts:41 | flaky (already fixed upstream) | fb74e412 "asset-browser asserts selected file tab" already retargeted the spec; on current epic/redesign (2e6701bb) the full file passes (2 passed) including the generated/file-1199.ts textbox assert; tree click after scroll opens the file | none needed |
| plan-mode.spec.ts:228, toasts.spec.ts:24 | flaky | passed solo | none |
