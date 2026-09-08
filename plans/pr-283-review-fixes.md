# PR #283 review fixes

- [x] Restore main protection on every explicit opening path and test drag reopening.
- [x] Preserve overflow sessions and active focus during persisted-layout migration.
- [x] Keep controlled rail navigation protected when follow mode is disabled.
- [x] Scope toolbar focus suppression to its owning pane and test nested splits.
- [x] Target benchmark actions by identity, keep main visible, run checks, and push verified changes without GitHub comments.

All five findings are valid. Focused validation: 183 unit tests and six Electron tests passed; both typechecks passed. Nine new regression cases failed against old production code before restoring the fixes. Focused lint has no errors; warnings remain. Benchmark results and workload corrections are recorded in `plans/multi-chat-performance.md`.
