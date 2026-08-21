import { readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  subagentFleetNodeId,
  type SubagentFleetNode
} from "@jingler/core"
import { Effect, Option, Schema } from "effect"

/**
 * Bare tokens the pi vendor surfaces as an agent name when it collapses an
 * unresolved child onto its workflow mode/key (a single-child request keys to
 * "main"; a mode leaks as "single"/"parallel"/"chain"/"workflow"). A REAL name —
 * a catalogue agent (scout, reviewer, …) or a descriptive workflow key
 * ("review-followup") — is kept as-is; only these bare tokens are relabelled.
 */
const COLLAPSE_TOKENS: ReadonlySet<string> = new Set([
  "main",
  "single",
  "parallel",
  "chain",
  "workflow",
  "subagent"
])

/** Keep a genuine agent/workflow name; relabel a bare collapse token honestly. */
export const cleanAgentLabel = (agent: string): string =>
  COLLAPSE_TOKENS.has(agent.trim().toLowerCase()) ? "Subagent" : agent

/**
 * The vendor reports a child's task as the FULL prompt it launched with —
 * `wrapForkTask` prefixes the fork preamble ("You are a delegated subagent…")
 * and callers append output/acceptance contracts — so treating that field as a
 * display label paints a whole system prompt across the fleet card and pane
 * header. The real task sits after the wrapper's `Task:` line and before the
 * first block of contract boilerplate.
 */
const WRAPPED_TASK_MARKER = /(?:^|\n)\s*Task:\s*\n?/
/** Where prompt boilerplate resumes after the task: a rule, an Output/heading block, or criteria. */
const BOILERPLATE_SEAM = /\n\s*(?:---|\*\*Output|##\s|Criteria:)/

/**
 * A label, not a document: nodes render in one-line card/header slots, and
 * anything longer than this is prompt text, not a task description.
 */
const MAX_TASK_LABEL_CHARS = 140

const TRAILING_PARTIAL_WORD = /\s+\S*$/
const ANY_WHITESPACE_RUN = /\s+/g

const capLabel = (label: string): string => {
  if (label.length <= MAX_TASK_LABEL_CHARS) return label
  const hard = label.slice(0, MAX_TASK_LABEL_CHARS)
  const atWord = hard.replace(TRAILING_PARTIAL_WORD, "")
  // A pathological single "word" longer than the whole budget keeps the hard
  // cut; otherwise break at the last word boundary.
  return `${atWord.length > 40 ? atWord : hard}…`
}

/**
 * Fold whatever the vendor called a "task" into an honest one-line label:
 * strip the "run <key>" noise (a degenerate label with no information), unwrap
 * a `wrapForkTask`-style prompt down to its actual task sentence, drop trailing
 * contract boilerplate, and bound the length. A genuinely short description
 * passes through untouched.
 */
export const cleanTaskLabel = (task: string | undefined): string => {
  const trimmed = task?.trim() ?? ""
  if (trimmed === "" || /^run\s+\S+$/i.test(trimmed)) return "Active delegated work"
  const marker = WRAPPED_TASK_MARKER.exec(trimmed)
  const body = marker ? trimmed.slice(marker.index + marker[0].length) : trimmed
  const seam = BOILERPLATE_SEAM.exec(body)
  const oneLine = (seam ? body.slice(0, seam.index) : body)
    .replace(ANY_WHITESPACE_RUN, " ")
    .trim()
  return oneLine === "" ? "Active delegated work" : capLabel(oneLine)
}

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
const DURABLE_STATUS_READ_CONCURRENCY = 16
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
    agent: cleanAgentLabel(status.steps?.[0]?.agent ?? status.mode),
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
    agent: cleanAgentLabel(step.agent ?? step.label ?? `step-${index + 1}`),
    task: cleanTaskLabel(step.label ?? "Delegated work"),
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
  const decodedStatuses: Array<DurableStatusValue | null> = []
  for (let offset = 0; offset < runIds.length; offset += DURABLE_STATUS_READ_CONCURRENCY) {
    decodedStatuses.push(...await Promise.all(
      runIds.slice(offset, offset + DURABLE_STATUS_READ_CONCURRENCY).map(async (markerRunId) => {
        try {
          const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(
            Schema.parseJson(DurableStatus)
          )(await readFile(join(asyncDir, markerRunId, "status.json"), "utf8")))
          return decoded?.runId === markerRunId ? decoded : null
        } catch {
          return null
        }
      })
    ))
  }
  const statuses = decodedStatuses.filter((status): status is DurableStatusValue =>
    status !== null &&
    activeState(status.state) &&
    input.parentPiSessionAliases.has(status.sessionId)
  ).sort((left, right) =>
    left.startedAt - right.startedAt || left.runId.localeCompare(right.runId)
  )

  const now = input.now ?? Date.now()
  const registryRevision = input.registryRevision ?? 0
  const allNodes = statuses.flatMap((status) => {
    const nodeInput = { parentPiSessionId: input.parentPiSessionId, registryRevision, now }
    // A step is worth projecting while it is active — and STAYS worth
    // projecting once it has a transcript. A workflow's only output IS its
    // steps' sessions; dropping completed steps left a lone sessionFile-less
    // root whose view said "the transcript is not available yet" forever.
    const steps = (status.steps ?? [])
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => activeState(step.status) || step.sessionFile !== undefined)
      .map(({ step, index }) => projectStep(status, step, index, nodeInput))
    if (status.mode === "workflow") {
      // The workflow root is an orchestrator with no pi session of its own.
      // Project it as the container its steps hang off — never INSTEAD of
      // them — so selecting a step (which has the transcript) always works.
      const root = projectRoot(status, nodeInput)
      return [root, ...steps.map((step) => ({ ...step, parentId: root.id }))]
    }
    return steps.length === 0 ? [projectRoot(status, nodeInput)] : steps
  }).sort((left, right) =>
    left.startedAt - right.startedAt || left.subagentId.localeCompare(right.subagentId)
  )
  const maxNodes = Math.max(0, input.maxNodes ?? MAX_DURABLE_NODES)
  const nodes = allNodes.slice(0, maxNodes)
  const reportedLimit = statuses.find((status) => status.topLevelAsyncCapacity)?.topLevelAsyncCapacity?.limit
  return {
    nodes,
    // Completed steps and workflow container roots are projected for their
    // transcripts, but they are not ACTIVE work.
    totalActive: allNodes.filter((node) =>
      node.status === "queued" || node.status === "running" ||
      node.status === "paused" || node.status === "needs-attention"
    ).length,
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
