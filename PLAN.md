# Repo-wide Ponytail cleanup

## Goal

Remove proven dead code and dependencies across the monorepo without breaking package contracts, persisted-data migrations, manual recovery paths, or active Pi provider support.

## Rules

- Delete only files with no production caller, package export, config reference, or operational entry point.
- Treat package exports as contracts. Keep deprecated exported aliases and compatibility props in this pass.
- Keep live legacy migrations, packaging-only Pi/Ponytail dependencies, peer dependencies, and manually invoked recovery/server paths unless product intent proves they are retired.
- Prefer deletion and direct imports over new helpers or abstractions.

## Steps

- [x] Delete isolated dead implementations and their dedicated tests: CLI `bash-tee`, `provider-failure`, `workspace-instructions`; managed-runtime `atomic-handoff`; UI `plan-step-changes`.
- [x] Replace eval-local forwarding imports with canonical certification imports, then delete the three one-line eval shims.
- [x] Remove verified unused dependencies from core, themes, UI, and desktop; regenerate `pnpm-lock.yaml` with pnpm.
- [x] Verify the existing GitHub Issues plugin test is already included by its tracked Vitest config and root project glob; add nothing.
- [x] Run focused package tests/typechecks, root lint/typecheck/test, then run `/ponytail-review` against the final diff and remove any new avoidable complexity.

## Expected cut

- About 1,200 lines from isolated implementation/test islands before shim removal.
- Three forwarding files.
- Candidate dependencies: `node-html-parser`, package-local `fast-check`, themes `effect`, six unused Radix UI packages, UI's unused CLI adapter dev dependency, and desktop's duplicate `tw-animate-css` declaration.

## Explicitly retained

- Exported deprecated APIs such as `PlanCard`, `PlanProgressDock`, `Issue`, and compatibility props.
- Persisted-layout/runtime identity migrations.
- `apps/server`'s manual `dev:hono` path and transcript recovery scripts pending an explicit retirement decision.
- Desktop packaging dependencies used to ship Pi, Ponytail, and `jiti` runtime assets.
- `@testing-library/dom`, which satisfies Testing Library's peer dependency.
- Historical/design docs; lack of internal links alone does not prove they are obsolete.

## Verification

- Deleted module names have no remaining references.
- `pnpm install --lockfile-only` succeeds without adding dependencies.
- Affected package tests and typechecks pass.
- `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass, or any pre-existing failure is recorded exactly.
- Final diff contains no unrelated changes and no new `ponytail:` debt marker without a concrete trigger.
