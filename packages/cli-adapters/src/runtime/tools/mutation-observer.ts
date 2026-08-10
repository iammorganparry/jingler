import { Effect } from "effect"
import type {
  FileChangeTracker,
  WorktreeSnapshot
} from "../file-changes/file-change-tracker.js"
import type { RunJournal } from "../journal/run-journal.js"
import {
  ToolError,
  type ToolExecutionRequest,
  type ToolExecutionObserver,
  type ToolResultEnvelope,
  type ToolRisk
} from "./tool-registry.js"

export interface MutationObserverOptions {
  readonly cwd: string
  readonly runId: string
  readonly tracker: FileChangeTracker
  readonly journal: RunJournal
}

const failureCode = (result: ToolResultEnvelope): string | null =>
  result.error?.code ?? null

const callIdFor = (request: ToolExecutionRequest): string | null =>
  request.callId ?? request.idempotencyKey ?? null

const startMutation = (
  options: MutationObserverOptions,
  request: ToolExecutionRequest,
  risk: ToolRisk
): Effect.Effect<WorktreeSnapshot, ToolError> =>
  Effect.gen(function* () {
    const callId = callIdFor(request)
    if (!callId) {
      return yield* Effect.fail(
        new ToolError("invalid-input", "Mutation tool requires a call id")
      )
    }
    const snapshot = yield* options.tracker.capture(options.cwd).pipe(
      Effect.mapError(
        (cause) => new ToolError("execution-failed", cause.message, false)
      )
    )
    yield* options.journal
      .start({
        callId,
        runId: options.runId,
        toolId: request.id,
        risk,
        targetCategory: "workspace"
      })
      .pipe(
        Effect.mapError(
          (cause) => new ToolError("execution-failed", cause.message, false)
        )
      )
    return snapshot
  })

const settleMutation = (
  options: MutationObserverOptions,
  request: ToolExecutionRequest,
  state: WorktreeSnapshot,
  result: ToolResultEnvelope
) =>
  Effect.gen(function* () {
    const callId = callIdFor(request)
    if (!callId) {
      return yield* Effect.fail(
        new ToolError("execution-failed", "Mutation receipt state is missing")
      )
    }
    const changes = yield* options.tracker
      .compare(state, options.cwd, callId)
      .pipe(
        Effect.mapError(
          (cause) => new ToolError("execution-failed", cause.message, false)
        )
      )
    yield* options.journal
      .settle({
        callId,
        status:
          result.status === "success"
            ? "settled"
            : result.status === "cancelled"
              ? "cancelled"
              : "failed",
        resultSummary: result.status,
        failureCode: failureCode(result),
        fileChangeSetIds: [changes.id]
      })
      .pipe(
        Effect.mapError(
          (cause) => new ToolError("execution-failed", cause.message, false)
        )
      )
    return changes
  })

/** Couple actual worktree evidence and durable receipts around mutating tools. */
export const createMutationObserver = (
  options: MutationObserverOptions
): ToolExecutionObserver => ({
  started: (request, risk) => startMutation(options, request, risk),
  settled: (request, _risk, state, result) =>
    settleMutation(options, request, state, result)
})
