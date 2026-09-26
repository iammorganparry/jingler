import type {
  AgentRuntimeContext,
  PiAgentRuntimeLiveOptions,
  ToolRegistry
} from "@jingler/cli-adapters"
import type { AgentRunSpec, StreamEvent } from "@jingler/core"
import { Effect, Schema } from "effect"

export const E2E_BACKGROUND_TOOL = "jingler_e2e_background"
export const E2E_HELD_SUBAGENTS_TOOL = "jingler_e2e_held_subagents"
export const E2E_HOLD_TOOL = "jingler_e2e_hold"
export const E2E_REVIEW_PAUSE_TOOL = "jingler_e2e_review_pause"
export const E2E_PLAN_PROGRESS_TOOL = "jingler_e2e_plan_progress"

export const E2eBackgroundKind = Schema.Literal(
  "watch",
  "agent",
  "complete",
  "legacy-agent"
)
export type E2eBackgroundKind = Schema.Schema.Type<typeof E2eBackgroundKind>

const publishAll = (
  context: AgentRuntimeContext,
  events: ReadonlyArray<StreamEvent>
): Effect.Effect<void> =>
  Effect.forEach(events, context.publishEvent, {
    concurrency: 1,
    discard: true
  })

const watcherEvents = (id: string): ReadonlyArray<StreamEvent> => [
  {
    _tag: "BackgroundTaskStarted",
    id,
    description: "Watching the test suite",
    taskType: "bash",
    subagentType: null,
    toolUseId: null
  },
  { _tag: "BackgroundTasksChanged", ids: [id] },
  {
    _tag: "BackgroundTaskProgress",
    id,
    description: "Watching the test suite",
    tokens: 1_200,
    toolUses: 3,
    durationMs: 12_000,
    lastTool: "Bash"
  }
]

const registerWatcherStop = (context: AgentRuntimeContext, taskId: string): Effect.Effect<void> =>
  context.registerBackgroundStop(async (id) => {
    if (id !== taskId) return
    await Effect.runPromise(
      publishAll(context, [
        {
          _tag: "BackgroundTaskSettled",
          id: taskId,
          status: "stopped",
          summary: "Stopped by the operator.",
          outputFile: null
        },
        { _tag: "BackgroundTasksChanged", ids: [] }
      ])
    )
  })

const startWatcher = (
  context: AgentRuntimeContext,
  taskId: string,
  completes: boolean
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* registerWatcherStop(context, taskId)
    yield* publishAll(context, watcherEvents(taskId))
    if (!completes) return
    Effect.runFork(
      Effect.sleep("15 seconds").pipe(
        Effect.zipRight(
          publishAll(context, [
            {
              _tag: "BackgroundTaskSettled",
              id: taskId,
              status: "completed",
              summary: "42 tests passed.",
              outputFile: null
            },
            { _tag: "BackgroundTasksChanged", ids: [] }
          ])
        )
      )
    )
  })

const startAgent = (
  context: AgentRuntimeContext,
  taskId: string,
  toolUseId: string
): Effect.Effect<void> =>
  publishAll(context, [
    {
      _tag: "SubagentStarted",
      id: toolUseId,
      name: "Explore",
      description: "Survey the codebase",
      parentId: null
    },
    {
      _tag: "BackgroundTaskStarted",
      id: taskId,
      description: "Surveying the codebase",
      taskType: "subagent",
      subagentType: "Explore",
      toolUseId
    },
    { _tag: "BackgroundTasksChanged", ids: [taskId] }
  ])

const startLegacyAgent = (
  context: AgentRuntimeContext,
  toolUseId: string
): Effect.Effect<void> =>
  publishAll(context, [
    {
      _tag: "SubagentStarted",
      id: toolUseId,
      name: "Legacy Scout",
      description: "Inspect the compatibility path",
      parentId: null
    },
    {
      _tag: "Assistant",
      text: "Legacy transcript remains visible in Fleet.",
      agentId: toolUseId
    }
  ]).pipe(
    Effect.tap(() => Effect.sync(() => {
      Effect.runFork(
        Effect.sleep("2 seconds").pipe(
          Effect.zipRight(publishAll(context, [{
            _tag: "SubagentEnded",
            id: toolUseId,
            status: "done"
          }]))
        )
      )
    }))
  )

const executeBackgroundFixture = (
  context: AgentRuntimeContext,
  spec: AgentRunSpec,
  kind: E2eBackgroundKind
): Effect.Effect<{ readonly started: E2eBackgroundKind }> => {
  const taskId = `e2e-background-${spec.runId}`
  const toolUseId = `e2e-subagent-${spec.runId}`
  return (
    kind === "agent"
      ? startAgent(context, taskId, toolUseId)
      : kind === "legacy-agent"
        ? startLegacyAgent(context, toolUseId)
        : startWatcher(context, taskId, kind === "complete")
  ).pipe(Effect.as({ started: kind }))
}

const registerBackgroundFixtureTool = (
  registry: ToolRegistry,
  spec: AgentRunSpec,
  context: AgentRuntimeContext
): void => {
  registry.register({
    id: E2E_BACKGROUND_TOOL,
    version: "1",
    description: "Drive deterministic background lifecycle events in Electron e2e.",
    input: Schema.Struct({ kind: E2eBackgroundKind }),
    risk: "read",
    roles: ["conversation"],
    modes: ["ask", "accept-edits", "auto"],
    timeoutMs: 5_000,
    outputBudget: 1_000,
    cancellable: true,
    idempotency: "safe",
    execute: ({ kind }) => Effect.runPromise(executeBackgroundFixture(context, spec, kind))
  })
}

const registerReviewPauseTool = (registry: ToolRegistry): void => {
  registry.register({
    id: E2E_REVIEW_PAUSE_TOOL,
    version: "1",
    description: "Keep the deterministic reviewer observable while it inspects code.",
    input: Schema.Struct({ hold: Schema.optional(Schema.Boolean) }),
    risk: "read",
    roles: ["review"],
    modes: ["read-only"],
    timeoutMs: 120_000,
    outputBudget: 1_000,
    cancellable: true,
    idempotency: "safe",
    execute: ({ hold }, context) =>
      Effect.runPromise(Effect.sleep(hold ? "90 seconds" : "3 seconds").pipe(Effect.as({ inspected: true })), { signal: context.signal })
  })
}

const heldSubagentIds = (runId: string) => ({
  first: `e2e-subagent-a-${runId}`,
  second: `e2e-subagent-b-${runId}`
})

const heldSubagentEvents = (
  runId: string,
  phase: "start" | "settle",
  direct: boolean
): ReadonlyArray<StreamEvent> => {
  const { first, second } = heldSubagentIds(runId)
  const parentRuntimeSessionId = `e2e-parent-${runId}`
  const at = phase === "start" ? 10 : 20
  const fleetNode = (id: string, agent: string, task: string) =>
    heldFleetNode(id, agent, task, phase, runId, parentRuntimeSessionId, at)

  return direct
    ? [fleetNode(first, "Worker", "Inspect direct delegation")]
    : [
        fleetNode(first, "Explore", "Survey the tab bar"),
        fleetNode(second, "Explore", "Audit the theme tokens")
      ]
}

const registerHeldSubagentsTool = (
  registry: ToolRegistry,
  spec: AgentRunSpec,
  context: AgentRuntimeContext
): void => {
  registry.register({
    id: E2E_HELD_SUBAGENTS_TOOL,
    version: "1",
    description: "Drive deterministic foreground sub-agent lifecycle events in Electron e2e.",
    input: Schema.Struct({
      phase: Schema.Literal("start", "wait", "settle", "direct-start", "direct-settle")
    }),
    risk: "read",
    roles: ["conversation"],
    modes: ["ask", "accept-edits", "auto"],
    timeoutMs: 5_000,
    outputBudget: 1_000,
    cancellable: true,
    idempotency: "safe",
    execute: ({ phase }, toolContext) =>
      Effect.runPromise(
        Effect.gen(function* () {
          if (phase !== "wait") {
            const direct = phase.startsWith("direct-")
            yield* publishAll(
              context,
              heldSubagentEvents(spec.runId, phase.endsWith("start") ? "start" : "settle", direct)
            )
          }
          yield* Effect.sleep("400 millis")
          return { phase }
        }),
        { signal: toolContext.signal }
      )
  })
}

const registerPlanProgressTool = (registry: ToolRegistry): void => {
  registry.register({
    id: E2E_PLAN_PROGRESS_TOOL,
    version: "1",
    description: "Pause between deterministic plan progress markers.",
    input: Schema.Struct({}),
    risk: "read",
    roles: ["conversation", "plan", "plan-execution"],
    modes: ["auto", "plan"],
    timeoutMs: 8_000,
    outputBudget: 1_000,
    cancellable: false,
    idempotency: "safe",
    execute: () => Effect.runPromise(Effect.sleep("5 seconds").pipe(Effect.as({ advanced: true })))
  })
}

const registerHoldTool = (registry: ToolRegistry): void => {
  registry.register({
    id: E2E_HOLD_TOOL,
    version: "1",
    description: "Keep a deterministic Electron conversation turn active.",
    input: Schema.Struct({}),
    risk: "read",
    roles: ["conversation"],
    modes: ["ask", "accept-edits", "auto"],
    timeoutMs: 2 * 60 * 1_000,
    outputBudget: 1_000,
    cancellable: true,
    idempotency: "safe",
    execute: (_input, context) =>
      Effect.runPromise(
        Effect.sleep("2 minutes").pipe(Effect.as({ holding: true })),
        { signal: context.signal }
      )
  })
}

export const configureE2ePiTools: NonNullable<
  PiAgentRuntimeLiveOptions["configureToolRegistry"]
> = ({ registry, spec, context }) =>
  Effect.sync(() => {
    registerBackgroundFixtureTool(registry, spec, context)
    registerHeldSubagentsTool(registry, spec, context)
    registerPlanProgressTool(registry)
    registerHoldTool(registry)
    registerReviewPauseTool(registry)
  })

const heldFleetNode = (
  id: string,
  agent: string,
  task: string,
  phase: "start" | "settle",
  runId: string,
  parentRuntimeSessionId: string,
  at: number
): Extract<StreamEvent, { readonly _tag: "SubagentFleetChanged" }> => ({
  _tag: "SubagentFleetChanged",
  event: {
    _tag: "Upsert",
    version: 2,
    eventId: `${phase}:${id}`,
    occurredAt: at,
    node: {
      id: `${parentRuntimeSessionId}/${id}`,
      subagentId: id,
      orchestrationRunId: runId,
      nodeKind: "agent",
      registryRevision: at,
      childSequence: phase === "start" ? 1 : 2,
      runId: id,
      parentId: null,
      parentRuntimeSessionId,
      agent,
      task,
      model: "e2e/pi-fixture:high",
      status: phase === "start" ? "running" : "completed",
      health: phase === "start" ? "connected" : "disconnected",
      phase: null,
      blocking: null,
      terminal: phase === "start" ? null : {
        reason: "completed",
        summary: "Fixture child completed",
        at,
        retryable: false
      },
      background: false,
      sessionFile: null,
      currentTool: phase === "start" ? "workspace_read_file" : null,
      startedAt: 10,
      updatedAt: at,
      completedAt: phase === "start" ? null : at,
      usage: {
        inputTokens: phase === "start" ? 0 : 120,
        outputTokens: phase === "start" ? 0 : 40,
        totalTokens: phase === "start" ? 0 : 160,
        costUsd: 0,
        durationMs: phase === "start" ? 0 : 10,
        toolCalls: phase === "start" ? 0 : 1
      },
      artifacts: phase === "start"
        ? []
        : [{ kind: "report", path: `reports/${id}.md`, label: "Report" }],
      attention: null
    }
  }
})
