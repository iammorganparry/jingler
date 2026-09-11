# Project sidebar activity and stable order

- [x] Trace the current-main project rail and its live activity input.
- [x] Preserve supplied project order and show running/thinking indicators on project icons.
- [x] Verify with project unit tests, UI/desktop typechecks, scoped lint, and rebuilt desktop e2e.
- [x] Operator approved landing the scoped fix despite unrelated full-check failures.

The original checkout predated the dedicated project rail. Removed the earlier session-group changes when updating to main; the final change targets ProjectSidebar and its caller only.

Validation: 8 project tests and rebuilt desktop e2e passed. UI and desktop typechecks passed. Changed-file Biome and complexity lint passed. Full tests passed before the current-main adjustment; the final full run had 4,157 passing tests and one unrelated randomized remote-session tampering test failure (15/15 passed on focused retry). Full lint fails on unchanged AuthedApp complexity 21/20. Root typecheck is blocked by the server production build requiring BETTER_AUTH_SECRET. No production credentials were read or changed.
