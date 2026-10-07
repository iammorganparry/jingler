import { Effect, Layer, Schema, Stream } from "effect"
import { afterEach, expect, it, vi } from "vitest"
import { AgentRunner, AuthService, ProjectService, ProviderConnections, SessionStore, WorkspaceCheckpointService } from "@jingler/cli-adapters"
import { RoutineInput, type AuthSession } from "@jingler/core"
import { withTempRoot } from "../../../../packages/cli-adapters/src/test-support.js"
import { RoutinesService } from "./routines.js"

const input = Schema.decodeUnknownSync(RoutineInput)({ name: "Inspect", projectId: "local", prompt: "Inspect", baseBranch: "main", runtimeId: "pi", endpointId: "desktop:pi:test", connectionId: "test", providerId: "test", modelId: "model", mode: "ask", reasoning: null, enabled: true, approved: true, schedule: { kind: "once", at: Date.now() + 60_000 }, maxDurationMs: 60_000 })
const cleanup: Array<() => void> = []
afterEach(() => { vi.useRealTimers(); cleanup.splice(0).forEach(fn => { fn() }); vi.restoreAllMocks() })
async function fixture(stop: () => Effect.Effect<void, Error> = () => Effect.void) {
  const temp = withTempRoot(); cleanup.push(temp.cleanup)
  let session: AuthSession | null = { user: { id: "u", name: "", email: "", image: null }, expiresAt: new Date(Date.now() + 3600_000).toISOString() }
  let unreachable = false
  const create = vi.fn((options: { requestedSessionId: string; routineOccurrence: unknown }) => Effect.succeed({ id: options.requestedSessionId, routineOccurrence: options.routineOccurrence, activeChatId: "chat", checkpointSafeMode: true, checkpointExecutionHistory: "clean", workspaceLifecycle: { status: "setup-skipped" } }))
  let entered!: () => void
  const prompted = new Promise<void>(resolve => { entered = resolve })
  const prompt = vi.fn(() => Stream.fromEffect(Effect.sync(entered).pipe(Effect.zipRight(Effect.never))))
  const mocks = Layer.mergeAll(
    Layer.succeed(AuthService, { getSession: () => unreachable ? Effect.never : Effect.succeed(session) } as unknown as AuthService),
    Layer.succeed(SessionStore, { create, get: () => Effect.succeed(null) } as unknown as SessionStore),
    Layer.succeed(ProjectService, { get: () => Effect.succeed({ path: temp.root, name: "repo", availability: "available" }) } as unknown as ProjectService),
    Layer.succeed(ProviderConnections, { list: Effect.succeed({ connections: [{ connection: { status: "authenticated", targetId: "desktop", id: "test" }, models: [{ providerId: "test", id: "model", selectable: true }] }] }) } as unknown as typeof ProviderConnections.Service),
    Layer.succeed(WorkspaceCheckpointService, { setMode: () => Effect.void } as unknown as WorkspaceCheckpointService),
    Layer.succeed(AgentRunner, { prompt, stop } as unknown as AgentRunner)
  )
  // Mock methods require no turn-driver dependencies captured by the production runtime.
  const built = RoutinesService.pipe(Effect.provide(RoutinesService.Default.pipe(Layer.provide(mocks), Layer.provide(temp.layer))))
  const service = await Effect.runPromise(built as Effect.Effect<RoutinesService>)
  cleanup.push(() => { service.scheduler.closeAdmission() })
  const id = (await service.scheduler.store.save(undefined, input, null, Date.now())).routines[0]!.id
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
  const settled = async () => {
    for (let i = 0; i < 100; i++) {
      const doc = await service.scheduler.list()
      if (doc.runs[0]?.finishedAt != null) return doc
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error("Occurrence did not settle")
  }
  return { service, id, run, create, prompt, prompted, settled, revoke: () => { session = null }, restore: () => { session = { user: { id: "u", name: "", email: "", image: null }, expiresAt: new Date(Date.now() + 3600_000).toISOString() } }, hang: () => { unreachable = true } }
}
it("null auth closes real service admission and fences due callbacks until fresh start", async () => {
  const f = await fixture()
  let due!: () => void
  vi.spyOn(f.service.scheduler.clock, "setTimer").mockImplementation(callback => { due = callback; return undefined })
  await f.run(f.service.start)
  f.revoke(); await f.run(f.service.runNow(f.id)); await f.settled()
  expect(f.create).not.toHaveBeenCalled(); expect(f.prompt).not.toHaveBeenCalled()
  await expect(f.run(f.service.runNow(f.id))).rejects.toThrow("unavailable")
  due(); await f.service.scheduler.refresh()
  expect((await f.service.scheduler.list()).runs).toHaveLength(1)
  f.restore(); await f.run(f.service.resume); expect(f.service.scheduler.running).toBe(false)
  await f.run(f.service.start); expect(f.service.scheduler.running).toBe(true)
})
it("failed suspended resume cannot reopen on later valid resume", async () => {
  const f = await fixture(); await f.run(f.service.start); f.service.scheduler.suspend(); f.revoke()
  await expect(f.run(f.service.resume)).rejects.toThrow("Sign in")
  f.restore(); await f.run(f.service.resume)
  expect(f.service.scheduler.running).toBe(false)
  await expect(f.run(f.service.runNow(f.id))).rejects.toThrow("unavailable")
})
it.each(["early", "late"] as const)("production prompt retains activity when runner stop rejects %s", async timing => {
  let reject!: (error: Error) => void
  const stopping = new Promise<void>((_, fail) => { reject = fail }); void stopping.catch(() => {})
  const f = await fixture(() => Effect.tryPromise({ try: () => stopping, catch: cause => new Error(String(cause)) }))
  await f.run(f.service.start); await f.run(f.service.runNow(f.id)); await f.prompted
  if (timing === "late") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  const cancelling = f.run(f.service.cancel((await f.service.scheduler.list()).runs[0]!.id))
  if (timing === "early") reject(new Error("stop rejected"))
  else { await vi.advanceTimersByTimeAsync(10_001) }
  await cancelling
  if (timing === "late") { reject(new Error("late rejection")); await stopping.catch(() => {}); vi.useRealTimers() }
  const doc = await f.service.scheduler.list()
  expect(doc.runs[0]!.status).toBe("failed"); expect(doc.runs[0]!.sessionId).toBe(doc.runs[0]!.requestedSessionId)
  expect(doc.health.error).toContain("teardown"); expect(f.service.scheduler.activityUnresolved).toBe(true)
  await expect(f.run(f.service.runNow(f.id))).rejects.toThrow()
})

it("auth timeout closes production service admission without creation", async () => {
  const f = await fixture(); await f.run(f.service.start); f.hang()
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  const resumed = expect(f.run(f.service.resume)).rejects.toThrow("timed out")
  await vi.advanceTimersByTimeAsync(10_001); await resumed
  expect(f.service.scheduler.running).toBe(false)
  await expect(f.run(f.service.runNow(f.id))).rejects.toThrow("unavailable")
  expect(f.create).not.toHaveBeenCalled(); expect(f.prompt).not.toHaveBeenCalled()
})
