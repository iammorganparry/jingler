import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import {
  CURRENT_RUNTIME_CONTRACTS,
  type PlanDocument,
  type PlanDocumentStatus,
  type PlanPrd,
  type ProviderConnection as ProviderConnectionType,
  type StreamEvent
} from "@jingler/core"
import { Effect, Layer, Logger, Stream } from "effect"
import type { EvalObservation, EvalTrace } from "./behavior-contract.js"
import { observeStreamEvent } from "./pi-scenario-runner.js"
import { AgentRunner } from "../../agent-runner.js"
import { BackgroundTaskStore } from "../../background-tasks.js"
import {
  BrowserControlMcpService
} from "../../browser-control-mcp-service.js"
import { ConfigService } from "../../config.js"
import { ContextManager } from "../../context-manager.js"
import { OpenConnectorService } from "../../open-connector.js"
import { PlanStore } from "../../plan-store.js"
import { InMemorySecretStoreLive } from "../../secret-store.js"
import { SessionStore } from "../../sessions.js"
import { withTempRoot, type TempRoot } from "../../test-support.js"
import { TranscriptStore } from "../../transcripts.js"
import { AgentRuntime } from "../agent/agent-runtime.js"
import { makePiAgentRuntime } from "../agent/pi-agent-runtime.js"
import { makePiSessionFactory } from "../agent/pi-session-factory.js"
import { AgentTurnDriverLive } from "../agent/agent-turn-driver-live.js"
import type { ProviderCredentialStore } from "../auth/credential-store.js"

const SESSION_ID = "eval-session"
const CHAT_ID = "eval-chat"
const SEEDED_AT = "2026-01-01T00:00:00.000Z"

/** Warnings the harness logs when it drops a plan checkpoint marker. */
const DROPPED_MARKER_PATTERN = /plan task marker names unknown/i

export interface HarnessScenarioSeedPlan {
  /** Canonical plan id the execution turn reports against. */
  readonly id: string
  readonly plan: PlanPrd
  /** "executing" makes the very next prompt a plan-execution turn. */
  readonly status: PlanDocumentStatus
}

export interface RunHarnessScenarioInput {
  readonly scenarioId: string
  readonly prompt: string
  readonly connection: ProviderConnectionType
  readonly credentials: ProviderCredentialStore
  /** Full provider-qualified model id, e.g. "jingler-fake/eval-model". */
  readonly modelId: string
  readonly seedPlan?: HarnessScenarioSeedPlan
  /** Shared process-owned Pi root — the embedded pi-subagents runtime can be prepared once per process. */
  readonly agentDir?: string
  readonly configureModelRuntime?: (runtime: ModelRuntime) => void | Promise<void>
}

const seedSessionFixture = async (
  root: string,
  workspace: string,
  input: RunHarnessScenarioInput
): Promise<void> => {
  await mkdir(workspace, { recursive: true })
  const runtime = {
    connectionId: input.connection.id,
    providerId: input.connection.providerId,
    modelId: input.modelId
  }
  await writeFile(
    join(root, "sessions.json"),
    JSON.stringify([
      {
        id: SESSION_ID,
        repo: "eval-repo",
        branch: "eval",
        title: "Harness eval",
        status: "idle",
        ...runtime,
        diff: { added: 0, removed: 0 },
        prNumber: null,
        costUsd: 0,
        tokens: 0,
        updatedAt: SEEDED_AT,
        worktreePath: workspace,
        chats: [
          {
            id: CHAT_ID,
            title: null,
            createdAt: SEEDED_AT,
            updatedAt: SEEDED_AT,
            ...runtime
          }
        ],
        activeChatId: CHAT_ID
      }
    ])
  )
}

/** Every task's PERSISTED status — the operator-visible truth this runner exists to witness. */
const planStatusObservations = (
  document: PlanDocument | null
): ReadonlyArray<EvalObservation> =>
  document === null
    ? []
    : document.plan.stages.flatMap((stage) =>
        (stage.tasks ?? []).map((task) => ({
          kind: "plan-task-status" as const,
          stageId: stage.id,
          taskId: task.id,
          status: task.status
        }))
      )

const droppedMarkerObservations = (
  warnings: ReadonlyArray<string>
): ReadonlyArray<EvalObservation> =>
  warnings
    .filter((warning) => DROPPED_MARKER_PATTERN.test(warning))
    .map((reason) => ({ kind: "plan-marker-dropped" as const, reason }))

const harnessLayers = (input: {
  readonly runner: RunHarnessScenarioInput
  readonly root: string
  readonly tempLayer: TempRoot["layer"]
  readonly warnings: Array<string>
}) => {
  const factory = makePiSessionFactory({
    agentDir:
      input.runner.agentDir ??
      process.env.PI_CODING_AGENT_DIR ??
      join(input.root, "agent"),
    sessionsDir: join(input.root, "pi-sessions"),
    credentials: input.runner.credentials,
    resolveConnection: () => Effect.succeed(input.runner.connection),
    ...(input.runner.configureModelRuntime
      ? { configureModelRuntime: input.runner.configureModelRuntime }
      : {})
  })
  // The harness's dropped-marker warnings are the only deterministic witness
  // of a rejected checkpoint; the corrective steer is forked and may settle
  // after the run.
  const warningTap = Logger.add(
    Logger.make(({ logLevel, message }) => {
      if (logLevel.label !== "WARN") return
      input.warnings.push(
        Array.isArray(message) ? message.map(String).join(" ") : String(message)
      )
    })
  )
  return Layer.mergeAll(
    AgentRunner.Default,
    OpenConnectorService.Default,
    Layer.succeed(
      BrowserControlMcpService,
      BrowserControlMcpService.of({
        acquire: () => Effect.succeed(null),
        revoke: () => Effect.void
      })
    ),
    InMemorySecretStoreLive,
    ConfigService.Default,
    SessionStore.Default,
    TranscriptStore.Default,
    BackgroundTaskStore.Default,
    PlanStore.Default,
    AgentTurnDriverLive.pipe(
      Layer.provide(Layer.effect(AgentRuntime, makePiAgentRuntime(factory)))
    ),
    ContextManager.Default,
    warningTap,
    input.tempLayer
  )
}

/**
 * Run one scenario through the FULL harness: model (real or faux) → pi runtime
 * → `AgentTurnDriverLive` → `AgentRunner.prompt` → persisted stores. This is
 * the only runner whose trace can witness `recordPlanTaskProgress` →
 * `PlanStore` — the seam where "the agent worked the plan but the panel never
 * moved" regressions live. `runPiScenario` stays the contract runner for the
 * runtime layer below `AgentRunner`; this one exists for behaviors that only
 * the harness's own fold performs (plan checkpoints, marker validation).
 *
 * Observations, beyond the shared stream fold: `plan-task-status` (persisted
 * end-state — the store is monotonic, so persistence, not prose transitions,
 * is the signal) and `plan-marker-dropped` (the harness's own warnings,
 * deterministic where the forked `[plan-sync]` steer would race settlement).
 */
export const runHarnessScenario = async (
  input: RunHarnessScenarioInput
): Promise<EvalTrace> => {
  const startedAt = performance.now()
  const temp = withTempRoot()
  const workspace = join(temp.root, "workspace")
  const warnings: Array<string> = []

  try {
    await seedSessionFixture(temp.root, workspace, input)
    const base = harnessLayers({
      runner: input,
      root: temp.root,
      tempLayer: temp.layer,
      warnings
    })
    const program = Effect.gen(function* () {
      if (input.seedPlan !== undefined) {
        yield* PlanStore.promote(
          SESSION_ID,
          workspace,
          CHAT_ID,
          input.seedPlan.plan,
          { id: input.seedPlan.id, status: input.seedPlan.status }
        )
      }
      const runner = yield* AgentRunner
      const events: Array<StreamEvent> = []
      yield* runner
        .prompt(SESSION_ID, CHAT_ID, input.prompt)
        .pipe(Stream.runForEach((event) => Effect.sync(() => events.push(event))))
      const document = yield* PlanStore.readDocument(workspace).pipe(
        Effect.orElseSucceed(() => null)
      )
      return { events, document }
    })
    const { events, document } = await Effect.runPromise(
      program.pipe(Effect.provide(base))
    )

    const observations = [
      ...events.flatMap((event) => observeStreamEvent(event, undefined)),
      ...droppedMarkerObservations(warnings),
      ...planStatusObservations(document)
    ]
    const usage = events.find((event) => event._tag === "Done")
    return {
      scenarioId: input.scenarioId,
      observations,
      durationMs: Math.max(1, Math.ceil(performance.now() - startedAt)),
      tokens: usage?._tag === "Done" ? usage.tokens : 0,
      costUsd: usage?._tag === "Done" ? usage.costUsd : 0,
      versions: CURRENT_RUNTIME_CONTRACTS
    }
  } finally {
    temp.cleanup()
  }
}
