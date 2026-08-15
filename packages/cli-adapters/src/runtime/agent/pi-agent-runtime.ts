import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import {
  PlanPrd,
  type FileChangeSet,
  type Message,
  type PiRunSpec,
  type StreamEvent,
  type SubagentFleetControlOutcome,
  type SubagentFleetControlRequest,
  type SubagentFleetSnapshot
} from "@jingler/core"
import { Effect, Option, Queue, Schema, Stream } from "effect"
import { createPlanToolDraftStream, type PlanToolDraftStream } from "../../plan-draft-stream.js"
import type { AgentRuntimeContext, AgentRuntimeShape } from "./agent-runtime.js"
import { AgentRuntimeError } from "./agent-runtime.js"
import { normalizePiEvent, piProviderFailure } from "./pi-events.js"

export interface PiSessionHandle {
  /** Resumable Pi session file/id persisted by Jingler. */
  readonly id: string
  /** Internal Pi session identity used by pi-subagents lifecycle events. */
  readonly parentPiSessionId: string
  readonly modelId: string
  readonly contextWindow: number | null
  readonly subscribe: (listener: (event: AgentSessionEvent) => void) => () => void
  readonly subscribeFleet: (listener: (event: StreamEvent) => void) => () => void
  readonly controlSubagent: (
    request: SubagentFleetControlRequest
  ) => Promise<SubagentFleetControlOutcome>
  readonly subagentFleetSnapshot: () => Promise<SubagentFleetSnapshot>
  readonly subagentTranscript: (runId: string) => Promise<ReadonlyArray<Message>>
  readonly prompt: (text: string) => Promise<void>
  readonly steer: (text: string) => Promise<void>
  readonly interrupt: () => Promise<void>
  readonly dispose: () => void | Promise<void>
  readonly usage: () => { readonly costUsd: number; readonly tokens: number }
  readonly observe?: (event: StreamEvent) => void
  readonly reconcile?: () => Promise<FileChangeSet | null>
}

export interface PiSessionFactory {
  readonly create: (
    spec: PiRunSpec,
    context: AgentRuntimeContext
  ) => Effect.Effect<PiSessionHandle, AgentRuntimeError>
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

const PLAN_TOOLS = new Set(["jingler_save_draft_plan", "jingler_submit_plan"])
const PlanToolArguments = Schema.Struct({ plan: PlanPrd })
const decodePlanToolArguments = Schema.decodeUnknownOption(PlanToolArguments)

const projectPlanDraft = (
  event: AgentSessionEvent,
  draft: PlanToolDraftStream
): StreamEvent | null => {
  if (event.type === "message_start" && event.message.role === "assistant") {
    return draft.clear()
  }
  if (event.type !== "message_update") return null
  const update = event.assistantMessageEvent
  if (update.type === "toolcall_delta") {
    const block = update.partial.content[update.contentIndex]
    return block?.type === "toolCall" && PLAN_TOOLS.has(block.name)
      ? draft.append(update.delta)
      : null
  }
  if (update.type !== "toolcall_end" || !PLAN_TOOLS.has(update.toolCall.name)) {
    return null
  }
  return Option.match(decodePlanToolArguments(update.toolCall.arguments), {
    onNone: () => draft.clear(),
    onSome: ({ plan }) => draft.complete(plan)
  })
}

const subscribeToSession = (
  handle: PiSessionHandle,
  sink: EventSink,
  planDraft: PlanToolDraftStream
): (() => void) => {
  const unsubscribeFleet = handle.subscribeFleet((event) => sink.emit(event))
  const unsubscribeSession = handle.subscribe((event) => {
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
    const draft = projectPlanDraft(event, planDraft)
    if (draft) sink.emit(draft)
    const normalized = normalizePiEvent(event, handle.contextWindow ?? undefined)
    if (normalized) sink.emit(normalized)
    if (event.type === "agent_settled" && sink.beginSettling()) {
      Effect.runFork(
        reconcileWorkspace(handle, sink).pipe(
          Effect.tap(() =>
            Effect.sync(() => sink.emit(sink.terminalEvent(handle.usage())))
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => sink.emit({ _tag: "Failed", message: error.message }))
          )
        )
      )
    }
  })
  return () => {
    unsubscribeFleet()
    unsubscribeSession()
  }
}

const startPrompt = (handle: PiSessionHandle, prompt: string, sink: EventSink): void => {
  Effect.runFork(
    Effect.tryPromise({
      try: () => handle.prompt(prompt),
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

interface RetainedPiSession {
  readonly handle: PiSessionHandle
  readonly sessionId: string
  readonly chatId: string
  readonly aliases: ReadonlySet<string>
  activeTurns: number
  reapTimer: ReturnType<typeof setTimeout> | null
  disposing: boolean
}

class PiSessionRegistry {
  readonly #aliases = new Map<string, RetainedPiSession>()

  constructor(
    readonly factory: PiSessionFactory,
    readonly reapIntervalMs: number
  ) {}

  acquire(
    spec: PiRunSpec,
    context: AgentRuntimeContext
  ): Effect.Effect<RetainedPiSession, AgentRuntimeError> {
    const retained = spec.piSessionId === null
      ? undefined
      : this.#aliases.get(spec.piSessionId)
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
          message: `pi session is already active: ${spec.piSessionId}`
        }))
      }
      if (retained.handle.modelId !== String(spec.modelId)) {
        return Effect.fail(new AgentRuntimeError({
          reason: "runtime",
          message: "Cannot resume a retained Pi session with a different model"
        }))
      }
      if (retained.reapTimer !== null) clearTimeout(retained.reapTimer)
      retained.reapTimer = null
      retained.activeTurns = 1
      return Effect.succeed(retained)
    }
    return this.factory.create(spec, context).pipe(
      Effect.map((handle) => {
        const aliases = new Set([handle.id, handle.parentPiSessionId])
        const record: RetainedPiSession = {
          handle,
          sessionId: spec.sessionId,
          chatId: spec.chatId,
          aliases,
          activeTurns: 1,
          reapTimer: null,
          disposing: false
        }
        for (const alias of aliases) this.#aliases.set(alias, record)
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
      for (const alias of record.aliases) {
        if (this.#aliases.get(alias) === record) this.#aliases.delete(alias)
      }
    }
  }
}

const runSession = (
  sessions: PiSessionRegistry,
  spec: PiRunSpec,
  context: AgentRuntimeContext
): Stream.Stream<StreamEvent, AgentRuntimeError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<StreamEvent>()
      const record = yield* sessions.acquire(spec, context)
      const handle = record.handle
      const sink = makeEventSink(queue, handle.observe)
      const planDraft = createPlanToolDraftStream(() => `plan-draft:${spec.runId}`)
      sink.emit({
        _tag: "Started",
        sessionId: handle.id,
        model: handle.modelId
      })
      const unsubscribe = subscribeToSession(handle, sink, planDraft)
      startPrompt(handle, spec.prompt, sink)
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
      steer: (id, text) => sessionOperation(
        sessions.lookup(id),
        id,
        (session) => session.steer(text)
      ),
      interrupt: (id) => sessionOperation(
        sessions.lookup(id),
        id,
        (session) => session.interrupt()
      ),
      controlSubagent: (sessionId, chatId, request) => sessionOperation(
        sessions.lookupOwned(sessionId, chatId, request.parentPiSessionId),
        request.parentPiSessionId,
        (session) => session.controlSubagent(request)
      ),
      subagentFleetSnapshot: (sessionId, chatId, parentPiSessionId) =>
        sessionOperation(
          sessions.lookupOwned(sessionId, chatId, parentPiSessionId),
          parentPiSessionId,
          (session) => session.subagentFleetSnapshot()
        ),
      subagentTranscript: (
        sessionId,
        chatId,
        parentPiSessionId,
        runId
      ) => sessionOperation(
        sessions.lookupOwned(sessionId, chatId, parentPiSessionId),
        parentPiSessionId,
        (session) => session.subagentTranscript(runId)
      )
    }
  })
