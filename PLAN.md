# Remove shared Memory

## Goal

Delete the shared/team Memory feature from the repository end to end. Preserve published changelog history and unrelated process-memory/retention code. Do not delete deployed cloud resources automatically; provide an explicit teardown checklist for operators.

## Steps

- [x] Delete the dedicated `apps/memory-worker` and `packages/memory` workspaces, feature docs/audits, active Memory changeset, desktop/UI/runtime/server Memory modules, and feature-only tests.
- [x] Remove Memory wiring from shared desktop, UI, CLI adapter, core/contracts, server, database schema, environment, CI, and package files while preserving unrelated retention and path-safety behavior.
- [x] Regenerate `pnpm-lock.yaml` and remove stale Memory exports, routes, dependencies, scripts, fixtures, and generated contract references.
- [x] Add a concise infrastructure teardown checklist covering the Worker, Workflows, Durable Objects, R2 data, secrets, environment variables, and verification, with destructive data deletion clearly separated.
- [x] Run targeted typechecks/tests while resolving compile fallout, then run repository lint, typecheck, and tests.
- [x] Search for feature residue and review the final diff for accidental removal of generic memory-management code.

## Guardrails

- Keep historical package changelog entries that document already-published releases.
- Keep unrelated personal access token code only if a non-Memory caller exists; otherwise remove it with the Memory MCP API.
- Keep generic process memory, renderer retention, context compaction, and resource-pressure behavior.
- No compatibility stubs or dormant feature flags: removal means the product, runtime hooks, APIs, packages, deployment job, tests, and current docs are gone.
- Infrastructure teardown remains a manual operator action because Worker/R2 deletion is irreversible and cannot be safely inferred from repository state.

## Validation

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @jingler/server test
pnpm --filter @jingler/desktop build
git grep -nE '@jingler/memory|memory-worker|MEMORY_(ENABLED|GRANT|WORKER|REQUEST)|memory_(recall|retain|reflect|propose|workflow|suggestions)|shared-memory|team memory'
```
