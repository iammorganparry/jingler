import type {
  AgentRuntimeContext,
  PiAgentRuntimeLiveOptions,
  ToolRegistry
} from "@jingler/cli-adapters"
import type { PiRunSpec, StreamEvent } from "@jingler/core"
import { Effect, Schema } from "effect"

export const E2E_BACKGROUND_TOOL = "jingler_e2e_background"
export const E2E_HELD_SUBAGENTS_TOOL = "jingler_e2e_held_subagents"
export const E2E_HOLD_TOOL = "jingler_e2e_hold"
export const E2E_REVIEW_PAUSE_TOOL = "jingler_e2e_review_pause"

export const E2eBackgroundKind = Schema.Literal("watch", "agent", "complete")
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
      Effect.sleep("2 seconds").pipe(
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

const executeBackgroundFixture = (
  context: AgentRuntimeContext,
  spec: PiRunSpec,
  kind: E2eBackgroundKind
): Effect.Effect<{ readonly started: E2eBackgroundKind }> => {
  const taskId = `e2e-background-${spec.runId}`
  const toolUseId = `e2e-subagent-${spec.runId}`
  return (
    kind === "agent"
      ? startAgent(context, taskId, toolUseId)
      : startWatcher(context, taskId, kind === "complete")
  ).pipe(Effect.as({ started: kind }))
}

const registerBackgroundFixtureTool = (
  registry: ToolRegistry,
  spec: PiRunSpec,
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
    input: Schema.Struct({}),
    risk: "read",
    roles: ["review"],
    modes: ["read-only"],
    timeoutMs: 5_000,
    outputBudget: 1_000,
    cancellable: false,
    idempotency: "safe",
    execute: () =>
      Effect.runPromise(Effect.sleep("3 seconds").pipe(Effect.as({ inspected: true })))
  })
}

const heldSubagentIds = (runId: string) => ({
  first: `e2e-subagent-a-${runId}`,
  second: `e2e-subagent-b-${runId}`
})

const heldSubagentEvents = (
  runId: string,
  phase: "start" | "settle"
): ReadonlyArray<StreamEvent> => {
  const { first, second } = heldSubagentIds(runId)
  return phase === "start"
    ? [
        {
          _tag: "SubagentStarted",
          id: first,
          name: "Explore",
          description: "Survey the tab bar",
          parentId: null
        },
        {
          _tag: "SubagentStarted",
          id: second,
          name: "Explore",
          description: "Audit the theme tokens",
          parentId: null
        }
      ]
    : [
        { _tag: "SubagentEnded", id: first, status: "done" },
        { _tag: "SubagentEnded", id: second, status: "done" }
      ]
}

const registerHeldSubagentsTool = (
  registry: ToolRegistry,
  spec: PiRunSpec,
  context: AgentRuntimeContext
): void => {
  registry.register({
    id: E2E_HELD_SUBAGENTS_TOOL,
    version: "1",
    description: "Drive deterministic foreground sub-agent lifecycle events in Electron e2e.",
    input: Schema.Struct({
      phase: Schema.Literal("start", "wait", "settle")
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
            yield* publishAll(context, heldSubagentEvents(spec.runId, phase))
          }
          yield* Effect.sleep("400 millis")
          return { phase }
        }),
        { signal: toolContext.signal }
      )
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
    registerHoldTool(registry)
    registerReviewPauseTool(registry)
  })
