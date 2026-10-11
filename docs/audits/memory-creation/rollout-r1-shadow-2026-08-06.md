# R1 compiler-review shadow evidence — 2026-08-06

Plan `449de134-ebee-4064-8574-3bf0ae274be7`, revision 156. This is a bounded,
content-redacted local shadow evaluation; it made no hosted proposal, review,
publication, replay, or deployment mutation.

## Corpus and method

- Fixed corpus: `apps/memory-worker/src/testing/memory-creation-corpus.ts`.
- Scope: 17 redacted cases derived from the settled audit rubric, including 11
  durable positives and explicit negatives for labels/progress, ephemeral detail,
  corrections, credentials, personal data, sensitive categories, and exact
  duplication.
- Evaluator: the production deterministic `CompilerModel` interface with bounded
  accepted-page context and body-aware target matching.
- Command: `pnpm --filter @jingler/memory-worker exec vitest run
  src/workflows/compiler-evaluation.test.ts`.

## Observed R1 result

| Metric | Result | Review-rollout guardrail |
| --- | ---: | ---: |
| Cases | 17 | Bounded shadow only |
| Expected durable candidates | 11 | — |
| Emitted candidates | 11 | At most three per source |
| Candidate recall | 100% | At least 90% corpus guardrail |
| Candidate precision | 100% | At least 95% corpus guardrail |
| Target action accuracy | 100% | Update/create/no-op must be correct |
| Exact/near duplicate rate | 0% | 0% corpus guardrail; at most 2% rollout |
| Sensitivity-class escapes | 0 | Zero |
| Credential/personal-data escapes | 0 | Zero |

The evaluator passed, as did the two-generic-title, update-selection, no-op,
typed-failure, and replay regressions in the Worker compiler suite. This establishes
local R1 correctness on the fixed corpus; it does not establish production quality.

## Gate decision

R1 remains **review-only**. The fixed 17-case corpus is below the audit's production
exit sample of 100 redacted historical sources and cannot supply a real workflow
error rate or human accept-as-is rate. No historical failure was bulk replayed. The
next production increment may deploy the instrumented compiler under review, but
reflection expansion and automatic publication remain gated on their real minimum
sample windows.
