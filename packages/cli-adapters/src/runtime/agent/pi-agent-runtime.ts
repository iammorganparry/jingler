import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import type { FileChangeSet, PiRunSpec, StreamEvent } from "@jingler/core"
import { Effect, Queue, Ref, Stream } from "effect"
import type {
  AgentRuntimeContext,
  AgentRuntimeShape
} from "./agent-runtime.js"
import { AgentRuntimeError } from "./agent-runtime.js"
import { normalizePiEvent } from "./pi-events.js"

export interface PiSessionHandle {
  readonly id: string
  readonly modelId: string
  readonly subscribe: (listener: (event: AgentSessionEvent) => void) => () => void
  readonly prompt: (text: string) => Promise<void>
  readonly steer: (text: string) => Promise<void>
  readonly interrupt: () => Promise<void>
  readonly dispose: () => void
  readonly usage: () => { readonly costUsd: number; readonly tokens: number }
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
}

const makeEventSink = (queue: Queue.Queue<StreamEvent>): EventSink => {
  let terminal = false
  let settling = false
  let emissions: Promise<void> = Promise.resolve()
  return {
    emit: (event) => {
      if (terminal) return
      const isTerminal = event._tag === "Done" || event._tag === "Failed"
      if (isTerminal) terminal = true
      emissions = emissions.then(async () => {
        await Effect.runPromise(Queue.offer(queue, event))
        if (isTerminal) await Effect.runPromise(Queue.shutdown(queue))
      })
    },
    beginSettling: () => {
      if (terminal || settling) return false
      settling = true
      return true
    }
  }
}

const reconcileWorkspace = async (
  handle: PiSessionHandle,
  sink: EventSink
): Promise<void> => {
  const changes = await handle.reconcile?.()
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
}

const subscribeToSession = (
  handle: PiSessionHandle,
  sink: EventSink
): (() => void) =>
  handle.subscribe((event) => {
    const normalized = normalizePiEvent(event)
    if (normalized) sink.emit(normalized)
    if (event.type === "agent_settled" && sink.beginSettling()) {
      reconcileWorkspace(handle, sink)
        .then(() => sink.emit({ _tag: "Done", ...handle.usage() }))
        .catch(() =>
          sink.emit({
            _tag: "Failed",
            message: "Final workspace reconciliation failed"
          })
        )
    }
  })

const startPrompt = (
  handle: PiSessionHandle,
  prompt: string,
  sink: EventSink
): void => {
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
        Effect.promise(() => reconcileWorkspace(handle, sink)).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.tap(() =>
            Effect.sync(() =>
              sink.emit({ _tag: "Failed", message: error.message })
            )
          )
        )
      )
    )
  )
}

const runSession = (
  factory: PiSessionFactory,
  sessions: Ref.Ref<Map<string, PiSessionHandle>>,
  spec: PiRunSpec,
  context: AgentRuntimeContext
): Stream.Stream<StreamEvent, AgentRuntimeError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<StreamEvent>()
      const handle = yield* factory.create(spec, context)
      yield* Ref.update(sessions, (current) =>
        new Map(current).set(handle.id, handle)
      )
      const sink = makeEventSink(queue)
      sink.emit({ _tag: "Started", sessionId: handle.id, model: handle.modelId })
      const unsubscribe = subscribeToSession(handle, sink)
      startPrompt(handle, spec.prompt, sink)
      return Stream.fromQueue(queue).pipe(
        Stream.ensuring(
          Effect.sync(() => {
            unsubscribe()
            handle.dispose()
          }).pipe(
            Effect.zipRight(
              Ref.update(sessions, (current) => {
                const next = new Map(current)
                next.delete(handle.id)
                return next
              })
            )
          )
        )
      )
    }).pipe(
      Effect.catchAll((error) =>
        Effect.succeed(
          Stream.succeed<StreamEvent>({ _tag: "Failed", message: error.message })
        )
      )
    )
  )

export const makePiAgentRuntime = (
  factory: PiSessionFactory
): Effect.Effect<AgentRuntimeShape> =>
  Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map<string, PiSessionHandle>())

    const withSession = (
      id: string,
      action: (session: PiSessionHandle) => Promise<void>
    ): Effect.Effect<void, AgentRuntimeError> =>
      Ref.get(sessions).pipe(
        Effect.flatMap((active) => {
          const session = active.get(id)
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
        })
      )

    return {
      run: (spec, context) => runSession(factory, sessions, spec, context),
      steer: (id, text) => withSession(id, (session) => session.steer(text)),
      interrupt: (id) => withSession(id, (session) => session.interrupt())
    }
  })
