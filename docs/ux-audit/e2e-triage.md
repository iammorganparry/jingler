# E2E triage (epic/redesign)

| Test | Verdict | Evidence | Fix |
|---|---|---|---|
| parallel-chats.spec.ts:38 | stale | 549e0568 "per-session IDE editor groups (#327)": chats are no longer `role=tab`; sidebar session-tree rows (`button`) + `region "Editor group: <title>"` replace them | Locators updated to region / sidebar-row button; same assertions kept. Passes solo. |
| assets.spec.ts:404 | flaky | passes solo (11s) on merged epic/redesign; baseline failure was selection timing under concurrent e2e load | none |
| responsive.spec.ts:72, :84 | stale | 549e0568 (#327): chat-only groups render the chat-lane header, not `editor-tab-strip` (that testid only exists with file tabs) | Locator -> bar ancestor of the "New tab" launcher; same overflow/visibility asserts. Both pass solo. |
| project-config.spec.ts:6, :78 | undetermined (possible regression, left failing) | Both fail waiting for `button "Creating session"` (composer.tsx:913, from 664a2ea7 #348). Page snapshot shows the session already created and the chat view open, with the new-session composer gone, so the spinner state is never observable. Not yet determined whether new-workspace-view now unmounts on session creation before setup/naming finishes (user-facing loss of the send-button progress) or the spec just races. | None; needs a dev to confirm the intended UX. |
| web-search.spec.ts:36 | stale | `SettingsCard` (components/settings-row.tsx) renders a plain `<section>` + `<h3>`, no aria-label, so it has no `region` role; no commit ever labelled it | Locator -> section containing h3 "Web search"; all later asserts unchanged. Passes solo. |
| sidebar-identity.spec.ts:55 | stale | 193dbbd7 "restyle the project rail (#390)": rail moved from bg-panel to bg-canvas (--sb-canvas #0b0b0c), no longer equals sidebar bg | toHaveCSS now asserts the rail's canvas rgb(11, 11, 12); other asserts kept. Passes solo. |
| rich-plan-scratchpad.spec.ts:47, asset-browser.spec.ts:41, projects-and-workspaces.spec.ts:270, multi-chat-perf.spec.ts:116/:159 | not reached | | |
| chat.spec.ts:75 | known #744 | not fixed | |

## lane e2e-editor

| Test | Verdict | Evidence | Fix |
|---|---|---|---|
| architecture-figure.spec.ts:46 | stale | Plan is no longer a pinned header button: header shows Changes/Terminal/Browser + "More views" (page snapshot; packages/ui/src/app/view-overflow-menu.tsx:102, tab-contributions.ts:256) | `openView(window, "plan")`; same figure asserts. Passes solo. |
| browser-control-mcp.spec.ts:26 | stale | 549e0568 (#327): chats are no longer `role=tab`/`editor-tab-chat-*`; chat-only group renders `region "Editor group: Chat 1"` with the composer (page snapshot; packages/ui/src/app/editor-groups.tsx:459) | Click composer inside the chat editor-group region; rest unchanged. Passes solo. |
