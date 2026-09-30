import type { ToolRegistry } from "../tools/tool-registry.js"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import type {
  SubagentDelegationRequest,
  SubagentDelegationResponse,
  SubagentDelegationUpdate
} from "pi-subagents/delegation"
import type {
  ContextBreakdown,
  FileChangeSet,
  Message,
  AgentRunSpec,
  PlannotatorReviewDecision,
  StreamEvent,
  SubagentFleetControlOutcome,
  SubagentFleetControlRequest,
  SubagentFleetSnapshot,
  SubagentModelAssignments
} from "@jingler/core"
import { Effect, Queue, Stream } from "effect"
import type { AgentRuntimeContext, AgentRuntimeShape } from "./agent-runtime.js"
import { AgentRuntimeError } from "./agent-runtime.js"
import { createPiEventNormalizer, piProviderFailure } from "./pi-events.js"
import type { PiSubagentAsyncDelegate } from "./pi-subagent-rpc.js"
import {
  retainedPiFleetHandlers,
  RetainedPiSessionRegistry
} from "./retained-pi-session-registry.js"

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
  readonly spawnSubagent?: PiSubagentAsyncDelegate
  readonly subagentAgentNames?: Readonly<Record<string, string>>
  readonly rebindNativeAsyncSubagents?: (
    spec: AgentRunSpec,
    models: SubagentModelAssignments
  ) => void
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

const runSession = (
  sessions: RetainedPiSessionRegistry,
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
    const sessions = new RetainedPiSessionRegistry(
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
      ...retainedPiFleetHandlers(sessions),
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
      )
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
