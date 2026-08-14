import { getSandbox } from "@cloudflare/sandbox"
import type { OffloadJobResult } from "@jingler/core"
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers"
import { Effect } from "effect"
import { issueOffloadGrant } from "./offload-grant.js"
import { INTERNAL_ROUTES } from "./internal-routes.js"
import {
  OffloadJobStore,
  makeOffloadJobStoreLayer
} from "./offload-store.js"
import {
  executeOffloadCommand,
  primeOffloadWorkspace,
  restoreOffloadSnapshot,
  OffloadWorkspaceError
} from "./offload-workspace.js"
import type { ManagedRuntimeEnv } from "./runtime-env.js"
import { sandboxIdForSession } from "./runtime-identity.js"

export interface OffloadWorkflowInput {
  readonly jobId: string
}

const retry = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: "15 minutes"
} as const
const executionRetry = {
  retries: { limit: 2, delay: "5 seconds", backoff: "constant" },
  timeout: "35 minutes"
} as const

const cancelledResult = (
  jobId: string,
  createdAt: number
): OffloadJobResult => ({
  version: 1,
  jobId,
  state: "cancelled",
  exitCode: null,
  failureReason: null,
  stdout: "",
  stderr: "",
  outputTruncated: false,
  timings: {
    queuedMs: Math.max(0, Date.now() - createdAt * 1_000),
    snapshotMs: 0,
    hydrationMs: 0,
    dependencyMs: 0,
    commandMs: 0
  }
})

const failedResult = (
  jobId: string,
  message: string,
  failureReason: OffloadJobResult["failureReason"] = "runtime-failed"
): OffloadJobResult => ({
  version: 1,
  jobId,
  state: "failed",
  exitCode: null,
  failureReason,
  stdout: "",
  stderr: message.slice(0, 64 * 1024),
  outputTruncated: message.length > 64 * 1024,
  timings: {
    queuedMs: 0,
    snapshotMs: 0,
    hydrationMs: 0,
    dependencyMs: 0,
    commandMs: 0
  }
})

const appendOutput = (
  jobId: string,
  stream: "stdout" | "stderr",
  output: string
): Effect.Effect<void, unknown, OffloadJobStore> =>
  Effect.gen(function* () {
    const store = yield* OffloadJobStore
    yield* Effect.forEach(
      output.match(/[\s\S]{1,65536}/gu) ?? [],
      (text) => store.append(jobId, { kind: "output", stream, text }),
      { discard: true }
    )
  })

const releaseOffloadSlot = async (
  env: ManagedRuntimeEnv,
  jobId: string
): Promise<void> => {
  const layer = makeOffloadJobStoreLayer(env.OFFLOAD_JOBS)
  const record = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* OffloadJobStore
      return yield* store.get(jobId)
    }).pipe(Effect.provide(layer))
  ).catch(() => null)
  if (record === null) return
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* OffloadJobStore
      yield* store.removeSnapshot(jobId)
    }).pipe(
      Effect.provide(layer),
      Effect.catchAll(() => Effect.void)
    )
  )
  await Promise.all([
    env.MANAGED_ACCOUNT.getByName(record.subject).fetch(
      INTERNAL_ROUTES.managedAccount.offloadUnregister,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: record.subject, jobId })
      }
    ),
    env.OFFLOAD_SANDBOX_LIFECYCLE.getByName(record.request.sessionId).fetch(
      INTERNAL_ROUTES.offloadLifecycle.touch,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: record.subject,
          sessionId: record.request.sessionId
        })
      }
    )
  ]).catch(() => undefined)
}

export const runOffloadWorkflow = async (
  env: ManagedRuntimeEnv,
  input: OffloadWorkflowInput,
  step: WorkflowStep
): Promise<OffloadJobResult> => {
  const storeLayer = makeOffloadJobStoreLayer(env.OFFLOAD_JOBS)
  try {
    const prepared = await step.do("hydrate exact workspace", retry, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* OffloadJobStore
          const record = yield* store.get(input.jobId)
          if (record.cancelRequested) {
            const result = cancelledResult(record.jobId, record.createdAt)
            yield* store.finish(record.jobId, result)
            return { cancelled: true as const, result }
          }
          yield* store.append(record.jobId, {
            kind: "state",
            state: "preparing"
          })
          const gitGrant = yield* issueOffloadGrant(
            {
              subject: record.subject,
              sessionId: record.request.sessionId,
              jobId: record.jobId,
              idempotencyKey: record.request.idempotencyKey,
              repositorySlug: record.request.repositorySlug,
              snapshotDigest: record.request.snapshot.digest,
              actions: ["git.read"]
            },
            env.MANAGED_RUNTIME_GRANT_SECRET
          )
          const sandboxId = yield* Effect.tryPromise(() =>
            sandboxIdForSession(`offload_${record.request.sessionId}`)
          )
          const touched = yield* Effect.tryPromise(() =>
            env.OFFLOAD_SANDBOX_LIFECYCLE.getByName(record.request.sessionId).fetch(
              INTERNAL_ROUTES.offloadLifecycle.touch,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
          subject: record.subject,
          sessionId: record.request.sessionId
        })
              }
            )
          )
          if (!touched.ok) return yield* Effect.fail(new Error("Sandbox lifecycle unavailable"))
          const sandbox = getSandbox(env.Sandbox, sandboxId, {
            transport: "rpc",
            normalizeId: true,
            enableDefaultSession: false,
            sleepAfter: "10m"
          })
          const workspace = yield* primeOffloadWorkspace(
            sandbox,
            record,
            env.MANAGED_RUNTIME_ORIGIN,
            gitGrant.grant
          )
          return {
            cancelled: false as const,
            hydrationMs: workspace.hydrationMs,
            dependencyMs: workspace.dependencyMs,
            sandboxId,
            queuedMs: Math.max(0, Date.now() - record.createdAt * 1_000)
          }
        }).pipe(Effect.provide(storeLayer))
      )
    )
    if (prepared.cancelled) return prepared.result

    await step.waitForEvent("wait for exact snapshot", {
      type: "snapshot-ready",
      timeout: "10 minutes"
    })
    const sourceDigest = await step.do("restore exact snapshot", retry, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* OffloadJobStore
          const record = yield* store.get(input.jobId)
          const snapshot = yield* store.getSnapshot(record.jobId)
          const sandbox = getSandbox(env.Sandbox, prepared.sandboxId, {
            transport: "rpc",
            normalizeId: true,
            enableDefaultSession: false,
            sleepAfter: "10m"
          })
          return yield* restoreOffloadSnapshot(
            sandbox,
            record.jobId,
            snapshot
          )
        }).pipe(Effect.provide(storeLayer))
      )
    )

    const result = await step.do("execute admitted argv", executionRetry, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* OffloadJobStore
          const record = yield* store.get(input.jobId)
          if (record.result !== null) return record.result
          if (record.cancelRequested) {
            const cancelled = cancelledResult(record.jobId, record.createdAt)
            yield* store.finish(record.jobId, cancelled)
            return cancelled
          }
          const lease = yield* store.acquireExecution(record.jobId)
          if (lease === "completed") {
            const settled = yield* store.get(record.jobId)
            if (settled.result !== null) return settled.result
          }
          yield* store.append(record.jobId, {
            kind: "state",
            state: "running"
          })
          const sandbox = getSandbox(env.Sandbox, prepared.sandboxId, {
            transport: "rpc",
            normalizeId: true,
            enableDefaultSession: false,
            sleepAfter: "10m"
          })
          return yield* executeOffloadCommand(
            sandbox,
            record.jobId,
            record.request,
            sourceDigest,
            {
              queuedMs: prepared.queuedMs,
              snapshotMs: 0,
              hydrationMs: prepared.hydrationMs,
              dependencyMs: prepared.dependencyMs
            }
          )
        }).pipe(Effect.provide(storeLayer))
      )
    )

    await step.do("persist terminal result", retry, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* OffloadJobStore
          yield* appendOutput(input.jobId, "stdout", result.stdout)
          yield* appendOutput(input.jobId, "stderr", result.stderr)
          yield* store.finish(input.jobId, result)
        }).pipe(Effect.provide(storeLayer))
      )
    )
    await releaseOffloadSlot(env, input.jobId)
    return result
  } catch (cause) {
    const result = failedResult(
      input.jobId,
      cause instanceof Error ? cause.message : "Offload workflow failed",
      cause instanceof OffloadWorkspaceError
        ? cause.reason === "hydration-failed"
          ? "hydration-failed"
          : cause.reason === "dependency-failed"
            ? "dependency-failed"
            : "runtime-failed"
        : "runtime-failed"
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* OffloadJobStore
        yield* store.finish(input.jobId, result)
      }).pipe(
        Effect.provide(storeLayer),
        Effect.catchAll(() => Effect.void)
      )
    )
    await releaseOffloadSlot(env, input.jobId)
    return result
  }
}

export class OffloadComputeWorkflow extends WorkflowEntrypoint<
  ManagedRuntimeEnv,
  OffloadWorkflowInput
> {
  override run(
    event: Readonly<WorkflowEvent<OffloadWorkflowInput>>,
    step: WorkflowStep
  ): Promise<OffloadJobResult> {
    return runOffloadWorkflow(this.env, event.payload, step)
  }
}
