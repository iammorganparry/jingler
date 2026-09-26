import { randomUUID } from "node:crypto"
import type { EventBus } from "@earendil-works/pi-coding-agent"
import {
  SUBAGENT_FLEET_PROTOCOL_VERSION,
  subagentFleetNodeId,
  type Message,
  type SubagentFleetArtifact,
  type SubagentFleetControlOutcome,
  type SubagentFleetControlRequest,
  type SubagentFleetEvent,
  type SubagentFleetNode,
  type SubagentFleetSnapshot,
  type SubagentFleetStatus,
  type SubagentFleetUsage,
  type SubagentJsonValue,
  type SubagentSupervisorSnapshot
} from "@jingler/core"
import { Effect, Option, Schema } from "effect"
import {
  cleanAgentLabel,
  cleanTaskLabel,
  defaultPiSubagentAsyncDir,
  readDurablePiSubagentNodes
} from "./pi-subagent-durable-status.js"

// Re-exported for tests that assert the shared fleet identity cleanup.
export { cleanAgentLabel, cleanTaskLabel } from "./pi-subagent-durable-status.js"
import {
  makePiSubagentTranscriptReader,
  type PiSubagentTranscriptReaderShape
} from "./pi-subagent-transcript.js"
import {
  makeSubagentControlJournal,
  makeSubagentSupervisionService,
  type SubagentControlJournal,
  type SubagentStartRecord,
  type SubagentSupervisionServiceShape
} from "./subagent-supervision-service.js"
import type { SubagentRunTreeContext } from "./subagent-run-tree-reducer.js"

const RPC_REQUEST_EVENT = "subagents:rpc:v1:request"
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:"
const ASYNC_STARTED_EVENT = "subagent:async-started"
const ASYNC_COMPLETE_EVENT = "subagent:async-complete"
const FOREGROUND_COMPLETE_EVENT = "subagent:foreground-complete"
const PROCESS_TERMINAL_EVENT = "subagent:process-terminal"
const SUPERVISOR_ATTENTION_EVENT = "pi-intercom:detach-request"
const RPC_TIMEOUT_MS = 5_000
/**
 * How long a non-terminal workflow header may sit unknown to both the harness
 * status reply and the durable projection before the refresh sweep treats it
 * as debris from a dead run. Generous, because a live foreground workflow's
 * progress events refresh its `updatedAt` continuously.
 */
const STALE_WORKFLOW_NODE_MS = 10 * 60_000
const RPC_ERROR_PREFIX = /^[a-z_]+:\s*/u

const FleetEntry = Schema.Struct({
  key: Schema.String,
  agent: Schema.String,
  role: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  startedAt: Schema.Number,
  tokens: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    total: Schema.Number
  }),
  goal: Schema.optional(Schema.String)
})
const FleetStatusReply = Schema.Struct({
  version: Schema.Literal(1),
  requestId: Schema.String,
  method: Schema.Literal("status"),
  success: Schema.Literal(true),
  data: Schema.Struct({
    fleet: Schema.Struct({
      version: Schema.Literal(1),
      entries: Schema.Array(FleetEntry),
      totalActive: Schema.Number,
      topLevelAsyncCapacity: Schema.Struct({
        used: Schema.Number,
        limit: Schema.Number
      }),
      omitted: Schema.Number
    })
  })
})
const RpcSuccessReply = Schema.Struct({
  version: Schema.Literal(1),
  requestId: Schema.String,
  method: Schema.optional(Schema.String),
  success: Schema.Literal(true),
  data: Schema.optional(Schema.Unknown)
})
const NativeSteeringReply = Schema.Struct({
  details: Schema.Struct({
    steering: Schema.Struct({
      requestId: Schema.String,
      deliveryStatus: Schema.Literal("queued", "delivered")
    })
  })
})
const RpcErrorReply = Schema.Struct({
  version: Schema.Literal(1),
  requestId: Schema.String,
  success: Schema.Literal(false),
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String
  })
})
const AsyncStarted = Schema.Struct({
  lifecycleArtifactVersion: Schema.optional(Schema.Literal(3)),
  id: Schema.String,
  sessionId: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  agents: Schema.optional(Schema.Array(Schema.String)),
  goal: Schema.optional(Schema.String),
  task: Schema.optional(Schema.String),
  parentWorkflowRunId: Schema.optional(Schema.String)
})
const ResultUsage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  cost: Schema.Number,
  turns: Schema.Number
})
const CompletionChild = Schema.Struct({
  index: Schema.optional(Schema.Number),
  runId: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  success: Schema.optional(Schema.Boolean),
  task: Schema.optional(Schema.String),
  sessionFile: Schema.optional(Schema.String),
  sessionPath: Schema.optional(Schema.String),
  artifactPath: Schema.optional(Schema.String),
  savedOutputPath: Schema.optional(Schema.String),
  structuredOutputPath: Schema.optional(Schema.String),
  usage: Schema.optional(ResultUsage),
  model: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  stopped: Schema.optional(Schema.Boolean),
  interrupted: Schema.optional(Schema.Boolean),
  timedOut: Schema.optional(Schema.Boolean)
})
const Completion = Schema.Struct({
  id: Schema.optional(Schema.String),
  runId: Schema.String,
  sessionId: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  success: Schema.optional(Schema.Boolean),
  summary: Schema.optional(Schema.String),
  sessionFile: Schema.optional(Schema.String),
  results: Schema.optional(Schema.Array(CompletionChild)),
  timestamp: Schema.optional(Schema.Number),
  triggerTurn: Schema.optional(Schema.Boolean)
})
const ForegroundCompletion = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  sessionId: Schema.String,
  agent: Schema.String,
  success: Schema.Boolean,
  state: Schema.String,
  summary: Schema.String,
  timestamp: Schema.Number,
  taskIndex: Schema.Number,
  sessionFile: Schema.optional(Schema.String),
  stopped: Schema.optional(Schema.Boolean),
  interrupted: Schema.optional(Schema.Boolean),
  timedOut: Schema.optional(Schema.Boolean)
})
const ProcessTerminal = Schema.Struct({
  runId: Schema.String,
  state: Schema.Literal("pending", "observed", "unknown", "not-started"),
  observedAt: Schema.optional(Schema.Number)
})
const SupervisorAttentionEvent = Schema.Struct({
  requestId: Schema.String,
  runId: Schema.String,
  agent: Schema.String,
  childIndex: Schema.Number,
  reason: Schema.Literal("need_decision", "interview_request"),
  message: Schema.String,
  requestedAt: Schema.Number,
  deadlineAt: Schema.NullOr(Schema.Number)
})

const emptyUsage = (): SubagentFleetUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  durationMs: 0,
  toolCalls: 0
})

const statusFrom = (
  value: {
    readonly state?: string
    readonly success?: boolean
    readonly stopped?: boolean
    readonly interrupted?: boolean
    readonly timedOut?: boolean
    readonly error?: string
  }
): SubagentFleetStatus => {
  if (value.stopped || value.interrupted) return "stopped"
  if (value.state === "paused") return "paused"
  if (value.state === "queued" || value.state === "pending") return "queued"
  if (value.state === "running") return "running"
  if (value.success === true || value.state === "complete" || value.state === "completed") {
    return "completed"
  }
  if (value.success === false || value.error || value.timedOut || value.state === "failed" || value.state === "rejected") {
    return "failed"
  }
  return "unknown"
}

const artifactsFor = (child: typeof CompletionChild.Type): ReadonlyArray<SubagentFleetArtifact> => [
  ...(child.artifactPath
    ? [{ kind: "result" as const, path: child.artifactPath, label: "Result" }]
    : []),
  ...(child.savedOutputPath
    ? [{ kind: "output" as const, path: child.savedOutputPath, label: "Saved output" }]
    : []),
  ...(child.structuredOutputPath
    ? [{ kind: "output" as const, path: child.structuredOutputPath, label: "Structured output" }]
    : [])
]

const controlRpcFor = (
  request: SubagentFleetControlRequest,
  message: string
): { readonly method: string; readonly params: SubagentJsonValue } => {
  switch (request.action) {
    case "follow-up":
      return { method: "steer", params: { runId: request.runId, message, mode: "follow_up" } }
    case "steer":
      return { method: "steer", params: { runId: request.runId, message, mode: "steer" } }
    case "reply":
      return { method: "reply", params: { requestId: request.replyTo ?? "", message } }
    case "resume":
      return { method: "resume", params: { runId: request.runId, message } }
    default:
      return { method: request.action, params: { runId: request.runId } }
  }
}

const controlValidationError = (
  request: SubagentFleetControlRequest,
  message: string
): string | null => {
  const needsMessage = ["steer", "follow-up", "resume", "reply"].includes(request.action)
  if (needsMessage && message.length === 0) return "A non-empty message is required"
  if (request.action === "reply" && !request.replyTo) return "A supervisor request id is required"
  return null
}

const controlFailure = (error: Error): {
  readonly status: "not-found" | "invalid-state" | "rejected"
  readonly message: string
} => ({
  status: error.message.startsWith("not_found:")
    ? "not-found"
    : error.message.startsWith("invalid_state:")
      ? "invalid-state"
      : "rejected",
  message: error.message.replace(RPC_ERROR_PREFIX, "")
})

const usageFor = (
  usage: typeof ResultUsage.Type | undefined
): SubagentFleetUsage => usage
  ? {
      inputTokens: usage.input,
      outputTokens: usage.output,
      totalTokens: usage.input + usage.output,
      costUsd: usage.cost,
      durationMs: 0,
      toolCalls: 0
    }
  : emptyUsage()

export interface PiSubagentProgressInput {
  readonly runId: string
  readonly mode: string
  /**
   * The tool result ENDED and the run ended with it (not an async spawn
   * acknowledgment, whose detached run lives on). A settled foreground
   * workflow's nodes leave the dock, exactly as async completions do —
   * without this, every reviewer run left a permanently-"running" workflow
   * header, and the Fleet accumulated them for the session's whole life.
   */
  readonly settled?: boolean
  readonly children: ReadonlyArray<{
    readonly index: number
    readonly runId: string | null
    readonly agent: string
    readonly status: "pending" | "running" | "completed" | "failed" | "detached"
    readonly task: string
    readonly currentTool?: string
    readonly model?: string
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly tokens: number
    readonly toolCount: number
    readonly durationMs: number
    readonly error?: string
    readonly sessionFile: string | null
  }>
}

export interface PiSubagentSupervisorAttentionInput {
  readonly requestId: string
  readonly runId: string
  readonly childIndex: number
  readonly agent: string
  readonly reason: "need_decision" | "interview_request"
  readonly message: string
  readonly requestedAt: number
  readonly deadlineAt: number | null
}

export interface PiSubagentLifecycleAdapterOptions {
  readonly events: EventBus
  readonly parentRuntimeSessionId: string
  readonly parentPiSessionAliases?: ReadonlyArray<string>
  readonly asyncRunsDir?: string
  readonly emit: (event: SubagentFleetEvent) => void
  readonly trustedSessionRoots?: ReadonlyArray<string>
  readonly controlJournal?: SubagentControlJournal | null
  readonly now?: () => number
}

export class PiSubagentLifecycleAdapter {
  readonly #events: EventBus
  readonly #parentRuntimeSessionId: string
  readonly #parentRuntimeSessionIds: ReadonlySet<string>
  readonly #asyncRunsDir: string | undefined
  readonly #emitExternal: (event: SubagentFleetEvent) => void
  readonly #now: () => number
  readonly #supervision: SubagentSupervisionServiceShape
  readonly #transcripts: PiSubagentTranscriptReaderShape
  readonly #trustedSessionRoots: ReadonlySet<string>

  constructor(options: PiSubagentLifecycleAdapterOptions) {
    this.#events = options.events
    this.#parentRuntimeSessionId = options.parentRuntimeSessionId
    this.#parentRuntimeSessionIds = new Set([
      options.parentRuntimeSessionId,
      ...(options.parentPiSessionAliases ?? [])
    ])
    this.#asyncRunsDir = options.asyncRunsDir
    this.#emitExternal = options.emit
    this.#now = options.now ?? Date.now
    this.#trustedSessionRoots = new Set(options.trustedSessionRoots ?? [])
    this.#supervision = Effect.runSync(
      makeSubagentSupervisionService(
        options.parentRuntimeSessionId,
        this.#now,
        options.controlJournal === null
          ? undefined
          : options.controlJournal ?? makeSubagentControlJournal({
              asyncDir: options.asyncRunsDir ?? defaultPiSubagentAsyncDir(),
              parentRuntimeSessionId: options.parentRuntimeSessionId
            })
      )
    )
    this.#transcripts = Effect.runSync(makePiSubagentTranscriptReader())
  }

  start(): void {
    Effect.runSync(this.#supervision.start(() => [
      this.#events.on(ASYNC_STARTED_EVENT, (payload) => this.#onAsyncStarted(payload)),
      this.#events.on(ASYNC_COMPLETE_EVENT, (payload) => this.#onCompletion(payload, true)),
      this.#events.on(FOREGROUND_COMPLETE_EVENT, (payload) => this.#onForegroundComplete(payload)),
      this.#events.on(PROCESS_TERMINAL_EVENT, (payload) => this.#onProcessTerminal(payload)),
      this.#events.on(SUPERVISOR_ATTENTION_EVENT, (payload) =>
        this.#onSupervisorAttention(payload)
      )
    ]))
  }

  stop(): void {
    Effect.runSync(this.#supervision.stop)
    Effect.runSync(this.#transcripts.clear)
  }

  snapshot(): SubagentFleetSnapshot {
    const context = this.#state().tree
    return {
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      parentRuntimeSessionId: this.#parentRuntimeSessionId,
      registryRevision: context.registryRevision,
      generatedAt: context.generatedAt,
      totalActive: context.totalActive,
      omitted: context.omitted,
      activeCapacity: context.activeCapacity,
      nodes: context.nodes
    }
  }

  async transcript(runId: string): Promise<ReadonlyArray<Message>> {
    const node = this.#state().tree.nodes.find(
      (candidate) => candidate.runId === runId
    )
    const sessionFile = node?.sessionFile ??
      Effect.runSync(this.#supervision.transcriptFile(runId))
    if (!sessionFile) return []
    return Effect.runPromise(this.#transcripts.read({
      sessionFile,
      trustedRoots: [...this.#trustedSessionRoots]
    }))
  }

  replay(afterRevision = 0): ReadonlyArray<SubagentFleetEvent> {
    return Effect.runSync(this.#supervision.replay(afterRevision))
  }

  supervisorSnapshot(): SubagentSupervisorSnapshot {
    const snapshot = this.snapshot()
    const active = snapshot.nodes.filter((node) =>
      node.status === "queued" || node.status === "running" ||
      node.status === "paused" || node.status === "needs-attention"
    )
    return {
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      parentRuntimeSessionId: this.#parentRuntimeSessionId,
      registryRevision: snapshot.registryRevision,
      status: active.length > 0 ? "running" : "completed",
      goalRevision: 0,
      phase: null,
      siblings: active
        .filter((node) => node.nodeKind === "agent")
        .map((node) => ({
          subagentId: node.subagentId,
          agent: node.agent,
          task: node.task,
          status: node.status,
          phase: node.phase,
          outputAvailable: node.sessionFile !== null || node.artifacts.length > 0
        })),
      generatedAt: snapshot.generatedAt
    }
  }

  progress(input: PiSubagentProgressInput): void {
    const now = this.#now()
    const context = this.#state().tree
    const rootId = subagentFleetNodeId(this.#parentRuntimeSessionId, input.runId)
    // An empty-children report is an ASYNC spawn acknowledgment: the tool
    // returned `{mode, runId}` with no per-child progress because the work
    // detached into its own process. Upsert a running root so the Fleet learns
    // about the run even when the `subagent:async-started` bus event was
    // missed — the durable-status poll and completion events enrich or settle
    // it later. Never resurrect a settled root from a stale trailing report.
    if (input.children.length === 0) {
      this.#publishEmptyProgress(input, context, rootId, now)
      return
    }
    // A single/parallel/chain root is a redundant placeholder once real
    // children report — remove it. A WORKFLOW root stays: it is the container
    // its children nest under (mirroring the durable projection), rendered as
    // an unselectable group header in the Fleet tree.
    this.#publishProgressChildren(input, context, rootId, now)
  }

  #publishEmptyProgress(
    input: PiSubagentProgressInput,
    context: SubagentRunTreeContext,
    rootId: string,
    now: number
  ): void {
    const existing = context.nodes.find((node) => node.id === rootId)
      if (existing !== undefined && existing.terminal !== null) return
      // A settled run with no children reported nothing worth keeping — a
      // failed/empty foreground workflow. Clear its root instead of leaving a
      // permanently-"running" header in the dock.
      if (input.settled && existing !== undefined) {
        this.#publish({
          _tag: "Remove",
          version: SUBAGENT_FLEET_PROTOCOL_VERSION,
          eventId: `progress-settle:${input.runId}:${now}`,
          occurredAt: now,
          registryRevision: this.#nextRevision(),
          id: rootId
        })
        return
      }
      if (input.settled) return
      this.#publish({
        _tag: "Upsert",
        version: SUBAGENT_FLEET_PROTOCOL_VERSION,
        eventId: `progress-root:${input.runId}:${now}`,
        occurredAt: now,
        node: {
          ...(existing ?? {}),
          ...this.#identity(
            input.runId,
            input.runId,
            input.mode === "workflow" ? "workflow" : "agent"
          ),
          runId: input.runId,
          parentId: null,
          parentRuntimeSessionId: this.#parentRuntimeSessionId,
        ...emptyProgressIdentity(existing, input.mode),
          status: "running",
          terminal: null,
          background: true,
        ...priorProgressLocation(existing, now),
          updatedAt: now,
          completedAt: null,
          usage: existing?.usage ?? emptyUsage(),
          artifacts: existing?.artifacts ?? [],
          attention: existing?.attention ?? null
        }
      })
      return
    }

  #publishProgressChildren(
    input: PiSubagentProgressInput,
    context: SubagentRunTreeContext,
    rootId: string,
    now: number
  ) {
    if (
      input.children.length > 0 &&
      input.mode !== "workflow" &&
      context.nodes.some((node) => node.id === rootId)
    ) {
      this.#publish({
        _tag: "Remove",
        version: SUBAGENT_FLEET_PROTOCOL_VERSION,
        eventId: `progress-root:${input.runId}:${now}`,
        occurredAt: now,
        registryRevision: this.#nextRevision(),
        id: rootId
      })
    }
    const childParentId =
      input.mode === "workflow" && context.nodes.some((node) => node.id === rootId)
        ? rootId
        : null
    this.#publishAndSettleProgress(input, context, now, childParentId, rootId)
  }

  #publishProgressChild(
    input: PiSubagentProgressInput,
    child: PiSubagentProgressInput["children"][number],
    context: SubagentRunTreeContext,
    now: number,
    childParentId: string | null
  ): void {
      const subagentId = child.runId ?? `${input.runId}:step:${child.index}`
      const existing = context.nodes.find((node) => node.subagentId === subagentId)
      const status = progressChildStatus(child.status)
    this.#publish({
        _tag: "Upsert",
        version: SUBAGENT_FLEET_PROTOCOL_VERSION,
        eventId: `progress:${input.runId}:${child.index}:${now}:${child.toolCount}`,
        occurredAt: now,
        node: {
          ...(existing ?? {}),
          ...this.#identity(subagentId, input.runId),
          runId: subagentId,
          parentId: existing?.parentId ?? childParentId,
          parentRuntimeSessionId: this.#parentRuntimeSessionId,
          agent: child.agent,
          task: cleanTaskLabel(child.task),
        status,
          terminal: status === "completed" || status === "failed"
            ? {
                reason: status,
                summary: child.error ?? `Subagent child ${status}`,
                at: now,
                retryable: false
              }
            : null,
        ...progressChildLocation(child, existing, now),
          updatedAt: now,
          completedAt: status === "completed" || status === "failed" ? now : null,
          usage: progressChildUsage(child, existing),
          artifacts: existing?.artifacts ?? [],
          attention: existing?.attention ?? null
        }
      })
  }

  #removeCompletedNodes(completion: typeof Completion.Type, rootId: string, now: number): void {
    const completedIds = new Set([
      rootId,
      ...(completion.results ?? []).map((child, position) => subagentFleetNodeId(
        this.#parentRuntimeSessionId,
        child.runId ?? `${completion.runId}:step:${child.index ?? position}`
      ))
    ])
    for (const node of this.#state().tree.nodes.filter(
      (candidate) => candidate.parentId === rootId && !completedIds.has(candidate.id)
    )) {
      this.#publish({
        _tag: "Upsert",
        version: SUBAGENT_FLEET_PROTOCOL_VERSION,
        eventId: `complete-reparent:${completion.runId}:${node.subagentId}:${now}`,
        occurredAt: now,
        node: {
          ...node,
          ...this.#identity(node.subagentId, node.orchestrationRunId, node.nodeKind),
          parentId: null,
          updatedAt: now
        }
      })
    }
    for (const node of this.#state().tree.nodes.filter(
      (candidate) => completedIds.has(candidate.id)
    )) {
      this.#publish({
        _tag: "Remove",
        version: SUBAGENT_FLEET_PROTOCOL_VERSION,
        eventId: `complete-remove:${completion.runId}:${node.subagentId}:${now}`,
        occurredAt: now,
        registryRevision: this.#nextRevision(),
        id: node.id
      })
    }
    Effect.runSync(this.#supervision.removeStart(completion.runId))
  }
  #publishAndSettleProgress(
    input: PiSubagentProgressInput,
    context: SubagentRunTreeContext,
    now: number,
    childParentId: string | null,
    rootId: string
  ) {
    for (const child of input.children) {
      this.#publishProgressChild(input, child, context, now, childParentId)
    }
    // The run settled with this report: its nodes leave the dock, exactly as
    // an async completion's do. The upserts above are published FIRST so the
    // completed-nodes retention (which watches the event stream, keeping the
    // last few finished agents with a transcript) still captures each child
    // before the removal lands. Skipping this left every foreground workflow
    // in the Fleet as a permanently-"running" header for the session's life.
    if (input.settled) {
      const settledIds = new Set([
        rootId,
        ...input.children.map((child) =>
          subagentFleetNodeId(
            this.#parentRuntimeSessionId,
            child.runId ?? `${input.runId}:step:${child.index}`
          )
        )
      ])
      for (const node of this.#state().tree.nodes.filter(
        (candidate) =>
          settledIds.has(candidate.id) ||
          (candidate.parentId !== null && settledIds.has(candidate.parentId))
      )) {
        this.#publish({
          _tag: "Remove",
          version: SUBAGENT_FLEET_PROTOCOL_VERSION,
          eventId: `progress-settle:${input.runId}:${node.subagentId}:${now}`,
          occurredAt: now,
          registryRevision: this.#nextRevision(),
          id: node.id
        })
      }
    }
  }

  #onSupervisorAttention(payload: unknown): void {
    const input = Option.getOrUndefined(
      Schema.decodeUnknownOption(SupervisorAttentionEvent)(payload)
    )
    if (input) this.attention(input)
  }

  attention(input: PiSubagentSupervisorAttentionInput): void {
    const now = this.#now()
    const subagentId = `${input.runId}:step:${input.childIndex}`
    const context = this.#state().tree
    const existing = context.nodes.find((node) => node.subagentId === subagentId)
    if (existing?.attention?.requestId === input.requestId) return
    const parentId = subagentFleetNodeId(this.#parentRuntimeSessionId, input.runId)
    this.#publish({
      _tag: "Upsert",
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      eventId: `attention:${input.requestId}`,
      occurredAt: now,
      node: {
        ...(existing ?? {
          runId: subagentId,
          parentId: context.nodes.some((node) => node.id === parentId) ? parentId : null,
          parentRuntimeSessionId: this.#parentRuntimeSessionId,
          agent: input.agent,
          task: "Delegated work",
          model: null,
          background: false,
          sessionFile: null,
          startedAt: now,
          usage: emptyUsage(),
          artifacts: []
        }),
        ...this.#identity(subagentId, input.runId),
        status: "needs-attention",
        currentTool: "contact_supervisor",
        updatedAt: now,
        completedAt: null,
        attention: {
          requestId: input.requestId,
          reason: input.reason,
          message: input.message,
          requestedAt: input.requestedAt,
          deadlineAt: input.deadlineAt
        }
      }
    })
  }

  control(
    request: SubagentFleetControlRequest
  ): Promise<SubagentFleetControlOutcome> {
    return Effect.runPromise(this.#supervision.submitControl(
      request,
      (sequence) => this.#executeControl(request, sequence)
    ))
  }

  #executeControl(
    request: SubagentFleetControlRequest,
    sequence: number
  ): Effect.Effect<SubagentFleetControlOutcome> {
    if (request.parentRuntimeSessionId !== this.#parentRuntimeSessionId) {
      return Effect.succeed(this.#outcome(
        request,
        sequence,
        false,
        "not-found",
        "rejected",
        null,
        "Parent session does not match"
      ))
    }
    const message = request.message?.trim() ?? ""
    const validationError = controlValidationError(request, message)
    if (validationError) {
      return Effect.succeed(this.#outcome(
        request,
        sequence,
        false,
        "rejected",
        "rejected",
        null,
        validationError
      ))
    }
    const replyTo = request.replyTo ?? ""
    if (request.action === "reply" && !this.#attentionNode(request.runId, replyTo)) {
      return Effect.succeed(this.#outcome(
        request,
        sequence,
        false,
        "not-found",
        "rejected",
        null,
        "Supervisor request does not belong to this child run"
      ))
    }
    const rpc = controlRpcFor(request, message)
    return this.#request(rpc.method, rpc.params, request.requestId).pipe(
      Effect.map((reply) => {
        if (request.action === "reply") this.#clearAttention(request, replyTo)
        const steering = Option.getOrUndefined(
          Schema.decodeUnknownOption(NativeSteeringReply)(reply.data)
        )?.details.steering
        const deliveryStatus = steering?.deliveryStatus ?? "delivered"
        return this.#outcome(
          request,
          sequence,
          true,
          "accepted",
          deliveryStatus,
          steering?.requestId ?? reply.requestId,
          `${request.action} request ${deliveryStatus} by pi-subagents`
        )
      }),
      Effect.catchAll((error) => {
        const failure = controlFailure(error)
        return Effect.succeed(this.#outcome(
          request,
          sequence,
          false,
          failure.status,
          "rejected",
          null,
          failure.message
        ))
      })
    )
  }

  #attentionNode(runId: string, replyTo: string): SubagentFleetNode | undefined {
    return this.#state().tree.nodes.find((candidate) =>
      candidate.attention?.requestId === replyTo &&
      (candidate.runId === runId || candidate.orchestrationRunId === runId)
    )
  }

  #clearAttention(request: SubagentFleetControlRequest, replyTo: string): void {
    const node = this.#attentionNode(request.runId, replyTo)
    if (!node) return
    const now = this.#now()
    this.#publish({
      _tag: "Upsert",
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      eventId: `attention-reply:${request.requestId}`,
      occurredAt: now,
      node: {
        ...node,
        ...this.#identity(node.subagentId, node.orchestrationRunId, node.nodeKind),
        status: "running",
        currentTool: null,
        updatedAt: now,
        attention: null
      }
    })
  }

  async refresh(): Promise<SubagentFleetSnapshot> {
    const durable = await Effect.runPromise(readDurablePiSubagentNodes({
      ...(this.#asyncRunsDir ? { asyncDir: this.#asyncRunsDir } : {}),
      parentRuntimeSessionId: this.#parentRuntimeSessionId,
      parentPiSessionAliases: this.#parentRuntimeSessionIds,
      registryRevision: 0,
      now: this.#now()
    }))
    const generatedAt = this.#now()
    if (durable.nodes.length > 0) {
      const durableRevision = this.#nextRevision()
      const durableNodes = durable.nodes.map((node) => ({
        ...node,
        registryRevision: durableRevision,
        updatedAt: generatedAt
      }))
      Effect.runSync(this.#supervision.setDurableNodeIds(
        new Set(durableNodes.map(({ id }) => id))
      ))
      this.#publish({
        _tag: "Snapshot",
        version: SUBAGENT_FLEET_PROTOCOL_VERSION,
        eventId: `durable:${durableRevision}`,
        occurredAt: generatedAt,
        snapshot: {
          version: SUBAGENT_FLEET_PROTOCOL_VERSION,
          parentRuntimeSessionId: this.#parentRuntimeSessionId,
          registryRevision: durableRevision,
          generatedAt,
          totalActive: durable.totalActive,
          omitted: durable.omitted,
          activeCapacity: durable.activeCapacity,
          nodes: durableNodes
        }
      })
      return this.snapshot()
    }

    const supervision = this.#state()
    const current = supervision.tree
    const staleDurableNodes = current.nodes.filter((node) =>
      supervision.durableNodeIds.has(node.id)
    )
    if (staleDurableNodes.length > 0) {
      for (const node of staleDurableNodes) {
        this.#publish({
          _tag: "Remove",
          version: SUBAGENT_FLEET_PROTOCOL_VERSION,
          eventId: `durable-removed:${node.id}:${generatedAt}`,
          occurredAt: generatedAt,
          registryRevision: this.#nextRevision(),
          id: node.id
        })
      }
      Effect.runSync(this.#supervision.setDurableNodeIds(new Set()))
    }

    const requestId = randomUUID()
    let reply: typeof FleetStatusReply.Type
    try {
      reply = await Effect.runPromise(this.#requestStatus(requestId))
    } catch (error) {
      if (staleDurableNodes.length > 0) return this.snapshot()
      throw error
    }
    const registryRevision = this.#nextRevision()
    const activeNodes = this.#activeNodes(reply, generatedAt, registryRevision)
    const activeNodeIds = new Set(activeNodes.map((node) => node.id))
    const durableNodeIds = this.#state().durableNodeIds
    // Reload hygiene: a workflow header replayed from the journal can claim
    // "running" forever — its run died with a previous process, so no
    // completion or terminal event is ever coming for it. If neither the
    // harness's status reply nor the durable projection knows the run and it
    // has not been touched in a long while, it (and its orphaned children) is
    // debris, not work. The generous threshold keeps a LIVE foreground
    // workflow safe: its progress events refresh `updatedAt` continuously.
    const staleWorkflowIds = new Set(
      this.#state().tree.nodes.filter((node) =>
        node.nodeKind === "workflow" &&
        node.terminal === null &&
        !activeNodeIds.has(node.id) &&
        !durableNodeIds.has(node.id) &&
        generatedAt - node.updatedAt > STALE_WORKFLOW_NODE_MS
      ).map((node) => node.id)
    )
    // A finished agent has no place in the dock: completed/failed/stopped runs
    // were already captured by the completed-agents retention, and "unknown"
    // is a run whose process died without settling — nothing will ever revive
    // it. Journal replay resurrects both shapes across reloads, which is how
    // sessions accumulated rows of grey UNKNOWN workers.
    const finished = (node: SubagentFleetNode): boolean =>
      node.terminal !== null ||
      node.status === "completed" ||
      node.status === "failed" ||
      node.status === "stopped" ||
      node.status === "unknown"
    const nodes = this.#state().tree.nodes.filter(
      (node) =>
        !activeNodeIds.has(node.id) &&
        !durableNodeIds.has(node.id) &&
        !finished(node) &&
        !staleWorkflowIds.has(node.id) &&
        !(
          node.parentId !== null &&
          staleWorkflowIds.has(node.parentId) &&
          node.terminal === null
        )
    ).concat(activeNodes)
    this.#publish({
      _tag: "Snapshot",
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      eventId: `rpc:${requestId}`,
      occurredAt: generatedAt,
      snapshot: {
        version: SUBAGENT_FLEET_PROTOCOL_VERSION,
        parentRuntimeSessionId: this.#parentRuntimeSessionId,
        registryRevision,
        generatedAt,
        totalActive: reply.data.fleet.totalActive,
        omitted: reply.data.fleet.omitted,
        activeCapacity: reply.data.fleet.topLevelAsyncCapacity,
        nodes
      }
    })
    return this.snapshot()
  }

  #requestStatus(
    requestId: string
  ): Effect.Effect<typeof FleetStatusReply.Type, Error> {
    return Effect.async((resume) => {
      const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`
      const timeout = setTimeout(() => {
        unsubscribe()
        resume(Effect.fail(new Error("pi-subagents status RPC timed out")))
      }, RPC_TIMEOUT_MS)
      const unsubscribe = this.#events.on(replyEvent, (payload) => {
        clearTimeout(timeout)
        unsubscribe()
        const error = Option.getOrUndefined(Schema.decodeUnknownOption(RpcErrorReply)(payload))
        if (error) {
          resume(Effect.fail(new Error(error.error.message)))
          return
        }
        const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(FleetStatusReply)(payload))
        resume(decoded
          ? Effect.succeed(decoded)
          : Effect.fail(new Error("pi-subagents returned an invalid status RPC reply")))
      })
      this.#events.emit(RPC_REQUEST_EVENT, {
        version: 1,
        requestId,
        method: "status",
        source: { extension: "jingler" }
      })
      return Effect.sync(() => {
        clearTimeout(timeout)
        unsubscribe()
      })
    })
  }

  #activeNodes(
    reply: typeof FleetStatusReply.Type,
    generatedAt: number,
    registryRevision: number
  ): ReadonlyArray<SubagentFleetNode> {
    return reply.data.fleet.entries.map((entry) => ({
      id: subagentFleetNodeId(this.#parentRuntimeSessionId, entry.key),
      subagentId: entry.key,
      orchestrationRunId: entry.key,
      nodeKind: "agent",
      registryRevision,
      childSequence: 0,
      runId: entry.key,
      parentId: null,
      parentRuntimeSessionId: this.#parentRuntimeSessionId,
      agent: cleanAgentLabel(entry.agent),
      task: cleanTaskLabel(entry.goal),
      model: entry.model ?? null,
      status: "running",
      health: "connected",
      phase: null,
      blocking: null,
      terminal: null,
      background: true,
      sessionFile: null,
      currentTool: null,
      startedAt: entry.startedAt,
      updatedAt: generatedAt,
      completedAt: null,
      usage: {
        inputTokens: entry.tokens.input,
        outputTokens: entry.tokens.output,
        totalTokens: entry.tokens.total,
        costUsd: 0,
        durationMs: Math.max(0, generatedAt - entry.startedAt),
        toolCalls: 0
      },
      artifacts: [],
      attention: null
    }))
  }

  #request(
    method: string,
    params: SubagentJsonValue,
    requestId: string = randomUUID()
  ): Effect.Effect<typeof RpcSuccessReply.Type, Error> {
    return Effect.async((resume) => {
      const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`
      const timeout = setTimeout(() => {
        unsubscribe()
        resume(Effect.fail(new Error(`pi-subagents ${method} RPC timed out`)))
      }, RPC_TIMEOUT_MS)
      const unsubscribe = this.#events.on(replyEvent, (payload) => {
        clearTimeout(timeout)
        unsubscribe()
        const error = Option.getOrUndefined(
          Schema.decodeUnknownOption(RpcErrorReply)(payload)
        )
        if (error) {
          resume(Effect.fail(new Error(`${error.error.code}: ${error.error.message}`)))
          return
        }
        const success = Option.getOrUndefined(
          Schema.decodeUnknownOption(RpcSuccessReply)(payload)
        )
        resume(success
          ? Effect.succeed(success)
          : Effect.fail(new Error(`pi-subagents returned an invalid ${method} RPC reply`)))
      })
      this.#events.emit(RPC_REQUEST_EVENT, {
        version: 1,
        requestId,
        method,
        params,
        source: { extension: "jingler" }
      })
      return Effect.sync(() => {
        clearTimeout(timeout)
        unsubscribe()
      })
    })
  }

  #state() {
    return Effect.runSync(this.#supervision.state)
  }

  #outcome(
    request: SubagentFleetControlRequest,
    sequence: number,
    acknowledged: boolean,
    status: SubagentFleetControlOutcome["status"],
    deliveryStatus: SubagentFleetControlOutcome["deliveryStatus"],
    nativeRequestId: string | null,
    message: string
  ): SubagentFleetControlOutcome {
    return {
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      requestId: request.requestId,
      runId: request.runId,
      action: request.action,
      acknowledged,
      status,
      deliveryStatus,
      sequence,
      nativeRequestId,
      message,
      acknowledgedAt: this.#now()
    }
  }

  #publish(event: SubagentFleetEvent): void {
    Effect.runSync(this.#supervision.publish(event))
    this.#emitExternal(event)
  }

  #nextRevision(): number {
    return Effect.runSync(this.#supervision.nextRevision)
  }

  #belongsToParent(sessionId: string | undefined, runId: string): boolean {
    if (sessionId !== undefined) return this.#parentRuntimeSessionIds.has(sessionId)
    return this.#state().asyncStarts.has(runId) || this.#state().tree.nodes.some(
      (node) => node.subagentId === runId || node.orchestrationRunId === runId
    )
  }

  #identity(
    subagentId: string,
    orchestrationRunId: string,
    nodeKind: SubagentFleetNode["nodeKind"] = "agent"
  ): Pick<SubagentFleetNode,
    "id" | "subagentId" | "orchestrationRunId" | "nodeKind" |
    "registryRevision" | "childSequence" | "health" | "phase" |
    "blocking" | "terminal"
  > {
    return Effect.runSync(
      this.#supervision.identity(subagentId, orchestrationRunId, nodeKind)
    )
  }

  #onAsyncStarted(payload: unknown): void {
    const started = Option.getOrUndefined(Schema.decodeUnknownOption(AsyncStarted)(payload))
    if (!started || !this.#belongsToParent(started.sessionId, started.id)) return
    Effect.runSync(this.#supervision.putStart(started.id, {
      mode: started.mode,
      agent: started.agent,
      goal: started.goal,
      task: started.task
    }))
    const now = this.#now()
    const orchestrationRunId = started.parentWorkflowRunId ?? started.id
    this.#publish({
      _tag: "Upsert",
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      eventId: `async-start:${started.id}`,
      occurredAt: now,
      node: {
        ...this.#identity(
          started.id,
          orchestrationRunId,
          started.mode === "workflow" ? "workflow" : "agent"
        ),
        runId: started.id,
        parentId: started.parentWorkflowRunId
          ? subagentFleetNodeId(this.#parentRuntimeSessionId, started.parentWorkflowRunId)
          : null,
        parentRuntimeSessionId: this.#parentRuntimeSessionId,
        agent: started.agent ?? started.agents?.join(" + ") ?? started.mode ?? "subagent",
        task: cleanTaskLabel(started.goal ?? started.task),
        model: null,
        status: "running",
        background: true,
        sessionFile: null,
        currentTool: null,
        startedAt: now,
        updatedAt: now,
        completedAt: null,
        usage: emptyUsage(),
        artifacts: [],
        attention: null
      }
    })
  }

  #onCompletion(payload: unknown, background: boolean): void {
    const completion = Option.getOrUndefined(Schema.decodeUnknownOption(Completion)(payload))
    if (!completion || !this.#belongsToParent(completion.sessionId, completion.runId)) return
    const now = completion.timestamp ?? this.#now()
    const start = this.#state().asyncStarts.get(completion.runId)
    const rootId = subagentFleetNodeId(this.#parentRuntimeSessionId, completion.runId)
    const existingRoot = this.#state().tree.nodes.find(
      (node) => node.id === rootId
    )
    const rootStatus = statusFrom(completion)
    this.#publish({
      _tag: "Upsert",
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      eventId: `complete:${completion.runId}:${now}`,
      occurredAt: now,
      node: {
        ...this.#identity(
          completion.runId,
          completion.runId,
          start?.mode === "workflow" ? "workflow" : "agent"
        ),
        runId: completion.runId,
        parentId: existingRoot?.parentId ?? null,
        parentRuntimeSessionId: this.#parentRuntimeSessionId,
        agent: completion.agent ?? start?.agent ?? "subagent",
        task: cleanTaskLabel(start?.goal ?? start?.task ?? completion.summary),
        model: null,
        status: rootStatus,
        terminal: completedRootTerminal(rootStatus, completion, now),
        background,
        sessionFile: completion.sessionFile ?? null,
        currentTool: null,
        startedAt: existingRoot?.startedAt ?? now,
        updatedAt: now,
        completedAt: now,
        usage: emptyUsage(),
        artifacts: [],
        attention: null
      }
    })
    completion.results?.forEach((child, position) => {
      this.#publishCompletedChild({
        child,
        position,
        completion,
        rootId,
        background,
        start,
        startedAt: existingRoot?.startedAt ?? now,
        now
      })
    })
    this.#removeCompletedNodes(completion, rootId, now)
  }

  #publishCompletedChild(input: {
    readonly child: typeof CompletionChild.Type
    readonly position: number
    readonly completion: typeof Completion.Type
    readonly rootId: string
    readonly background: boolean
    readonly start: SubagentStartRecord | undefined
    readonly startedAt: number
    readonly now: number
  }): void {
    const index = input.child.index ?? input.position
    const subagentId = input.child.runId ?? `${input.completion.runId}:step:${index}`
    const existing = this.#state().tree.nodes.find(
      (node) => node.subagentId === subagentId
    )
    this.#publish({
      _tag: "Upsert",
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      eventId: `complete:${input.completion.runId}:${index}:${input.now}`,
      occurredAt: input.now,
      node: {
        ...this.#identity(subagentId, input.completion.runId),
        runId: subagentId,
        parentId: existing === undefined ? input.rootId : existing.parentId,
        parentRuntimeSessionId: this.#parentRuntimeSessionId,
        agent: input.child.agent ?? existing?.agent ?? `step-${index + 1}`,
        ...completedChildPresentation(
          input.child, existing, input.start),
        status: statusFrom(input.child),
        phase: input.child.phase ?? null,
        terminal: completedChildTerminal(input.child, input.now),
        background: input.background,
        sessionFile: input.child.sessionPath ?? input.child.sessionFile ?? existing?.sessionFile ?? null,
        currentTool: null,
        startedAt: existing?.startedAt ?? input.startedAt,
        updatedAt: input.now,
        completedAt: input.now,
        usage: usageFor(input.child.usage),
        artifacts: artifactsFor(input.child),
        attention: null
      }
    })
  }

  #onForegroundComplete(payload: unknown): void {
    const completion = Option.getOrUndefined(
      Schema.decodeUnknownOption(ForegroundCompletion)(payload)
    )
    if (!completion || !this.#belongsToParent(completion.sessionId, completion.runId)) return
    this.#onCompletion({
      runId: completion.runId,
      sessionId: completion.sessionId,
      agent: completion.agent,
      state: completion.state,
      success: completion.success,
      summary: completion.summary,
      timestamp: completion.timestamp,
      results: [{
        index: completion.taskIndex,
        runId: completion.id,
        agent: completion.agent,
        sessionFile: completion.sessionFile,
        summary: completion.summary,
        success: completion.success,
        stopped: completion.stopped,
        interrupted: completion.interrupted,
        timedOut: completion.timedOut
      }]
    }, false)
  }

  #onProcessTerminal(payload: unknown): void {
    const terminal = Option.getOrUndefined(
      Schema.decodeUnknownOption(ProcessTerminal)(payload)
    )
    if (!terminal || terminal.state === "pending") return
    const id = subagentFleetNodeId(this.#parentRuntimeSessionId, terminal.runId)
    const existing = this.#state().tree.nodes.find(
      (node) => node.id === id
    )
    if (!existing) return
    const now = terminal.observedAt ?? this.#now()
    // A workflow root is never settled by its own completion event (results
    // are keyed to child run ids), so its process ending used to decay a
    // still-"running" root to "unknown" even when every child had finished.
    // If all its registered children settled cleanly, the workflow did too.
    const settledWorkflow =
      existing.nodeKind === "workflow" &&
      (() => {
        const children = this.#state().tree.nodes.filter(
          (node) => node.parentId === existing.id
        )
        return children.length > 0 && children.every(
          (child) => child.status === "completed" || child.terminal !== null
        )
      })()
    this.#publish({
      _tag: "Upsert",
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      eventId: `terminal:${terminal.runId}:${terminal.state}:${now}`,
      occurredAt: now,
      node: {
        ...existing,
        ...this.#identity(existing.subagentId, existing.orchestrationRunId, existing.nodeKind),
        status: terminal.state === "observed" && existing.status === "running"
          ? settledWorkflow ? "completed" : "unknown"
          : existing.status,
        updatedAt: now,
        completedAt: existing.completedAt ?? now,
        currentTool: null
      }
    })
    // The process is gone — no further event will ever settle or revive this
    // run, so its nodes leave the dock now instead of lingering as UNKNOWN
    // rows forever. The settled upsert above is published FIRST so the
    // completed-agents retention (which watches the event stream) captures the
    // final state, transcripts included, before the removal lands.
    for (const node of this.#state().tree.nodes.filter(
      (candidate) => candidate.id === id || candidate.parentId === id
    )) {
      this.#publish({
        _tag: "Remove",
        version: SUBAGENT_FLEET_PROTOCOL_VERSION,
        eventId: `terminal-remove:${terminal.runId}:${node.subagentId}:${now}`,
        occurredAt: now,
        registryRevision: this.#nextRevision(),
        id: node.id
      })
    }
  }
}

const progressChildStatus = (
  status: PiSubagentProgressInput["children"][number]["status"]
): SubagentFleetStatus => {
  if (status === "pending") return "queued"
  if (status === "completed") return "completed"
  if (status === "failed") return "failed"
  return "running"
}

const progressChildUsage = (
  child: PiSubagentProgressInput["children"][number],
  existing: SubagentFleetNode | undefined
): SubagentFleetNode["usage"] => ({
  inputTokens: child.inputTokens ?? existing?.usage.inputTokens ?? 0,
  outputTokens: child.outputTokens ?? existing?.usage.outputTokens ?? 0,
  totalTokens: child.tokens,
  costUsd: existing?.usage.costUsd ?? 0,
  durationMs: child.durationMs,
  toolCalls: child.toolCount
})

const completedChildTerminal = (
  child: typeof CompletionChild.Type,
  now: number
): SubagentFleetNode["terminal"] => ({
  reason: child.timedOut
    ? "timed-out"
    : child.stopped || child.interrupted
      ? "stopped"
      : child.success === false
        ? "failed"
        : "completed",
  summary: child.output ?? child.summary ?? child.error ?? "Subagent child completed",
  at: now,
  retryable: false
})

const emptyProgressIdentity = (
  existing: SubagentFleetNode | undefined,
  mode: PiSubagentProgressInput["mode"]
) => ({
  agent: existing?.agent ?? mode,
  task: existing?.task ?? "Delegated work",
  model: existing?.model ?? null
})

const priorProgressLocation = (existing: SubagentFleetNode | undefined, now: number) => ({
  sessionFile: existing?.sessionFile ?? null,
  currentTool: existing?.currentTool ?? null,
  startedAt: existing?.startedAt ?? now
})

const progressChildLocation = (
  child: PiSubagentProgressInput["children"][number],
  existing: SubagentFleetNode | undefined,
  now: number
) => ({
  model: child.model ?? existing?.model ?? null,
  background: existing?.background ?? false,
  sessionFile: child.sessionFile ?? existing?.sessionFile ?? null,
  currentTool: child.currentTool ?? null,
  startedAt: existing?.startedAt ?? Math.max(0, now - child.durationMs)
})

const completedRootTerminal = (
  status: SubagentFleetStatus,
  completion: typeof Completion.Type,
  now: number
): SubagentFleetNode["terminal"] => ({
  reason: status === "completed" ? "completed" : status === "stopped" ? "stopped" : "failed",
  summary: completion.summary ?? "Subagent run completed",
  at: now,
  retryable: false
})

const completedChildPresentation = (
  child: typeof CompletionChild.Type,
  existing: SubagentFleetNode | undefined,
  start: SubagentStartRecord | undefined
) => ({
  task: cleanTaskLabel(child.task ?? existing?.task ?? start?.goal ?? start?.task),
  model: child.model ?? existing?.model ?? null
})
