# New sessions use the selected project

- [x] Trace sidebar selection, new-session entry points, and form initialization.
- [x] Give the app and sidebar one selected-project value; preserve explicit PR targets.
- [x] Test sidebar, keyboard, and palette creation from a different/empty project, including persisted session paths.

Also fixed the form's initial fallback effect overwriting its seeded project with the first available project. Late-arriving projects respect the requested/default project.

Validation:
- The desktop reproduction initially created the session in the wrong project.
- All three new desktop regressions pass and verify persisted repoPath/worktreePath after selecting an empty project, with Athena retained as the saved previous repo.
- Full unit suite: 4,429 tests passed.
- Desktop project/workspace suites: 11 passed initially; the existing Plannotator test had a transient fetch failure and passed on focused rerun (all 12 scenarios verified).
- UI and desktop typechecks passed. Scoped lint/complexity checks passed with existing warnings. git diff --check passed.

