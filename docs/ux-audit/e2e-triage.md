# E2E triage (epic/redesign)

| Test | Verdict | Evidence | Fix |
|---|---|---|---|
| parallel-chats.spec.ts:38 | stale | 549e0568 "per-session IDE editor groups (#327)": chats are no longer `role=tab`; sidebar session-tree rows (`button`) + `region "Editor group: <title>"` replace them | Locators updated to region / sidebar-row button; same assertions kept. Passes solo. |
| assets.spec.ts:404 | not reached | | |
| responsive.spec.ts:72, :84 | not reached | | |
| project-config.spec.ts:6, :78 | not reached | | |
| web-search.spec.ts:36 | not reached | | |
| sidebar-identity.spec.ts:55, rich-plan-scratchpad.spec.ts:47, asset-browser.spec.ts:41, projects-and-workspaces.spec.ts:270, multi-chat-perf.spec.ts:116/:159 | not reached | | |
| chat.spec.ts:75 | known #744 | not fixed | |
