import { randomUUID } from "node:crypto"
import type { EventBus } from "@earendil-works/pi-coding-agent"
import {
  SUBAGENT_FLEET_PROTOCOL_VERSION,
  type Message,
  type SubagentFleetArtifact,
  type SubagentFleetControlOutcome,
  type SubagentFleetControlRequest,
  type SubagentFleetEvent,
  type SubagentFleetNode,
  type SubagentFleetSnapshot,
  type SubagentFleetStatus,
  type SubagentFleetUsage,
  type SubagentJsonValue
} from "@jingler/core"
import { Option, Schema } from "effect"
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
  sessionRoot: Schema.optional(Schema.String),
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
  readonly emit: (event: SubagentFleetEvent) => void
  readonly trustedSessionRoots?: ReadonlyArray<string>
  readonly now?: () => number
}

export class PiSubagentLifecycleAdapter {
  readonly #events: EventBus
  readonly #parentPiSessionId: string
  readonly #parentPiSessionIds: ReadonlySet<string>
  readonly #emitExternal: (event: SubagentFleetEvent) => void
  readonly #now: () => number
  readonly #actor
  readonly #unsubscribes: Array<() => void> = []
  readonly #asyncStarts = new Map<string, typeof AsyncStarted.Type>()
  readonly #trustedSessionRoots = new Set<string>()
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
    this.#actor.stop()
  }

  snapshot(): SubagentFleetSnapshot {
    const context = this.#actor.getSnapshot().context
    return {
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      parentPiSessionId: this.#parentPiSessionId,
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

  attention(input: PiSubagentSupervisorAttentionInput): void {
    const now = this.#now()
    const context = this.#actor.getSnapshot().context
    const existing = context.nodes.find((node) =>
      node.runId === `${input.runId}:${input.childIndex}` ||
      (node.runId === input.runId && node.agent === input.agent)
    )
    const id = existing?.id ?? `${this.#parentPiSessionId}/${input.runId}/${input.childIndex}`
    this.#publish({
      _tag: "Upsert",
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      eventId: `attention:${input.requestId}`,
      occurredAt: now,
      node: {
        ...(existing ?? {
          id,
          runId: `${input.runId}:${input.childIndex}`,
          parentId: `${this.#parentPiSessionId}/${input.runId}`,
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
        id,
        status: "needs-attention",
        currentTool: "contact_supervisor",
        updatedAt: now,
        completedAt: null,
        attention: {
          requestId: input.requestId,
          reason: input.reason,
          message: input.message,
          requestedAt: now
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
        status: "running",
        currentTool: null,
        updatedAt: now,
        attention: null
      }
    })
  }

  async refresh(): Promise<SubagentFleetSnapshot> {
    const requestId = randomUUID()
    const reply = await this.#requestStatus(requestId)
    const generatedAt = this.#now()
    const activeNodes = this.#activeNodes(reply, generatedAt)
    const activeNodeIds = new Set(activeNodes.map((node) => node.id))
    const lifecycleNodes = this.#actor.getSnapshot().context.nodes.filter(
      (node) =>
        !node.id.startsWith(`${this.#parentPiSessionId}/active/`) &&
        !activeNodeIds.has(node.id)
    )
    const nodes = [...lifecycleNodes, ...activeNodes]
    this.#publish({
      _tag: "Snapshot",
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      eventId: `rpc:${requestId}`,
      occurredAt: generatedAt,
      snapshot: {
        version: SUBAGENT_FLEET_PROTOCOL_VERSION,
        parentPiSessionId: this.#parentPiSessionId,
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
    generatedAt: number
  ): ReadonlyArray<SubagentFleetNode> {
    const lifecycleNodes = this.#actor.getSnapshot().context.nodes
    return reply.data.fleet.entries.map((entry) => {
      const observed = lifecycleNodes.find(
        (node) => node.agent === entry.agent && node.startedAt === entry.startedAt
      )
      return {
        id: observed?.id ?? `${this.#parentPiSessionId}/active/${entry.key}`,
        runId: observed?.runId ?? entry.key,
        parentId: observed?.parentId ?? null,
        parentPiSessionId: this.#parentPiSessionId,
        agent: entry.agent,
        task: observed?.task ?? entry.goal ?? "Active delegated work",
        model: entry.model ?? observed?.model ?? null,
        status: "running",
        background: observed?.background ?? true,
        sessionFile: observed?.sessionFile ?? null,
        currentTool: observed?.currentTool ?? null,
        startedAt: entry.startedAt,
        updatedAt: generatedAt,
        completedAt: null,
        usage: {
          inputTokens: entry.tokens.input,
          outputTokens: entry.tokens.output,
          totalTokens: entry.tokens.total,
          costUsd: observed?.usage.costUsd ?? 0,
          durationMs: Math.max(0, generatedAt - entry.startedAt),
          toolCalls: observed?.usage.toolCalls ?? 0
        },
        artifacts: observed?.artifacts ?? [],
        attention: observed?.attention ?? null
      }
    })
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
    this.#emitExternal(event)
  }

  #belongsToParent(sessionId: string | undefined): boolean {
    return sessionId === undefined || this.#parentPiSessionIds.has(sessionId)
  }

  #onAsyncStarted(payload: unknown): void {
    const started = Option.getOrUndefined(Schema.decodeUnknownOption(AsyncStarted)(payload))
    if (!started || !this.#belongsToParent(started.sessionId)) return
    this.#asyncStarts.set(started.id, started)
    if (started.sessionRoot) this.#trustedSessionRoots.add(started.sessionRoot)
    const now = this.#now()
    this.#publish({
      _tag: "Upsert",
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      eventId: `async-start:${started.id}`,
      occurredAt: now,
      node: {
        id: `${this.#parentPiSessionId}/${started.id}`,
        runId: started.id,
        parentId: started.parentWorkflowRunId
          ? `${this.#parentPiSessionId}/${started.parentWorkflowRunId}`
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
    if (!completion || !this.#belongsToParent(completion.sessionId)) return
    const now = completion.timestamp ?? this.#now()
    const start = this.#asyncStarts.get(completion.runId)
    const rootId = `${this.#parentPiSessionId}/${completion.runId}`
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
        id: rootId,
        runId: completion.runId,
        parentId: existingRoot?.parentId ?? null,
        parentPiSessionId: this.#parentPiSessionId,
        agent: completion.agent ?? start?.agent ?? "subagent",
        task: start?.goal ?? start?.task ?? completion.summary ?? "Delegated work",
        model: null,
        status: rootStatus,
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
    this.#publish({
      _tag: "Upsert",
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      eventId: `complete:${input.completion.runId}:${index}:${input.now}`,
      occurredAt: input.now,
      node: {
        id: `${input.rootId}/${index}`,
        runId: `${input.completion.runId}:${index}`,
        parentId: input.rootId,
        parentPiSessionId: this.#parentPiSessionId,
        agent: input.child.agent ?? `step-${index + 1}`,
        task: input.child.task ?? input.start?.goal ?? input.start?.task ?? "Delegated work",
        model: input.child.model ?? null,
        status: statusFrom(input.child),
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
    if (!completion || !this.#belongsToParent(completion.sessionId)) return
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
    const id = `${this.#parentPiSessionId}/${terminal.runId}`
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
