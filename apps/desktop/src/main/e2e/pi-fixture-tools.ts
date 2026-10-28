import {
  agentWakes,
  type AgentRuntimeContext,
  type PiAgentRuntimeLiveOptions,
  type ToolRegistry
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
  "legacy-agent",
  "wake"
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
    },
    // The child edits a file so Follow in the subagent view has something to open.
    { _tag: "ToolStart", id: `${toolUseId}-edit`, name: "Write", target: "src/delegated.ts", agentId: toolUseId },
    {
      _tag: "ToolEnd",
      id: `${toolUseId}-edit`,
      status: "success",
      meta: null,
      diff: null,
      preview: null,
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
  if (kind === "wake") {
    // Stands in for a sub-agent result reaching the idle parent after its turn ended.
    Effect.runFork(Effect.sleep("3 seconds").pipe(Effect.zipRight(Effect.sync(() =>
      agentWakes.publish({ sessionId: spec.sessionId, chatId: spec.chatId })
    ))))
    return Effect.succeed({ started: kind })
  }
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

const E2E_FLEET_EPOCH = 4_102_444_800_000

const heldSubagentIds = (runId: string) => ({
  first: `e2e-subagent-a-${runId}`,
  second: `e2e-subagent-b-${runId}`
})

const heldSubagentEvents = (
  runId: string,
  phase: "start" | "settle" | "ask",
  direct: boolean
): ReadonlyArray<StreamEvent> => {
  const { first, second } = heldSubagentIds(runId)
  const parentRuntimeSessionId = `e2e-parent-${runId}`
  // Later than any real fleet snapshot, so the fixture's parent id stays the latest one
  // (parentRuntimeSessionIdFromFleetEvents picks by occurredAt) and its nodes aren't filtered out.
  const at = E2E_FLEET_EPOCH + (phase === "start" ? 10 : phase === "ask" ? 15 : 20)
  const fleetNode = (id: string, agent: string, task: string) =>
    heldFleetNode(id, agent, task, phase, runId, parentRuntimeSessionId, at)

  // [[held-subagent-asks]]: only the first child asks — mirrors a real subagent sending a
  // SubagentAttentionRequest (contact_supervisor/interview_request) while its sibling runs on.
  if (phase === "ask") return [fleetNode(first, "Explore", "Survey the tab bar")]

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
      phase: Schema.Literal("start", "wait", "settle", "direct-start", "direct-settle", "ask")
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
          if (phase === "ask") {
            yield* publishAll(context, heldSubagentEvents(spec.runId, "ask", false))
          } else if (phase !== "wait") {
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

/** Fields of a fixture fleet node that vary only by lifecycle phase. */
const heldFleetNodePhaseFields = (phase: "start" | "settle" | "ask", at: number) => ({
  status: phase === "ask" ? "needs-attention" as const : phase === "start" ? "running" as const : "completed" as const,
  health: phase === "settle" ? "disconnected" as const : "connected" as const,
  terminal: phase === "start" || phase === "ask" ? null : {
    reason: "completed" as const,
    summary: "Fixture child completed",
    at,
    retryable: false
  },
  currentTool: phase === "settle" ? null : "workspace_read_file",
  completedAt: phase === "settle" ? at : null,
  usage: {
    inputTokens: phase === "settle" ? 120 : 0,
    outputTokens: phase === "settle" ? 40 : 0,
    totalTokens: phase === "settle" ? 160 : 0,
    costUsd: 0,
    durationMs: phase === "settle" ? 10 : 0,
    toolCalls: phase === "settle" ? 1 : 0
  },
  isSettled: phase === "settle"
})

const heldFleetNode = (
  id: string,
  agent: string,
  task: string,
  phase: "start" | "settle" | "ask",
  runId: string,
  parentRuntimeSessionId: string,
  at: number
): Extract<StreamEvent, { readonly _tag: "SubagentFleetChanged" }> => {
  const phaseFields = heldFleetNodePhaseFields(phase, at)
  return {
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
      childSequence: phase === "settle" ? 2 : 1,
      runId: id,
      parentId: null,
      parentRuntimeSessionId,
      agent,
      task,
      model: "e2e/pi-fixture:high",
      status: phaseFields.status,
      health: phaseFields.health,
      phase: null,
      blocking: null,
      terminal: phaseFields.terminal,
      background: false,
      sessionFile: null,
      currentTool: phaseFields.currentTool,
      startedAt: E2E_FLEET_EPOCH + 10,
      updatedAt: at,
      completedAt: phaseFields.completedAt,
      usage: phaseFields.usage,
      artifacts: phaseFields.isSettled
        ? [{ kind: "report" as const, path: `reports/${id}.md`, label: "Report" }]
        : [],
      // [[held-subagent-asks]]: the real path is the child sending a SubagentAttentionRequest
      // (contact_supervisor need_decision/interview_request) that lands here via the fleet protocol.
      attention: phase === "ask"
        ? {
            requestId: `attention-${id}`,
            reason: "need_decision",
            message: "Should I include the archived tabs in the tab bar survey?",
            requestedAt: at,
            deadlineAt: null
          }
        : null,
      // JINGLER_E2E_SUBAGENT_WORKSPACE gives the first child its own worktree (#560).
      workspace: id.startsWith("e2e-subagent-a") && process.env.JINGLER_E2E_SUBAGENT_WORKSPACE
        ? { path: process.env.JINGLER_E2E_SUBAGENT_WORKSPACE, branch: "child/a", baseRef: null }
        : null,
      // A settled child has opened a PR (#561 header PRs chip); running children have none yet.
      prNumber: phase === "settle" ? 491 : null
    }
  }
  }
}
