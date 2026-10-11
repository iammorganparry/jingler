# Memory rollout R2 production record — 2026-08-06

## Deployed state

- Cloudflare Worker: `jingler-memory-worker`
- Durable Worker version: `50d71874-d7cf-4618-b4df-a4d2a5b5417a`
- Vercel project: `bad-apples/jingler-server`
- Promoted Vercel deployment: `dpl_EGCbF5mLNbaqVW5YM3FFSKk6mHEv`
- Production API: `https://api.jingler.dev`
- Rollout revision: `r2-reflection-10-2026-08-06`

Production health returned `status=ok` and `upstream=ok` after promotion. The
active content-free policy is:

- silent agent reflection: 1,000 basis points (10%);
- automatic extraction: 10,000 basis points, review mode;
- conversation-derived publication: review-only;
- automatic publication: 0 basis points;
- relationship generation: 0 basis points;
- automatic stop conditions: enabled;
- stable Workflow IDs: configured;
- scheduled lint: scoped to the sole Trigify organization.

The rollout values are committed in `apps/memory-worker/wrangler.jsonc` so a
normal future Wrangler deployment preserves the reviewed production policy.
The server has the matching rollout revision and reflection percentage in its
production Vercel environment.

## Verification

- `git diff --check`: passed.
- `pnpm lint`: passed with warnings only.
- `pnpm typecheck`: 13/13 tasks passed.
- `pnpm test`: 303 files passed, one skipped; 3,833 tests passed, four skipped.
- Full Electron run after the implementation: 235 passed, one transient
  migration-era onboarding poll failure, two skipped. The transient failure was
  an incomplete JSON read and passed immediately in an isolated traced rerun.
- All new memory journeys passed: natural agent creation, funnel telemetry,
  relationship review, and rollout stops.
- Two reproducible baseline GitHub failures discovered during the first full run
  were corrected narrowly. Their isolated specs passed, and both passed in the
  subsequent full run.
- Cloudflare dry-run and deployment succeeded with Durable Object, R2, compiler,
  lint, and vector-ingest bindings present.
- The protected Vercel candidate health check passed before each promotion; the
  public production health check passed after promotion.

## Live smoke evidence

A new explicit rollout note entered the compiler successfully after deployment.
It produced a structured, cited proposal and is open in the review queue. It was
not approved or described as published. This verifies source ingestion,
compilation, typed proposal persistence, and the review-only production gate.

At the first post-deploy dashboard read, the new funnel ledger had no eligible
post-deploy session-source transitions yet. That is expected immediately after
rollout and is not evidence for expansion.

## Remaining gate

Do not expand beyond 10% reflection or enable automatic publication until the
approved observation window completes: at least two weeks or 100 labeled durable
candidates, whichever is later. Expansion additionally requires the acceptance,
privacy, duplication, terminal-settlement, and error-rate thresholds in
`docs/audits/memory-creation-audit-2026-08-06.md`. Any automatic stop keeps the
affected arm disabled.
