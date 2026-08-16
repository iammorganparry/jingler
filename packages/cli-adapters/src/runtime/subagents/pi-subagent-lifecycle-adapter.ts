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
import { Option, Schema } from "effect"
import { readDurablePiSubagentNodes } from "./pi-subagent-durable-status.js"
import { readPiSubagentTranscript } from "./pi-subagent-transcript.js"
import { createSubagentRunTreeActor } from "./subagent-run-tree-machine.js"

const RPC_REQUEST_EVENT = "subagents:rpc:v1:request"
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:"
const ASYNC_STARTED_EVENT = "subagent:async-started"
const ASYNC_COMPLETE_EVENT = "subagent:async-complete"
const FOREGROUND_COMPLETE_EVENT = "subagent:foreground-complete"
const PROCESS_TERMINAL_EVENT = "subagent:process-terminal"
const RPC_TIMEOUT_MS = 5_000
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
  success: Schema.Literal(true)
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
  readonly children: ReadonlyArray<{
    readonly index: number
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
}

export interface PiSubagentLifecycleAdapterOptions {
  readonly events: EventBus
  readonly parentPiSessionId: string
  readonly parentPiSessionAliases?: ReadonlyArray<string>
  readonly asyncRunsDir?: string
  readonly emit: (event: SubagentFleetEvent) => void
  readonly trustedSessionRoots?: ReadonlyArray<string>
  readonly now?: () => number
}

export class PiSubagentLifecycleAdapter {
  readonly #events: EventBus
  readonly #parentPiSessionId: string
  readonly #parentPiSessionIds: ReadonlySet<string>
  readonly #asyncRunsDir: string | undefined
  readonly #emitExternal: (event: SubagentFleetEvent) => void
  readonly #now: () => number
  readonly #actor
  readonly #unsubscribes: Array<() => void> = []
  readonly #asyncStarts = new Map<string, typeof AsyncStarted.Type>()
  readonly #trustedSessionRoots = new Set<string>()
  readonly #childSequences = new Map<string, number>()
  readonly #durableNodeIds = new Set<string>()
  readonly #eventLog: SubagentFleetEvent[] = []
  #registryRevision = 0
  #started = false
  #refreshTimer: NodeJS.Timeout | null = null
  #refreshInFlight = false

  constructor(options: PiSubagentLifecycleAdapterOptions) {
    this.#events = options.events
    this.#parentPiSessionId = options.parentPiSessionId
    this.#parentPiSessionIds = new Set([
      options.parentPiSessionId,
      ...(options.parentPiSessionAliases ?? [])
    ])
    this.#asyncRunsDir = options.asyncRunsDir
    this.#emitExternal = options.emit
    this.#now = options.now ?? Date.now
    for (const root of options.trustedSessionRoots ?? []) this.#trustedSessionRoots.add(root)
    this.#actor = createSubagentRunTreeActor(options.parentPiSessionId)
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    this.#actor.start()
    this.#subscribe(ASYNC_STARTED_EVENT, (payload) => this.#onAsyncStarted(payload))
    this.#subscribe(ASYNC_COMPLETE_EVENT, (payload) => this.#onCompletion(payload, true))
    this.#subscribe(FOREGROUND_COMPLETE_EVENT, (payload) => this.#onForegroundComplete(payload))
    this.#subscribe(PROCESS_TERMINAL_EVENT, (payload) => this.#onProcessTerminal(payload))
  }

  beginPolling(intervalMs = 1_000): void {
    if (!this.#started || this.#refreshTimer) return
    const poll = (): void => {
      if (this.#refreshInFlight) return
      this.#refreshInFlight = true
      this.refresh()
        .catch(() => undefined)
        .finally(() => {
          this.#refreshInFlight = false
        })
    }
    this.#refreshTimer = setInterval(poll, intervalMs)
    this.#refreshTimer.unref?.()
    poll()
  }

  stop(): void {
    if (!this.#started) return
    this.#started = false
    if (this.#refreshTimer) clearInterval(this.#refreshTimer)
    this.#refreshTimer = null
    for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe()
    this.#asyncStarts.clear()
    this.#childSequences.clear()
    this.#durableNodeIds.clear()
    this.#eventLog.splice(0)
    this.#actor.stop()
  }

  snapshot(): SubagentFleetSnapshot {
    const context = this.#actor.getSnapshot().context
    return {
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      parentPiSessionId: this.#parentPiSessionId,
      registryRevision: context.registryRevision,
      generatedAt: context.generatedAt,
      totalActive: context.totalActive,
      omitted: context.omitted,
      activeCapacity: context.activeCapacity,
      nodes: context.nodes
    }
  }

  async transcript(runId: string): Promise<ReadonlyArray<Message>> {
    const node = this.#actor.getSnapshot().context.nodes.find(
      (candidate) => candidate.runId === runId
    )
    if (!node?.sessionFile) return []
    return readPiSubagentTranscript({
      sessionFile: node.sessionFile,
      trustedRoots: [...this.#trustedSessionRoots]
    })
  }

  replay(afterRevision = 0): ReadonlyArray<SubagentFleetEvent> {
    return [...new Map(
      this.#eventLog
        .filter((event) => this.#eventRevision(event) > afterRevision)
        .map((event) => [event.eventId, event] as const)
    ).values()]
  }

  supervisorSnapshot(): SubagentSupervisorSnapshot {
    const snapshot = this.snapshot()
    const active = snapshot.nodes.filter((node) =>
      node.status === "queued" || node.status === "running" ||
      node.status === "paused" || node.status === "needs-attention"
    )
    return {
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      parentPiSessionId: this.#parentPiSessionId,
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
    const context = this.#actor.getSnapshot().context
    const rootId = subagentFleetNodeId(this.#parentPiSessionId, input.runId)
    if (input.children.length > 0 && context.nodes.some((node) => node.id === rootId)) {
      this.#publish({
        _tag: "Remove",
        version: SUBAGENT_FLEET_PROTOCOL_VERSION,
        eventId: `progress-root:${input.runId}:${now}`,
        occurredAt: now,
        registryRevision: ++this.#registryRevision,
        id: rootId
      })
    }
    for (const child of input.children) {
      const subagentId = `${input.runId}:step:${child.index}`
      const existing = context.nodes.find((node) => node.subagentId === subagentId)
      const status: SubagentFleetStatus = child.status === "pending"
        ? "queued"
        : child.status === "completed"
          ? "completed"
          : child.status === "failed"
            ? "failed"
            : "running"
      this.#publish({
        _tag: "Upsert",
        version: SUBAGENT_FLEET_PROTOCOL_VERSION,
        eventId: `progress:${input.runId}:${child.index}:${now}:${child.toolCount}`,
        occurredAt: now,
        node: {
          ...(existing ?? {}),
          ...this.#identity(subagentId, input.runId),
          runId: subagentId,
          parentId: null,
          parentPiSessionId: this.#parentPiSessionId,
          agent: child.agent,
          task: child.task,
          model: child.model ?? existing?.model ?? null,
          status,
          terminal: status === "completed" || status === "failed"
            ? {
                reason: status,
                summary: child.error ?? `Subagent child ${status}`,
                at: now,
                retryable: false
              }
            : null,
          background: existing?.background ?? false,
          sessionFile: child.sessionFile ?? existing?.sessionFile ?? null,
          currentTool: child.currentTool ?? null,
          startedAt: existing?.startedAt ?? Math.max(0, now - child.durationMs),
          updatedAt: now,
          completedAt: status === "completed" || status === "failed" ? now : null,
          usage: {
            inputTokens: child.inputTokens ?? existing?.usage.inputTokens ?? 0,
            outputTokens: child.outputTokens ?? existing?.usage.outputTokens ?? 0,
            totalTokens: child.tokens,
            costUsd: existing?.usage.costUsd ?? 0,
            durationMs: child.durationMs,
            toolCalls: child.toolCount
          },
          artifacts: existing?.artifacts ?? [],
          attention: existing?.attention ?? null
        }
      })
    }
  }

  attention(input: PiSubagentSupervisorAttentionInput): void {
    const now = this.#now()
    const subagentId = `${input.runId}:step:${input.childIndex}`
    const context = this.#actor.getSnapshot().context
    const existing = context.nodes.find((node) => node.subagentId === subagentId)
    const parentId = subagentFleetNodeId(this.#parentPiSessionId, input.runId)
    this.#publish({
      _tag: "Upsert",
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      eventId: `attention:${input.requestId}`,
      occurredAt: now,
      node: {
        ...(existing ?? {
          runId: subagentId,
          parentId: context.nodes.some((node) => node.id === parentId) ? parentId : null,
          parentPiSessionId: this.#parentPiSessionId,
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
          requestedAt: now,
          deadlineAt: null
        }
      }
    })
  }

  async control(
    request: SubagentFleetControlRequest
  ): Promise<SubagentFleetControlOutcome> {
    if (request.parentPiSessionId !== this.#parentPiSessionId) {
      return this.#outcome(request, false, "not-found", "Parent session does not match")
    }
    const message = request.message?.trim() ?? ""
    const validationError = controlValidationError(request, message)
    if (validationError) return this.#outcome(request, false, "rejected", validationError)
    const replyTo = request.replyTo ?? ""
    const rpc = controlRpcFor(request, message)
    try {
      await this.#request(rpc.method, rpc.params)
      if (request.action === "reply") this.#clearAttention(request, replyTo)
      return this.#outcome(
        request,
        true,
        "accepted",
        `${request.action} request acknowledged by pi-subagents`
      )
    } catch (error) {
      const failure = controlFailure(
        error instanceof Error ? error : new Error("Control request failed")
      )
      return this.#outcome(request, false, failure.status, failure.message)
    }
  }

  #clearAttention(request: SubagentFleetControlRequest, replyTo: string): void {
    const node = this.#actor.getSnapshot().context.nodes.find(
      (candidate) => candidate.attention?.requestId === replyTo
    )
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
    const generatedAt = this.#now()
    const durableRevision = ++this.#registryRevision
    const durable = await readDurablePiSubagentNodes({
      ...(this.#asyncRunsDir ? { asyncDir: this.#asyncRunsDir } : {}),
      parentPiSessionId: this.#parentPiSessionId,
      parentPiSessionAliases: this.#parentPiSessionIds,
      registryRevision: durableRevision,
      now: generatedAt
    })
    if (durable.nodes.length > 0) {
      this.#durableNodeIds.clear()
      for (const node of durable.nodes) this.#durableNodeIds.add(node.id)
      this.#publish({
        _tag: "Snapshot",
        version: SUBAGENT_FLEET_PROTOCOL_VERSION,
        eventId: `durable:${durableRevision}`,
        occurredAt: generatedAt,
        snapshot: {
          version: SUBAGENT_FLEET_PROTOCOL_VERSION,
          parentPiSessionId: this.#parentPiSessionId,
          registryRevision: durableRevision,
          generatedAt,
          totalActive: durable.totalActive,
          omitted: durable.omitted,
          activeCapacity: durable.activeCapacity,
          nodes: durable.nodes
        }
      })
      return this.snapshot()
    }

    const current = this.#actor.getSnapshot().context
    const staleDurableNodes = current.nodes.filter((node) => this.#durableNodeIds.has(node.id))
    if (staleDurableNodes.length > 0) {
      for (const node of staleDurableNodes) {
        this.#publish({
          _tag: "Remove",
          version: SUBAGENT_FLEET_PROTOCOL_VERSION,
          eventId: `durable-removed:${node.id}:${generatedAt}`,
          occurredAt: generatedAt,
          registryRevision: ++this.#registryRevision,
          id: node.id
        })
      }
      this.#durableNodeIds.clear()
    }

    const requestId = randomUUID()
    let reply: typeof FleetStatusReply.Type
    try {
      reply = await this.#requestStatus(requestId)
    } catch (error) {
      if (staleDurableNodes.length > 0) return this.snapshot()
      throw error
    }
    const registryRevision = ++this.#registryRevision
    const activeNodes = this.#activeNodes(reply, generatedAt, registryRevision)
    const activeNodeIds = new Set(activeNodes.map((node) => node.id))
    const nodes = this.#actor.getSnapshot().context.nodes.filter(
      (node) => !activeNodeIds.has(node.id) && !this.#durableNodeIds.has(node.id)
    ).concat(activeNodes)
    this.#publish({
      _tag: "Snapshot",
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      eventId: `rpc:${requestId}`,
      occurredAt: generatedAt,
      snapshot: {
        version: SUBAGENT_FLEET_PROTOCOL_VERSION,
        parentPiSessionId: this.#parentPiSessionId,
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

  #requestStatus(requestId: string): Promise<typeof FleetStatusReply.Type> {
    return new Promise((resolve, reject) => {
      const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`
      const timeout = setTimeout(() => {
        unsubscribe()
        reject(new Error("pi-subagents status RPC timed out"))
      }, RPC_TIMEOUT_MS)
      const unsubscribe = this.#events.on(replyEvent, (payload) => {
        clearTimeout(timeout)
        unsubscribe()
        const error = Option.getOrUndefined(Schema.decodeUnknownOption(RpcErrorReply)(payload))
        if (error) return reject(new Error(error.error.message))
        const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(FleetStatusReply)(payload))
        return decoded
          ? resolve(decoded)
          : reject(new Error("pi-subagents returned an invalid status RPC reply"))
      })
      this.#events.emit(RPC_REQUEST_EVENT, {
        version: 1,
        requestId,
        method: "status",
        source: { extension: "jingler" }
      })
    })
  }

  #activeNodes(
    reply: typeof FleetStatusReply.Type,
    generatedAt: number,
    registryRevision: number
  ): ReadonlyArray<SubagentFleetNode> {
    return reply.data.fleet.entries.map((entry) => ({
      id: subagentFleetNodeId(this.#parentPiSessionId, entry.key),
      subagentId: entry.key,
      orchestrationRunId: entry.key,
      nodeKind: "agent",
      registryRevision,
      childSequence: 0,
      runId: entry.key,
      parentId: null,
      parentPiSessionId: this.#parentPiSessionId,
      agent: entry.agent,
      task: entry.goal ?? "Active delegated work",
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

  #request(method: string, params: SubagentJsonValue): Promise<void> {
    const requestId = randomUUID()
    return new Promise<void>((resolve, reject) => {
      const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`
      const timeout = setTimeout(() => {
        unsubscribe()
        reject(new Error(`pi-subagents ${method} RPC timed out`))
      }, RPC_TIMEOUT_MS)
      const unsubscribe = this.#events.on(replyEvent, (payload) => {
        clearTimeout(timeout)
        unsubscribe()
        const error = Option.getOrUndefined(
          Schema.decodeUnknownOption(RpcErrorReply)(payload)
        )
        if (error) {
          reject(new Error(`${error.error.code}: ${error.error.message}`))
          return
        }
        const success = Option.getOrUndefined(
          Schema.decodeUnknownOption(RpcSuccessReply)(payload)
        )
        if (!success) {
          reject(new Error(`pi-subagents returned an invalid ${method} RPC reply`))
          return
        }
        resolve()
      })
      this.#events.emit(RPC_REQUEST_EVENT, {
        version: 1,
        requestId,
        method,
        params,
        source: { extension: "jingler" }
      })
    })
  }

  #outcome(
    request: SubagentFleetControlRequest,
    acknowledged: boolean,
    status: SubagentFleetControlOutcome["status"],
    message: string
  ): SubagentFleetControlOutcome {
    return {
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      requestId: request.requestId,
      runId: request.runId,
      action: request.action,
      acknowledged,
      status,
      message,
      acknowledgedAt: this.#now()
    }
  }

  #subscribe(channel: string, handler: (payload: unknown) => void): void {
    this.#unsubscribes.push(this.#events.on(channel, handler))
  }

  #publish(event: SubagentFleetEvent): void {
    this.#actor.send({ type: "INGEST", event })
    this.#eventLog.push(event)
    if (this.#eventLog.length > 256) this.#eventLog.splice(0, this.#eventLog.length - 256)
    this.#emitExternal(event)
  }

  #eventRevision(event: SubagentFleetEvent): number {
    if (event._tag === "Snapshot") return event.snapshot.registryRevision
    if (event._tag === "Upsert") return event.node.registryRevision
    return event.registryRevision
  }

  #belongsToParent(sessionId: string | undefined, runId: string): boolean {
    if (sessionId !== undefined) return this.#parentPiSessionIds.has(sessionId)
    return this.#asyncStarts.has(runId) || this.#actor.getSnapshot().context.nodes.some(
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
    const childSequence = (this.#childSequences.get(subagentId) ?? 0) + 1
    this.#childSequences.set(subagentId, childSequence)
    return {
      id: subagentFleetNodeId(this.#parentPiSessionId, subagentId),
      subagentId,
      orchestrationRunId,
      nodeKind,
      registryRevision: ++this.#registryRevision,
      childSequence,
      health: "connected",
      phase: null,
      blocking: null,
      terminal: null
    }
  }

  #onAsyncStarted(payload: unknown): void {
    const started = Option.getOrUndefined(Schema.decodeUnknownOption(AsyncStarted)(payload))
    if (!started || !this.#belongsToParent(started.sessionId, started.id)) return
    this.#asyncStarts.set(started.id, started)
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
          ? subagentFleetNodeId(this.#parentPiSessionId, started.parentWorkflowRunId)
          : null,
        parentPiSessionId: this.#parentPiSessionId,
        agent: started.agent ?? started.agents?.join(" + ") ?? started.mode ?? "subagent",
        task: started.goal ?? started.task ?? "Delegated work",
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
    const start = this.#asyncStarts.get(completion.runId)
    const rootId = subagentFleetNodeId(this.#parentPiSessionId, completion.runId)
    const existingRoot = this.#actor.getSnapshot().context.nodes.find(
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
        parentPiSessionId: this.#parentPiSessionId,
        agent: completion.agent ?? start?.agent ?? "subagent",
        task: start?.goal ?? start?.task ?? completion.summary ?? "Delegated work",
        model: null,
        status: rootStatus,
        terminal: {
          reason: rootStatus === "completed"
            ? "completed"
            : rootStatus === "stopped" ? "stopped" : "failed",
          summary: completion.summary ?? "Subagent run completed",
          at: now,
          retryable: false
        },
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
    const completedIds = new Set([
      rootId,
      ...(completion.results ?? []).map((child, position) => subagentFleetNodeId(
        this.#parentPiSessionId,
        child.runId ?? `${completion.runId}:step:${child.index ?? position}`
      ))
    ])
    for (const node of this.#actor.getSnapshot().context.nodes.filter(
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
    for (const node of this.#actor.getSnapshot().context.nodes.filter(
      (candidate) => completedIds.has(candidate.id)
    )) {
      this.#publish({
        _tag: "Remove",
        version: SUBAGENT_FLEET_PROTOCOL_VERSION,
        eventId: `complete-remove:${completion.runId}:${node.subagentId}:${now}`,
        occurredAt: now,
        registryRevision: ++this.#registryRevision,
        id: node.id
      })
    }
    this.#asyncStarts.delete(completion.runId)
  }

  #publishCompletedChild(input: {
    readonly child: typeof CompletionChild.Type
    readonly position: number
    readonly completion: typeof Completion.Type
    readonly rootId: string
    readonly background: boolean
    readonly start: typeof AsyncStarted.Type | undefined
    readonly startedAt: number
    readonly now: number
  }): void {
    const index = input.child.index ?? input.position
    const subagentId = input.child.runId ?? `${input.completion.runId}:step:${index}`
    this.#publish({
      _tag: "Upsert",
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      eventId: `complete:${input.completion.runId}:${index}:${input.now}`,
      occurredAt: input.now,
      node: {
        ...this.#identity(subagentId, input.completion.runId),
        runId: subagentId,
        parentId: input.rootId,
        parentPiSessionId: this.#parentPiSessionId,
        agent: input.child.agent ?? `step-${index + 1}`,
        task: input.child.task ?? input.start?.goal ?? input.start?.task ?? "Delegated work",
        model: input.child.model ?? null,
        status: statusFrom(input.child),
        phase: input.child.phase ?? null,
        terminal: {
          reason: input.child.timedOut
            ? "timed-out"
            : input.child.stopped || input.child.interrupted
              ? "stopped"
              : input.child.success === false ? "failed" : "completed",
          summary: input.child.error ?? "Subagent child completed",
          at: input.now,
          retryable: false
        },
        background: input.background,
        sessionFile: input.child.sessionPath ?? input.child.sessionFile ?? null,
        currentTool: null,
        startedAt: input.startedAt,
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
    const id = subagentFleetNodeId(this.#parentPiSessionId, terminal.runId)
    const existing = this.#actor.getSnapshot().context.nodes.find(
      (node) => node.id === id
    )
    if (!existing) return
    const now = terminal.observedAt ?? this.#now()
    this.#publish({
      _tag: "Upsert",
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      eventId: `terminal:${terminal.runId}:${terminal.state}:${now}`,
      occurredAt: now,
      node: {
        ...existing,
        ...this.#identity(existing.subagentId, existing.orchestrationRunId, existing.nodeKind),
        status: terminal.state === "observed" && existing.status === "running"
          ? "unknown"
          : existing.status,
        updatedAt: now,
        completedAt: existing.completedAt ?? now,
        currentTool: null
      }
    })
  }
}
