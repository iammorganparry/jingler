import { readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  subagentFleetNodeId,
  type SubagentFleetNode
} from "@jingler/core"
import { Effect, Option, Schema } from "effect"

const DurableStep = Schema.Struct({
  agent: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  workflowKey: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literal(
    "queued", "pending", "running", "paused", "complete", "completed",
    "failed", "stopped", "rejected", "detached"
  )),
  startedAt: Schema.optional(Schema.Number),
  lastUpdate: Schema.optional(Schema.Number),
  sessionFile: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String),
  toolCount: Schema.optional(Schema.Number),
  currentTool: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  timedOut: Schema.optional(Schema.Boolean),
  stopped: Schema.optional(Schema.Boolean)
})

const DurableStatus = Schema.Struct({
  runId: Schema.String,
  sessionId: Schema.String,
  state: Schema.Literal(
    "queued", "running", "paused", "complete", "failed", "stopped", "rejected"
  ),
  mode: Schema.Literal("single", "parallel", "chain", "workflow"),
  startedAt: Schema.Number,
  lastUpdate: Schema.optional(Schema.Number),
  currentTool: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  timedOut: Schema.optional(Schema.Boolean),
  stopped: Schema.optional(Schema.Boolean),
  topLevelAsyncCapacity: Schema.optional(Schema.Struct({
    used: Schema.Number,
    limit: Schema.Number
  })),
  steps: Schema.optional(Schema.Array(DurableStep))
})

type DurableStatusValue = typeof DurableStatus.Type
type DurableStepValue = typeof DurableStep.Type

const MAX_DURABLE_NODES = 32
const DEFAULT_CAPACITY_LIMIT = 4

const activeState = (state: string | undefined): boolean =>
  state === "queued" || state === "pending" || state === "running" || state === "paused"

const nodeStatus = (
  state: string | undefined
): SubagentFleetNode["status"] => {
  switch (state) {
    case "queued":
    case "pending": return "queued"
    case "paused": return "paused"
    case "complete":
    case "completed": return "completed"
    case "failed":
    case "rejected": return "failed"
    case "stopped": return "stopped"
    default: return "running"
  }
}

const usage = (startedAt: number, updatedAt: number, toolCalls = 0) => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  durationMs: Math.max(0, updatedAt - startedAt),
  toolCalls
})

const tempScopeId = (): string =>
  typeof process.getuid === "function"
    ? `uid-${process.getuid()}`
    : `user-${process.env.USER ?? process.env.USERNAME ?? "unknown"}`

export const defaultPiSubagentAsyncDir = (): string =>
  join(tmpdir(), `pi-subagents-${tempScopeId()}`, "async-subagent-runs")

export interface DurablePiSubagentProjection {
  readonly nodes: ReadonlyArray<SubagentFleetNode>
  readonly totalActive: number
  readonly omitted: number
  readonly activeCapacity: { readonly used: number; readonly limit: number }
}

const commonNode = (input: {
  readonly parentPiSessionId: string
  readonly subagentId: string
  readonly orchestrationRunId: string
  readonly runId: string
  readonly registryRevision: number
  readonly startedAt: number
  readonly updatedAt: number
}): Pick<
  SubagentFleetNode,
  | "id" | "subagentId" | "orchestrationRunId" | "registryRevision"
  | "childSequence" | "runId" | "parentPiSessionId" | "health" | "blocking"
  | "terminal" | "startedAt" | "updatedAt" | "completedAt"
> => ({
  id: subagentFleetNodeId(input.parentPiSessionId, input.subagentId),
  subagentId: input.subagentId,
  orchestrationRunId: input.orchestrationRunId,
  registryRevision: input.registryRevision,
  childSequence: 0,
  runId: input.runId,
  parentPiSessionId: input.parentPiSessionId,
  health: "unknown",
  blocking: null,
  terminal: null,
  startedAt: input.startedAt,
  updatedAt: input.updatedAt,
  completedAt: null
})

const projectRoot = (
  status: DurableStatusValue,
  input: { parentPiSessionId: string; registryRevision: number; now: number }
): SubagentFleetNode => {
  const updatedAt = status.lastUpdate ?? input.now
  return {
    ...commonNode({
      ...input,
      subagentId: status.runId,
      orchestrationRunId: status.runId,
      runId: status.runId,
      startedAt: status.startedAt,
      updatedAt
    }),
    nodeKind: status.mode === "workflow" ? "workflow" : "agent",
    parentId: null,
    agent: status.steps?.[0]?.agent ?? status.mode,
    task: "Active delegated work",
    model: null,
    status: nodeStatus(status.state),
    phase: status.phase ?? null,
    background: true,
    sessionFile: null,
    currentTool: status.currentTool ?? null,
    usage: usage(status.startedAt, updatedAt),
    artifacts: [],
    attention: null
  }
}

const projectStep = (
  status: DurableStatusValue,
  step: DurableStepValue,
  index: number,
  input: { parentPiSessionId: string; registryRevision: number; now: number }
): SubagentFleetNode => {
  const subagentId = step.runId ?? `${status.runId}:step:${index}`
  const startedAt = step.startedAt ?? status.startedAt
  const updatedAt = step.lastUpdate ?? status.lastUpdate ?? input.now
  return {
    ...commonNode({
      ...input,
      subagentId,
      orchestrationRunId: status.runId,
      runId: subagentId,
      startedAt,
      updatedAt
    }),
    nodeKind: "agent",
    parentId: null,
    agent: step.agent ?? step.label ?? `step-${index + 1}`,
    task: step.label ?? "Delegated work",
    model: step.model ?? null,
    status: nodeStatus(step.status),
    phase: step.phase ?? null,
    background: true,
    sessionFile: step.sessionFile ?? null,
    currentTool: step.currentTool ?? null,
    usage: usage(startedAt, updatedAt, step.toolCount ?? 0),
    artifacts: [],
    attention: null
  }
}

export const readDurablePiSubagentNodes = (input: {
  readonly asyncDir?: string
  readonly parentPiSessionId: string
  readonly parentPiSessionAliases: ReadonlySet<string>
  readonly registryRevision?: number
  readonly maxNodes?: number
  readonly capacityLimit?: number
  readonly now?: number
}): Effect.Effect<DurablePiSubagentProjection, Error> => Effect.tryPromise({
  try: async () => {
  const asyncDir = input.asyncDir ?? defaultPiSubagentAsyncDir()
  let runIds: ReadonlyArray<string>
  try {
    runIds = await readdir(join(asyncDir, ".active-runs"))
  } catch {
    return {
      nodes: [],
      totalActive: 0,
      omitted: 0,
      activeCapacity: { used: 0, limit: input.capacityLimit ?? DEFAULT_CAPACITY_LIMIT }
    }
  }
  const statuses = (await Promise.all(runIds.map(async (markerRunId) => {
    try {
      const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(
        Schema.parseJson(DurableStatus)
      )(await readFile(join(asyncDir, markerRunId, "status.json"), "utf8")))
      return decoded?.runId === markerRunId ? decoded : null
    } catch {
      return null
    }
  }))).filter((status): status is DurableStatusValue =>
    status !== null &&
    activeState(status.state) &&
    input.parentPiSessionAliases.has(status.sessionId)
  ).sort((left, right) =>
    left.startedAt - right.startedAt || left.runId.localeCompare(right.runId)
  )

  const now = input.now ?? Date.now()
  const registryRevision = input.registryRevision ?? 0
  const allNodes = statuses.flatMap((status) => {
    const activeSteps = (status.steps ?? [])
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => activeState(step.status))
    if (activeSteps.length === 0) {
      return [projectRoot(status, { parentPiSessionId: input.parentPiSessionId, registryRevision, now })]
    }
    return activeSteps.map(({ step, index }) => projectStep(status, step, index, {
      parentPiSessionId: input.parentPiSessionId,
      registryRevision,
      now
    }))
  }).sort((left, right) =>
    left.startedAt - right.startedAt || left.subagentId.localeCompare(right.subagentId)
  )
  const maxNodes = Math.max(0, input.maxNodes ?? MAX_DURABLE_NODES)
  const nodes = allNodes.slice(0, maxNodes)
  const reportedLimit = statuses.find((status) => status.topLevelAsyncCapacity)?.topLevelAsyncCapacity?.limit
  return {
    nodes,
    totalActive: allNodes.length,
    omitted: Math.max(0, allNodes.length - nodes.length),
    activeCapacity: {
      used: statuses.length,
      limit: reportedLimit ?? input.capacityLimit ?? DEFAULT_CAPACITY_LIMIT
    }
  }
  },
  catch: (cause) => cause instanceof Error
    ? cause
    : new Error("Could not read durable pi-subagents state")
})
