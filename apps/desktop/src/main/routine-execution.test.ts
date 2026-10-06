import { join } from "node:path"
import { existsSync, readdirSync } from "node:fs"
import { Effect, Layer, Runtime, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RoutineInput, type RoutineRun, type Session } from "@jingler/core"
import { SessionStore, GitService, WorkspaceCheckpointService } from "@jingler/cli-adapters"
import { RoutineStore } from "@jingler/cli-adapters/routine-store"
import { acquireCheckpointedTurn } from "@jingler/cli-adapters/workspace-checkpoints"
import { initGitRepo, mkTemp, withTempRoot } from "../../../../packages/cli-adapters/src/test-support.js"
import { routineExecution, runOwnedRoutineEffect, RoutinePreparationPendingError } from "./routine-execution.js"
vi.mock("@jingler/cli-adapters/workspace-ports", async importOriginal => {
  const actual = await importOriginal<typeof import("@jingler/cli-adapters/workspace-ports")>()
  return { ...actual, allocateWorkspacePorts: (sessions: readonly Session[]) => actual.allocateWorkspacePorts(sessions, undefined, async () => true) }
})
const input = Schema.decodeUnknownSync(RoutineInput)({ name: "Inspect", projectId: "local", prompt: "Inspect", baseBranch: "main", runtimeId: "pi", endpointId: "pi:test", connectionId: "test", providerId: "test", modelId: "model", mode: "ask", reasoning: null, enabled: true, approved: true, schedule: { kind: "once", at: 1000 }, maxDurationMs: 1000 })
const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose() })
describe("routine execution adapter", () => {
  const fixture = async () => {
    const temp = withTempRoot(); const repo = mkTemp("routine-git-"); cleanup.push(() => { temp.cleanup(); repo.cleanup() })
    const repoPath = initGitRepo(join(repo.dir, "repo"))
    const store = new RoutineStore(join(temp.root, "routines.json"))
    const id = (await store.save(undefined, input, null, 0)).routines[0]!.id
    const claim = (await store.claim(id, "manual", 0))!
    const services = Layer.mergeAll(SessionStore.Default, GitService.Default, WorkspaceCheckpointService.Default.pipe(Layer.provide(SessionStore.Default)))
    const create = (run: RoutineRun) => Effect.runPromise(SessionStore.create({ ...input, repoPath, repoName: "repo", requestedSessionId: run.requestedSessionId, routineOccurrence: { routineId: run.routineId, runId: run.id }, checkpointSafeMode: true }, { defaultMode: input.mode }).pipe(Effect.provide(services), Effect.provide(temp.layer)))
    const setMode = (id: string) => Effect.runPromise(WorkspaceCheckpointService.setMode(id, true).pipe(Effect.provide(services), Effect.provide(temp.layer)))
    return { temp, repoPath, store, claim, create, setMode }
  }
  it("durably reserves identity, creates a real isolated Git session, and captures before prompt work", async () => {
    const { temp, repoPath, store, claim, create, setMode } = await fixture()
    const prompt = vi.fn(async (session: Session) => {
      expect(session.worktreePath).not.toBe(repoPath)
      expect(session.chats.find(chat => chat.id === session.activeChatId)!.mode).toBe("ask")
      const lease = await acquireCheckpointedTurn(session, join(temp.root, "checkpoints"), session.activeChatId)
      try { expect(readdirSync(join(temp.root, "checkpoints")).flatMap(owner => readdirSync(join(temp.root, "checkpoints", owner))).length).toBeGreaterThan(0) } finally { lease.release() }
      return { status: "succeeded" as const, message: "Done" }
    })
    const execute = routineExecution({ validate: async () => {}, create: (_, run) => create(run), setMode, prompt })
    await execute(claim.routine, claim.run, new AbortController().signal, () => store.isCurrent(claim.run), () => store.link(claim.run, 0))
    expect(prompt).toHaveBeenCalledTimes(1)
    expect((await store.read()).runs[0]!.sessionId).toBe(claim.run.requestedSessionId)
  })
  it("never calls prompt after checkpoint failure and keeps the created worktree", async () => {
    const { claim, create, store } = await fixture(); const prompt = vi.fn()
    let created: Session | undefined
    const execute = routineExecution({ validate: async () => {}, create: async (_, run) => { created = await create(run); return created }, setMode: async () => { throw new Error("capture failed") }, prompt })
    await expect(execute(claim.routine, claim.run, new AbortController().signal, async () => true, () => store.link(claim.run, 0))).rejects.toThrow("capture failed")
    expect(prompt).not.toHaveBeenCalled(); expect(existsSync(created!.worktreePath!)).toBe(true)
    expect((await store.read()).runs[0]!.sessionId).toBe(created!.id)
  })
  it("cancellation or revision changes while creation awaits prevent mode and prompt", async () => {
    const { claim, create, store } = await fixture(); const controller = new AbortController(); const setMode = vi.fn(); const prompt = vi.fn()
    const execute = routineExecution({ validate: async () => {}, create: async (_, run) => { const session = await create(run); await store.enable(claim.routine.id, false, 1); controller.abort(); return session }, setMode, prompt })
    await expect(execute(claim.routine, claim.run, controller.signal, () => store.isCurrent(claim.run), () => store.link(claim.run, 0))).rejects.toThrow("cancelled")
    expect(setMode).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled()
    expect((await store.read()).runs[0]!.sessionId).toBe(claim.run.requestedSessionId)
  })
  it.each(["id", "routineId", "runId"] as const)("never links a created session with wrong %s", async key => {
    const { claim, create, store } = await fixture(); const prompt = vi.fn(); const setMode = vi.fn()
    const session = await create(claim.run)
    const wrong = key === "id" ? { ...session, id: "foreign" } : { ...session, routineOccurrence: { ...session.routineOccurrence!, [key]: "foreign" } }
    const execute = routineExecution({ validate: async () => {}, create: async () => wrong, setMode, prompt })
    await expect(execute(claim.routine, claim.run, new AbortController().signal, async () => true, () => store.link(claim.run, 0))).rejects.toThrow("reserved occurrence")
    expect((await store.read()).runs[0]!.sessionId).toBeNull()
    expect(setMode).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled()
  })
  it("links late real Git creation to failed history after bounded cancellation, without a prompt", async () => {
    const { claim, create, store } = await fixture(); const controller = new AbortController(); const prompt = vi.fn(); const setMode = vi.fn()
    let release!: () => void; let entered!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const execute = routineExecution({ validate: async () => {}, create: (_, run, signal, committed) => runOwnedRoutineEffect(Runtime.defaultRuntime, Effect.promise(async () => { entered(); await waiting; return create(run) }), signal, committed), setMode, prompt })
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const outcome = execute(claim.routine, claim.run, controller.signal, async () => true, () => store.link(claim.run, 0)).catch(error => error)
      await started; controller.abort(); await vi.advanceTimersByTimeAsync(10_000)
      const error = await outcome
      expect(error).toBeInstanceOf(RoutinePreparationPendingError)
      await store.finish(claim.run.id, "failed", error.message, 1)
      vi.useRealTimers(); release(); await error.pending.catch(() => {})
      const run = (await store.read()).runs[0]!
      expect(run.status).toBe("failed"); expect(run.sessionId).toBe(claim.run.requestedSessionId)
      expect(setMode).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled()
      await store.reconcile(async () => true, 2)
      expect((await store.read()).runs[0]!.status).toBe("failed")
    } finally { vi.useRealTimers(); release() }
  })
  it("Runtime AbortSignal interrupts validation before creation", async () => {
    const { claim } = await fixture(); const controller = new AbortController(); const create = vi.fn(); const prompt = vi.fn()
    let entered!: () => void; let innerSignal!: AbortSignal
    const started = new Promise<void>(resolve => { entered = resolve })
    const execute = routineExecution({ validate: (_, signal) => Runtime.runPromise(Runtime.defaultRuntime)(Effect.async<void>((_, abort) => { innerSignal = abort; entered() }), { signal }), create, setMode: vi.fn(), prompt })
    const outcome = execute(claim.routine, claim.run, controller.signal, async () => true, async () => {}).catch(error => error)
    await started; controller.abort(); expect(await outcome).toBeInstanceOf(Error)
    expect(innerSignal.aborted).toBe(true); expect(create).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled()
  })

})
