# Imported projects and predictable navigation

- [x] Trace registration, legacy session migration, and desktop/device listing.
- [x] Mark explicit imports and session-backed projects; hide unmarked legacy registrations and stop directory-wide auto-imports.
- [x] Remember each project's last viewed session while the app is open; fall back to the newest non-archived session and show empty projects without stale content.
- [x] Verify migration, re-import, sidebar visibility, active-session-count ordering, session navigation, and remote checkout reuse.

Operator chose to hide existing registrations without sessions until imported again. No repositories, sessions, or stored registrations are deleted. Project order remains descending non-archived session count, independent of selection.

Validation:
- Full `pnpm test`: 4,426 tests passed across all five suites.
- Rebuilt desktop project/workspace suites: 9 tests passed, including import/re-import, clone, direct/worktree creation, legacy migration, activity, stable ordering, and last-viewed navigation.
- Real-filesystem device tests cover reusing an unimported matching checkout and cloning to a safe suffix when a different unimported checkout occupies the destination. Only the requested project is registered.
- `pnpm -r --if-present run typecheck`: all package typechecks passed.
- Changed-code complexity checks passed; full lint retains the unchanged AuthedApp complexity failure (21/20).
- Root `pnpm typecheck` remains blocked by the unrelated server production build requiring BETTER_AUTH_SECRET. No production credentials were read or changed.
- `git diff --check` passed.
