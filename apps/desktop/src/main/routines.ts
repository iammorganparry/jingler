import { routineExecution, runOwnedRoutineEffect } from "./routine-execution.js"
import { validateRoutineProject, validateRoutineModel } from "./routine-validation.js"
import { join } from "node:path"
import { AgentRunner, AppPaths, ProjectService, ProviderConnections, SessionStore, WorkspaceCheckpointService } from "@jingler/cli-adapters"
import { RoutineStore } from "@jingler/cli-adapters/routine-store"
import { GitError, type RoutineInput, type RoutineRun } from "@jingler/core"
import { Effect, Runtime, Stream } from "effect"
import { RoutineScheduler } from "./routine-scheduler.js"

export class RoutinesService extends Effect.Service<RoutinesService>()("desktop/Routines", {
  effect: Effect.gen(function* () {
    const paths = yield* AppPaths
    const sessions = yield* SessionStore
    const projects = yield* ProjectService
    const runner = yield* AgentRunner
    const checkpoints = yield* WorkspaceCheckpointService
    const providers = yield* ProviderConnections
    const validate = (input: RoutineInput, expectedDigest?: string | null) => Effect.gen(function* () {
      const project = yield* projects.get(input.projectId)
      const catalog = yield* providers.list
      const digest = yield* Effect.try({ try: () => {
        const digest = validateRoutineProject(input, project, expectedDigest)
        validateRoutineModel(input, catalog)
        return digest
      }, catch: cause => new GitError({ message: cause instanceof Error ? cause.message : String(cause), cause }) })
      return { project, digest }
    }).pipe(Effect.mapError(cause => new GitError({ message: cause.message, cause })))
    const create = (input: RoutineInput, run: RoutineRun) => Effect.gen(function* () {
      const { project } = yield* validate(input)
      return yield* sessions.create({ ...input, repoPath: project.path, repoName: project.name, title: input.name, requestedSessionId: run.requestedSessionId, routineOccurrence: { routineId: run.routineId, runId: run.id }, checkpointSafeMode: true, useWorktree: true }, { defaultMode: input.mode, defaultReasoning: input.reasoning ?? undefined })
    })
    type Environment = Effect.Effect.Context<ReturnType<typeof create>> | Stream.Stream.Context<ReturnType<typeof runner.prompt>> | Effect.Effect.Context<ReturnType<typeof validate>> | Effect.Effect.Context<ReturnType<typeof checkpoints.setMode>>
    const effectRuntime = yield* Effect.runtime<Environment>()
    const runEffect = Runtime.runPromise(effectRuntime)
    const store = new RoutineStore(join(paths.root, "routines.json"))
    const scheduler = new RoutineScheduler(store, {
      sessionExists: async id => {
        const session = await runEffect(sessions.get(id).pipe(Effect.orElseSucceed(() => null)))
        const document = await store.read()
        const run = document.runs.find(item => item.requestedSessionId === id)
        return session !== null && run !== undefined && session.routineOccurrence?.routineId === run.routineId && session.routineOccurrence.runId === run.id
      },
      execute: routineExecution({
        validate: (routine, signal) => runEffect(validate(routine, routine.workflowDigest), { signal }),
        create: (routine, run, signal, committed) => runOwnedRoutineEffect(effectRuntime, create(routine, run), signal, committed),
        setMode: (id, signal) => runOwnedRoutineEffect(effectRuntime, checkpoints.setMode(id, true), signal),
        prompt: async (session, routine, signal) => {
        const chatId = session.activeChatId
        let status: "succeeded" | "failed" | "needs-attention" = "failed"
        let message = "Agent ended without a completion event"
        let stopped: Promise<void> | undefined
        const stop = () => { stopped ??= runEffect(runner.stop(session.id, chatId, true).pipe(Effect.disconnect, Effect.timeoutFail({ duration: "10 seconds", onTimeout: () => new GitError({ message: "Routine cancellation teardown timed out" }) }))); void stopped.catch(() => {}) }
        signal.addEventListener("abort", stop, { once: true })
        try {
          if (signal.aborted) throw new Error("Routine cancelled before prompt")
          await runEffect(runner.prompt(session.id, chatId, routine.prompt, [], routine.reasoning).pipe(Stream.runForEach(event => Effect.sync(() => {
            if (event._tag === "Done" && status !== "needs-attention") { status = "succeeded"; message = "Completed" }
            if (event._tag === "Failed" && status !== "needs-attention") { status = "failed"; message = event.message }
            if (event._tag === "GateRequested" || event._tag === "QuestionRequested") { status = "needs-attention"; message = "Operator approval or answer required"; stop() }
          })), Effect.disconnect), { signal })
          if (stopped) await stopped
          return { status, message }
        } finally {
          signal.removeEventListener("abort", stop)
          if (signal.aborted) { stop(); await stopped }
        }
        }
      })
    })
    const request = <A>(operation: () => Promise<A>) => Effect.tryPromise({ try: operation, catch: cause => new GitError({ message: cause instanceof Error ? cause.message : String(cause), cause }) })
    let started = false
    let authenticated = false
    return {
      scheduler,
      start: request(async () => { authenticated = true; if (!started) { started = true; await scheduler.start(); started = scheduler.running } }),
      resume: request(async () => { if (authenticated) { await scheduler.wake(); if (!scheduler.running) { await scheduler.start(); started = scheduler.running } } }),
      stop: request(async () => { authenticated = false; started = false; await scheduler.stop() }),
      list: request(async () => { if (scheduler.error) throw new Error(scheduler.error); return store.read() }),
      save: (id: string | undefined, input: RoutineInput) => Effect.sync(() => scheduler.invalidatePending()).pipe(Effect.zipRight(validate(input))).pipe(Effect.flatMap(({ digest }) => request(async () => { const result = await store.save(id, input, digest, Date.now()); if (id) await scheduler.cancelRoutine(id); await scheduler.refresh(); return result }))),
      enable: (id: string, enabled: boolean) => request(async () => { scheduler.invalidatePending(); const result = await store.enable(id, enabled, Date.now()); await scheduler.cancelRoutine(id); await scheduler.refresh(); return result }),
      delete: (id: string) => request(async () => { scheduler.invalidatePending(); const result = await store.delete(id); await scheduler.cancelRoutine(id); await scheduler.refresh(); return result }),
      runNow: (id: string) => request(() => scheduler.runNow(id)),
      cancel: (id: string) => request(async () => { await scheduler.cancel(id); return store.read() })
    }
  })
}) {}
