import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { PlanPrd, type FileChangeSet, type PiRunSpec, type StreamEvent } from "@jingler/core"
import { Effect, Option, Queue, Ref, Schema, Stream } from "effect"
import { createPlanToolDraftStream, type PlanToolDraftStream } from "../../plan-draft-stream.js"
import type { AgentRuntimeContext, AgentRuntimeShape } from "./agent-runtime.js"
import { AgentRuntimeError } from "./agent-runtime.js"
import { normalizePiEvent, piProviderFailure } from "./pi-events.js"

export const MEMORY_REFLECTION_TIMEOUT_MS = 15_000

export interface PiSessionHandle {
  readonly id: string
  readonly modelId: string
  readonly contextWindow: number | null
  readonly subscribe: (listener: (event: AgentSessionEvent) => void) => () => void
  readonly prompt: (text: string) => Promise<void>
  readonly steer: (text: string) => Promise<void>
  readonly interrupt: () => Promise<void>
  readonly dispose: () => void | Promise<void>
  readonly usage: () => { readonly costUsd: number; readonly tokens: number }
  readonly observe?: (event: StreamEvent) => void
  readonly reconcile?: () => Promise<FileChangeSet | null>
  /** One hidden post-turn reflection prompt, or null when the run does not qualify. */
  readonly memoryReflectionPrompt?: () => string | null
  /** Structurally restrict tools while the hidden reflection phase is active. */
  readonly setMemoryReflectionActive?: (active: boolean) => void
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
  sink: EventSink,
  planDraft: PlanToolDraftStream
): (() => void) => {
  let reflectionStarted = false
  let reflectionActive = false
  let reflectionTimeout: ReturnType<typeof setTimeout> | null = null
  const finishReflection = () => {
    const wasActive = reflectionActive
    reflectionActive = false
    if (wasActive) handle.setMemoryReflectionActive?.(false)
    if (reflectionTimeout !== null) clearTimeout(reflectionTimeout)
    reflectionTimeout = null
  }
  const unsubscribe = handle.subscribe((event) => {
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
      const draft = projectPlanDraft(event, planDraft)
      if (draft) sink.emit(draft)
      const normalized = normalizePiEvent(event, handle.contextWindow ?? undefined)
      if (normalized) sink.emit(normalized)
    }
    if (event.type !== "agent_settled") return

    if (!reflectionStarted) {
      const prompt = handle.memoryReflectionPrompt?.() ?? null
      if (prompt !== null) {
        reflectionStarted = true
        reflectionActive = true
        handle.setMemoryReflectionActive?.(true)
        reflectionTimeout = setTimeout(() => {
          reflectionTimeout = null
          Effect.runFork(
            Effect.tryPromise({
              try: () => handle.interrupt(),
              catch: () => null
            }).pipe(Effect.catchAll(() => Effect.void))
          )
          Effect.runFork(settleSession(handle, sink))
        }, MEMORY_REFLECTION_TIMEOUT_MS)
        Effect.runFork(
          Effect.tryPromise({
            try: () => handle.prompt(prompt),
            catch: (cause) =>
              new AgentRuntimeError({
                reason: "provider",
                message: "pi memory reflection failed",
                cause
              })
          }).pipe(
            Effect.catchAll(() => {
              finishReflection()
              return settleSession(handle, sink)
            })
          )
        )
        return
      }
    }

    finishReflection()
    Effect.runFork(settleSession(handle, sink))
  })
  return () => {
    finishReflection()
    unsubscribe()
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
      yield* Ref.update(sessions, (current) => new Map(current).set(handle.id, handle))
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
            Effect.zipRight(
              Effect.promise(async () => {
                try {
                  unsubscribe()
                } finally {
                  await handle.dispose()
                }
              })
            ),
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
          Stream.succeed<StreamEvent>({
            _tag: "Failed",
            message: error.message
          })
        )
      )
    )
  )

export const makePiAgentRuntime = (factory: PiSessionFactory): Effect.Effect<AgentRuntimeShape> =>
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
