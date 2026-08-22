# Agent-behavior evals

Behavior-contract evals for the pi agent runtime and the Jingler harness. A
scenario declares required/forbidden observations and ordering
(`behavior-contract.ts`); a runner executes it and produces an `EvalTrace`;
`scoreScenario` grades the trace (boolean status plus a 0..1 `score` for
partial credit).

## Scenario families

| Family | Runner | What it can see |
| --- | --- | --- |
| `CORE_PI_SCENARIOS` | `pi-scenario-runner.ts` (real ToolRegistry + pi runtime) | events, tool calls/effects, permissions, file changes, auth routes, resources |
| `SELECTION_PI_SCENARIOS` | same, with two fake MCP servers mounted (memory + distractor) | MCP tool selection, memory propose → workflow-status polling |
| `HARNESS_PI_SCENARIOS` | `harness-scenario-runner.ts` (full `AgentRunner`) | everything above **plus persisted plan-task statuses and dropped checkpoint markers** |
| `LIVE_HARNESS_PI_SCENARIOS` | full harness, real model, pass@k (majority of 3) | does a real model emit `PLAN_TASK` checkpoints unprompted |
| `REPLAY_PI_SCENARIOS` | recorded transcripts via `replay/transcript-to-trace.ts` | claimed checkpoints, tool names, plan proposals |

## Running

```bash
pnpm --filter @jingler/cli-adapters eval:pi:deterministic   # what CI runs on every PR
pnpm vitest run packages/cli-adapters/evals                  # same scenarios, vitest DX (-t <id>, watch)
JINGLER_REPLAY_TRACE=evals/replay/fixtures/<f>.json pnpm --filter @jingler/cli-adapters eval:pi:replay
pnpm --filter @jingler/cli-adapters eval:pi:live             # manual only; real providers, cost-gated
```

Live runs are triggered by the manual `pi-provider-evals.yml` workflow.
Knobs: `JINGLER_EVAL_MAX_COST_USD` (ceiling, samples included),
`JINGLER_EVAL_PLAN_SAMPLES` (pass@k sample count, default 3).

## Turning a real session into a regression fixture

```bash
pnpm --filter @jingler/cli-adapters exec tsx evals/replay/build-trace.ts \
  ~/jingler/transcripts/<chatId>.json plan.task-status-replay out.json
```

The converter keeps only tool names, plan checkpoint ids, and event tags — no
prose, arguments, paths, or file contents — so the output is safe to check in
under `evals/replay/fixtures/`. `replay/replay-fixture.test.ts` pins the
2026-08-22 regressed session (plan executed, zero checkpoints emitted) as a
permanent must-FAIL guard: if that fixture ever scores `passed`, the eval has
gone blind.
