# Follow-agent loader flashing — acceptance

## Fix

Repeated follow notifications were refreshing tree/diff/file state, and path-owned viewers were reopening the same file. Identical mutation notifications are now no-ops; late preview metadata does not reload bytes. Incoming path identity remains separate from resolved rename destinations. New edits, paths, completion transitions, explicit reload and re-follow still work.

Navigation uses React's Effect Event so a changed callback cannot replay the current activity. Pierre CodeView's hover bridges retain callback identity; inactive annotation renderers are omitted. This prevents unchanged rows from being rebuilt during streamed snapshots.

## Evidence

- Built-in live monitor before the fix: FileBrowserView 12,557 renders; FileCanvas 12,560; AssetCanvas 3,435. Aggregate observation, not an isolated benchmark or post-fix CPU claim. Render tracking was stopped afterward; no monitor credentials were recorded.
- Red/green unit reproduction: read/diff/list calls `[1,1,2] → [2,7,8]` with a loading entry before; unchanged `[1,1,2]` and zero loading entries after.
- Fresh-built real Electron: **11/11 passed, 3.7 minutes** (`file-browser-ide.spec.ts`, `file-pane-render-stability.spec.ts`). Streaming regression covers two actual writes to the same file and a different file; visible changed contents, continued per-turn text growth, zero DOM mutations/removals, same rendered host/code. Observers disconnect in `finally`.
- Root `pnpm test`: **5,162 passed, 5 skipped** (4,899 + 50 + 53 + 25 + 135), about 4.6 minutes. Root lint: zero errors; existing warnings reported. Root typecheck: **21 successful tasks, 1m2.3s**, subprocess-only generated build credentials/invalid fixture URL.
- Independent final source review `15751783`: **OK; no issues found**. Review did not run Electron or certify providers/platforms. `git diff --check` passed.

## Failure triage

Initial Electron acceptance exposed remaining UI callback replays and Pierre row redraws; fixed production behavior, retained every assertion. Fixture markers were made exact and turn-specific to avoid matching injected context/older paragraphs. One concurrent full unit run hit the unchanged IPv6 port availability test: its closed IPv6 socket does not prove the IPv4 family is free. Controlled reproduction against merged main `e6e67778` with a remaining IPv4 owner returned false correctly; isolated tests passed. No port implementation/test changes. Final unit gate ran without the concurrent Electron/network job and passed; the earlier red run is not counted as a pass.

## Guides and limits

Installed React **19.2.7** / React types **19.2.17**: [Effect Events](https://react.dev/reference/react/useEffectEvent). Installed `@pierre/diffs` **1.5.1**: [official docs](https://diffs.com/docs), checked against installed CodeView option comparison; callback reference changes redraw rows.

Pi responses are scripted; production runtime, filesystem edits, RPC, Git diffs and rendered DOM are real. Bounded observation, not permanent absence of all future redraws. Mutation identity uses existing producer tool IDs; no new producer-ID guarantee. No external QA check is configured. No release triggered.
