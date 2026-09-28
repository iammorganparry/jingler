import type { ToolRegistry } from "../tools/tool-registry.js"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import type {
  SubagentDelegationRequest,
  SubagentDelegationResponse,
  SubagentDelegationUpdate
} from "pi-subagents/delegation"
import {
  type ContextBreakdown,
  type FileChangeSet,
  type Message,
  type AgentRunSpec,
  type PlannotatorReviewDecision,
  type StreamEvent,
  type SubagentFleetControlOutcome,
  type SubagentFleetControlRequest,
  type SubagentFleetSnapshot
} from "@jingler/core"
import { Effect, Queue, Stream } from "effect"
import { mcpCapabilityFingerprint } from "../tools/mcp-tools.js"
import type { AgentRuntimeContext, AgentRuntimeShape } from "./agent-runtime.js"
import { AgentRuntimeError } from "./agent-runtime.js"
import { createPiEventNormalizer, piProviderFailure } from "./pi-events.js"

export interface PiSessionHandle {
  /** Resumable Pi session file/id persisted by Jingler. */
  readonly id: string
  /** Internal Pi session identity used by pi-subagents lifecycle events. */
  readonly parentRuntimeSessionId: string
  readonly modelId: string
  readonly toolRegistry?: ToolRegistry
  readonly contextWindow: number | null
  /** Deliver the operator's verdict on a pending native plan review. */
  readonly decidePlanReview?: (decision: PlannotatorReviewDecision) => void
  readonly subscribe: (listener: (event: AgentSessionEvent) => void) => () => void
  readonly subscribeFleet: (listener: (event: StreamEvent) => void) => () => void
  readonly controlSubagent: (
    request: SubagentFleetControlRequest
  ) => Promise<SubagentFleetControlOutcome>
  readonly subagentFleetSnapshot: () => Promise<SubagentFleetSnapshot>
  readonly subagentTranscript: (runId: string) => Promise<ReadonlyArray<Message>>
  readonly delegateSubagent?: (
    request: SubagentDelegationRequest,
    signal: AbortSignal,
    onUpdate?: (update: SubagentDelegationUpdate) => void
  ) => Promise<SubagentDelegationResponse>
  readonly prompt: (text: string, images?: AgentRunSpec["images"]) => Promise<void>
  readonly steer: (text: string) => Promise<void>
  readonly interrupt: () => Promise<void>
  readonly dispose: () => void | Promise<void>
  readonly usage: () => { readonly costUsd: number; readonly tokens: number }
  readonly contextBreakdown?: (tokens: number) => ContextBreakdown
  readonly observe?: (event: StreamEvent) => void
  readonly reconcile?: () => Promise<FileChangeSet | null>
}

export interface PiSessionFactory {
  readonly create: (
    spec: AgentRunSpec,
    context: AgentRuntimeContext
  ) => Effect.Effect<PiSessionHandle, AgentRuntimeError>
  /** Secret-free identity for catalogs resolved outside the static run spec. */
  readonly lockedCapabilityFingerprint?: (
    spec: AgentRunSpec,
    context: AgentRuntimeContext
  ) => Effect.Effect<string, AgentRuntimeError>
}

interface EventSink {
  readonly emit: (event: StreamEvent) => void
  readonly beginSettling: () => boolean
  readonly noteProviderFailure: (message: string) => void
  readonly noteProviderRecovery: () => void
  readonly terminalEvent: (usage: ReturnType<PiSessionHandle["usage"]>) => StreamEvent
}

const makeEventSink = (
  queue: Queue.Queue<StreamEvent>,
  observe?: (event: StreamEvent) => void
): EventSink => {
  let terminal = false
  let settling = false
  let providerFailure: string | null = null
  let emissions: Promise<void> = Promise.resolve()
  return {
    emit: (event) => {
      if (terminal) return
      const isTerminal = event._tag === "Done" || event._tag === "Failed"
      if (isTerminal) terminal = true
      observe?.(event)
      emissions = emissions.then(async () => {
        await Effect.runPromise(Queue.offer(queue, event))
      })
    },
    beginSettling: () => {
      if (terminal || settling) return false
      settling = true
      return true
    },
    noteProviderFailure: (message) => {
      providerFailure = message
    },
    noteProviderRecovery: () => {
      providerFailure = null
    },
    terminalEvent: (usage) =>
      providerFailure === null
        ? { _tag: "Done", ...usage }
        : { _tag: "Failed", message: providerFailure }
  }
}

const reconcileWorkspace = (
  handle: PiSessionHandle,
  sink: EventSink
): Effect.Effect<void, AgentRuntimeError> =>
  Effect.tryPromise({
    try: () => handle.reconcile?.() ?? Promise.resolve(null),
    catch: (cause) =>
      new AgentRuntimeError({
        reason: "runtime",
        message: "Final workspace reconciliation failed",
        cause
      })
  }).pipe(
    Effect.tap((changes) =>
      Effect.sync(() => {
        if (!(changes && changes.changes.length > 0)) return
        const id = `reconcile:${changes.id}`
        sink.emit({ _tag: "ToolStart", id, name: "Workspace changes", target: null })
        sink.emit({
          _tag: "ToolEnd",
          id,
          status: "success",
          meta: "Final workspace reconciliation",
          diff: changes.totals,
          preview: changes.changes.find((change) => change.preview)?.preview ?? null,
          fileChanges: changes
        })
      })
    ),
    Effect.asVoid
  )

const settleSession = (
  handle: PiSessionHandle,
  sink: EventSink
): Effect.Effect<void> => {
  if (!sink.beginSettling()) return Effect.void
  return reconcileWorkspace(handle, sink).pipe(
    Effect.tap(() =>
      Effect.sync(() => sink.emit(sink.terminalEvent(handle.usage())))
    ),
    Effect.catchAll((error) =>
      Effect.sync(() => sink.emit({ _tag: "Failed", message: error.message }))
    )
  )
}

const subscribeToSession = (
  handle: PiSessionHandle,
  sink: EventSink
): (() => void) => {
  const unsubscribeFleet = handle.subscribeFleet((event) => sink.emit(event))
  const normalize = createPiEventNormalizer()
  const unsubscribeSession = handle.subscribe((event) => {
    emitVisibleAgentEvent(false, event, sink, normalize, handle)
    if (event.type !== "agent_settled") return
    Effect.runFork(settleSession(handle, sink))
  })
  return () => {
    unsubscribeFleet()
    unsubscribeSession()
  }
}

const startPrompt = (
  handle: PiSessionHandle,
  prompt: string,
  images: AgentRunSpec["images"],
  sink: EventSink
): void => {
  Effect.runFork(
    Effect.tryPromise({
      try: () => handle.prompt(prompt, images),
      catch: (cause) =>
        new AgentRuntimeError({
          reason: "provider",
          message: "pi prompt failed",
          cause
        })
    }).pipe(
      Effect.catchAll((error) =>
        reconcileWorkspace(handle, sink).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.tap(() => Effect.sync(() => sink.emit({ _tag: "Failed", message: error.message })))
        )
      )
    )
  )
}

interface ArchivedPiTranscript {
  readonly sessionId: string
  readonly chatId: string
  readonly aliases: ReadonlySet<string>
  readonly read: PiSessionHandle["subagentTranscript"]
}

const lockedCapabilityFingerprint = (
  spec: AgentRunSpec,
  context: AgentRuntimeContext,
  dynamicCatalog = ""
): string => JSON.stringify({
  role: spec.role,
  mode: spec.mode,
  ponytailMode: spec.ponytailMode,
  targetId: spec.targetCapabilities.targetId,
  toolIds: [...spec.targetCapabilities.toolIds].sort(),
  resourceIds: [...spec.targetCapabilities.resourceIds].sort(),
  mcp: mcpCapabilityFingerprint(context.mcp),
  dynamicCatalog
})

interface RetainedPiSession {
  readonly handle: PiSessionHandle
  readonly sessionId: string
  readonly chatId: string
  readonly connectionId: AgentRunSpec["connectionId"]
  readonly modelId: AgentRunSpec["modelId"]
  /** Tool and prompt capability shape locked when this PI session was built. */
  readonly capabilityFingerprint: string
  readonly aliases: ReadonlySet<string>
  /** The turn context every session-lifetime closure delegates to — see `rebindableContext`. */
  readonly contextHolder: { current: AgentRuntimeContext }
  activeTurns: number
  reapTimer: ReturnType<typeof setTimeout> | null
  disposing: boolean
}

/**
 * A session-lifetime facade over the CURRENT turn's context.
 *
 * The factory builds the pi session's custom tools, tool bridge, and subagent
 * capability broker ONCE, at create — and each of those closes over whatever
 * `AgentRuntimeContext` it was handed. But `askQuestion`/`proposePlan`/
 * `canUseTool`/`publishEvent` are PER-TURN capabilities: each closes over that
 * turn's `out` mailbox, which ends when the turn settles. Handing the factory
 * the first turn's context directly meant every retained-session turn after the
 * first ran its interactive tools against an already-ended mailbox — the
 * QuestionRequested/PlanProposed/GateRequested never reached the renderer, and
 * the run parked forever on an approval the operator could not see.
 *
 * So the factory gets this stable facade instead, and `acquire` repoints
 * `holder.current` at the incoming turn's context before every prompt. `mcp`
 * is a live getter for the same reason: the browser MCP attachment is a
 * per-run lease (fresh loopback port + bearer, revoked when the run's scope
 * closes), so a registry that snapshotted the first turn's attachment called
 * a dead endpoint on every later turn — "Could not connect to MCP server
 * jingler-browser" after the first turn, forever.
 */
const rebindableContext = (
  holder: { current: AgentRuntimeContext }
): AgentRuntimeContext => ({
  get planning() { return holder.current.planning },
  get mcp() {
    return holder.current.mcp
  },
  publishEvent: (event) => holder.current.publishEvent(event),
  registerBackgroundStop: (stop) => holder.current.registerBackgroundStop(stop),
  canUseTool: (request) => holder.current.canUseTool(request),
  askQuestion: (request) => holder.current.askQuestion(request),
  publishExplanation: (explanation) =>
    holder.current.publishExplanation?.(explanation) ?? Effect.void,
})

class PiSessionRegistry {
  readonly #aliases = new Map<string, RetainedPiSession>()
  readonly #transcriptArchives = new Map<string, ArchivedPiTranscript>()
  readonly #archiveOrder: ArchivedPiTranscript[] = []

  constructor(
    readonly factory: PiSessionFactory,
    readonly reapIntervalMs: number
  ) {}

  acquire(
    spec: AgentRunSpec,
    context: AgentRuntimeContext
  ): Effect.Effect<RetainedPiSession, AgentRuntimeError> {
    const dynamicCatalog = this.factory.lockedCapabilityFingerprint?.(spec, context) ??
      Effect.succeed("")
    return dynamicCatalog.pipe(
      Effect.flatMap((dynamic) => this.#acquire(
        spec,
        context,
        lockedCapabilityFingerprint(spec, context, dynamic)
      ))
    )
  }

  #acquire(
    spec: AgentRunSpec,
    context: AgentRuntimeContext,
    capabilityFingerprint: string
  ): Effect.Effect<RetainedPiSession, AgentRuntimeError> {
    const retained = spec.continuation === null
      ? undefined
      : this.#aliases.get(spec.continuation.id)
    if (retained) {
      if (retained.sessionId !== spec.sessionId || retained.chatId !== spec.chatId) {
        return Effect.fail(new AgentRuntimeError({
          reason: "runtime",
          message: "Retained Pi session does not belong to this chat"
        }))
      }
      if (retained.disposing || retained.activeTurns !== 0) {
        return Effect.fail(new AgentRuntimeError({
          reason: "runtime",
          message: `pi session is already active: ${spec.continuation?.id}`
        }))
      }
      // PI locks the model, credentials, tools, and prompt resources when the
      // session is created. Rebuild against the SAME session file when any of
      // those change so transcript context survives with fresh runtime state.
      if (
        retained.connectionId !== spec.connectionId ||
        retained.modelId !== spec.modelId ||
        retained.capabilityFingerprint !== capabilityFingerprint
      ) {
        return Effect.promise(() => this.#dispose(retained)).pipe(
          Effect.flatMap(() => this.#create(spec, context, capabilityFingerprint))
        )
      }
      if (retained.reapTimer !== null) clearTimeout(retained.reapTimer)
      retained.reapTimer = null
      retained.activeTurns = 1
      // The session's tools/broker delegate through this holder — repoint it at
      // THIS turn's context so interactive emits land in the live mailbox, not
      // the creating turn's ended one.
      retained.contextHolder.current = context
      if (retained.handle.toolRegistry) context.planning?.attachRegistry(retained.handle.toolRegistry)
      return Effect.succeed(retained)
    }
    return this.#create(spec, context, capabilityFingerprint)
  }

  #create(
    spec: AgentRunSpec,
    context: AgentRuntimeContext,
    capabilityFingerprint: string
  ): Effect.Effect<RetainedPiSession, AgentRuntimeError> {
    const contextHolder = { current: context }
    return this.factory.create(spec, rebindableContext(contextHolder)).pipe(
      Effect.map((handle) => {
        const aliases = new Set([handle.id, handle.parentRuntimeSessionId])
        const record: RetainedPiSession = {
          handle,
          sessionId: spec.sessionId,
          chatId: spec.chatId,
          connectionId: spec.connectionId,
          modelId: spec.modelId,
          capabilityFingerprint,
          aliases,
          contextHolder,
          activeTurns: 1,
          reapTimer: null,
          disposing: false
        }
        for (const alias of aliases) {
          this.#transcriptArchives.delete(alias)
          this.#aliases.set(alias, record)
        }
        return record
      })
    )
  }

  lookup(id: string): PiSessionHandle | undefined {
    return this.#aliases.get(id)?.handle
  }

  lookupOwned(
    sessionId: string,
    chatId: string,
    id: string
  ): PiSessionHandle | undefined {
    const record = this.#aliases.get(id)
    return record?.sessionId === sessionId && record.chatId === chatId
      ? record.handle
      : undefined
  }

  /** The chat's live session, for out-of-band operations that carry no pi id. */
  lookupByChat(sessionId: string, chatId: string): PiSessionHandle | undefined {
    for (const record of this.#aliases.values()) {
      if (record.sessionId === sessionId && record.chatId === chatId && !record.disposing) {
        return record.handle
      }
    }
    return undefined
  }

  lookupTranscriptOwned(
    sessionId: string,
    chatId: string,
    id: string
  ): PiSessionHandle["subagentTranscript"] | undefined {
    const live = this.#aliases.get(id)
    if (live?.sessionId === sessionId && live.chatId === chatId) {
      return live.handle.subagentTranscript
    }
    const archived = this.#transcriptArchives.get(id)
    return archived?.sessionId === sessionId && archived.chatId === chatId
      ? archived.read
      : undefined
  }

  async release(record: RetainedPiSession): Promise<void> {
    record.activeTurns = Math.max(0, record.activeTurns - 1)
    if (record.activeTurns > 0 || record.disposing) return
    await this.#reconcileLifetime(record)
  }

  async #reconcileLifetime(record: RetainedPiSession): Promise<void> {
    if (record.activeTurns > 0 || record.disposing) return
    try {
      const snapshot = await record.handle.subagentFleetSnapshot()
      if (snapshot.totalActive === 0) {
        await this.#dispose(record)
        return
      }
    } catch {
      // A failed status read is not evidence that detached children are gone.
    }
    if (record.reapTimer !== null) clearTimeout(record.reapTimer)
    record.reapTimer = setTimeout(() => {
      record.reapTimer = null
      void this.#reconcileLifetime(record)
    }, this.reapIntervalMs)
    record.reapTimer.unref?.()
  }

  async #dispose(record: RetainedPiSession): Promise<void> {
    if (record.disposing) return
    record.disposing = true
    if (record.reapTimer !== null) clearTimeout(record.reapTimer)
    record.reapTimer = null
    try {
      await record.handle.dispose()
    } finally {
      const archive: ArchivedPiTranscript = {
        sessionId: record.sessionId,
        chatId: record.chatId,
        aliases: record.aliases,
        read: record.handle.subagentTranscript
      }
      for (const alias of record.aliases) {
        if (this.#aliases.get(alias) === record) this.#aliases.delete(alias)
        this.#transcriptArchives.set(alias, archive)
      }
      this.#archiveOrder.push(archive)
      while (this.#archiveOrder.length > 16) {
        const expired = this.#archiveOrder.shift()
        if (!expired) break
        for (const alias of expired.aliases) {
          if (this.#transcriptArchives.get(alias) === expired) {
            this.#transcriptArchives.delete(alias)
          }
        }
      }
    }
  }
}

const runSession = (
  sessions: PiSessionRegistry,
  spec: AgentRunSpec,
  context: AgentRuntimeContext
): Stream.Stream<StreamEvent, AgentRuntimeError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<StreamEvent>()
      const record = yield* sessions.acquire(spec, context)
      const handle = record.handle
      const sink = makeEventSink(queue, handle.observe)
      sink.emit({
        _tag: "Started",
        sessionId: handle.id,
        model: handle.modelId
      })
      const unsubscribe = subscribeToSession(handle, sink)
      startPrompt(handle, spec.prompt, spec.images, sink)
      return Stream.fromQueue(queue).pipe(
        Stream.takeUntil((event) => event._tag === "Done" || event._tag === "Failed"),
        Stream.ensuring(
          Queue.shutdown(queue).pipe(
            Effect.zipRight(Effect.promise(async () => {
              unsubscribe()
              await sessions.release(record)
            }))
          )
        )
      )
    }).pipe(
      Effect.catchAll((error) =>
        Effect.succeed(
          Stream.succeed<StreamEvent>({
            _tag: "Failed",
            message: error.message
          })
        )
      )
    )
  )

export interface PiAgentRuntimeOptions {
  /** Internal deterministic-test seam; production uses conservative polling. */
  readonly retainedSessionPollMs?: number
}

export const makePiAgentRuntime = (
  factory: PiSessionFactory,
  options: PiAgentRuntimeOptions = {}
): Effect.Effect<AgentRuntimeShape> =>
  Effect.sync(() => {
    const sessions = new PiSessionRegistry(
      factory,
      options.retainedSessionPollMs ?? 1_000
    )

    const sessionOperation = <Value>(
      session: PiSessionHandle | undefined,
      id: string,
      action: (session: PiSessionHandle) => Promise<Value>
    ): Effect.Effect<Value, AgentRuntimeError> => {
      return session
        ? Effect.tryPromise({
            try: () => action(session),
            catch: (cause) =>
              new AgentRuntimeError({
                reason: "runtime",
                message: "pi session operation failed",
                cause
              })
          })
        : Effect.fail(
            new AgentRuntimeError({
              reason: "runtime",
              message: `pi session is not active: ${id}`
            })
          )
    }

    return {
      run: (spec, context) => runSession(sessions, spec, context),
      steer: (continuation, _targetId, text) => sessionOperation(
        sessions.lookup(continuation.id),
        continuation.id,
        (session) => session.steer(text)
      ),
      interrupt: (continuation, _targetId) => sessionOperation(
        sessions.lookup(continuation.id),
        continuation.id,
        (session) => session.interrupt()
      ),
      controlSubagent: (_owner, sessionId, chatId, request) => sessionOperation(
        sessions.lookupOwned(sessionId, chatId, request.parentRuntimeSessionId),
        request.parentRuntimeSessionId,
        (session) => session.controlSubagent(request)
      ),
      decidePlanReview: (_owner, sessionId, chatId, decision) => sessionOperation(
        sessions.lookupByChat(sessionId, chatId),
        `${sessionId}/${chatId}`,
        (session) => {
          if (session.decidePlanReview === undefined) {
            return Promise.reject(
              new Error("This session's runtime does not support native plan review decisions")
            )
          }
          session.decidePlanReview(decision)
          return Promise.resolve()
        }
      ),
      subagentFleetSnapshot: (_owner, sessionId, chatId, parentRuntimeSessionId) =>
        sessionOperation(
          sessions.lookupOwned(sessionId, chatId, parentRuntimeSessionId),
          parentRuntimeSessionId,
          (session) => session.subagentFleetSnapshot()
        ),
      subagentTranscript: (
        _owner,
        sessionId,
        chatId,
        parentRuntimeSessionId,
        runId
      ) => {
        const read = sessions.lookupTranscriptOwned(
          sessionId,
          chatId,
          parentRuntimeSessionId
        )
        return read
          ? Effect.tryPromise({
              try: () => read(runId),
              catch: (cause) => new AgentRuntimeError({
                reason: "runtime",
                message: "pi session operation failed",
                cause
              })
            })
          : Effect.fail(new AgentRuntimeError({
              reason: "runtime",
              message: `pi session is not active: ${parentRuntimeSessionId}`
            }))
      }
    }
  })

function emitVisibleAgentEvent(
  reflectionActive: boolean,
  event: AgentSessionEvent,
  sink: EventSink,
  normalize: (event: AgentSessionEvent, contextWindow?: number) => StreamEvent | null,
  handle: PiSessionHandle
) {
  if (!reflectionActive) {
    const providerFailure = piProviderFailure(event)
    if (providerFailure !== null) sink.noteProviderFailure(providerFailure)
    if (
      (event.type === "auto_retry_end" && event.success) ||
      (event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason !== "error")
    ) {
      sink.noteProviderRecovery()
    }
    const normalized = normalize(event, handle.contextWindow ?? undefined)
    if (normalized?._tag === "Usage" && handle.contextBreakdown !== undefined) {
      sink.emit({ ...normalized, breakdown: handle.contextBreakdown(normalized.tokens) })
    } else if (normalized) sink.emit(normalized)
  }
}
