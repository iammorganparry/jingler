import { Effect, Fiber, Layer, Schema } from "effect"
import { Session } from "@jingler/core"
import { afterEach, expect, it, vi } from "vitest"
import { acquireCheckpointedTurn, acquireCheckpointedTurnScoped, WorkspaceCheckpointService } from "./workspace-checkpoints.js"
import { acquireWorkspaceActivity, acquireWorkspaceToolActivity, checkpointTurnOwner, resetWorkspaceAdmissions, workspaceActivityCount } from "./workspace-admission.js"
const session = (extra: Record<string, unknown> = {}) => Schema.decodeUnknownSync(Session)({ id: "test", repo: "test", branch: "main", title: "test", status: "idle", diff: { added: 0, removed: 0 }, prNumber: null, costUsd: 0, tokens: 0, updatedAt: "now", chats: [{ id: "pi", title: null, createdAt: "now", updatedAt: "now", mode: "auto", runtimeId: "pi" }, { id: "native", title: null, createdAt: "now", updatedAt: "now", mode: "auto", runtimeId: "codex" }], activeChatId: "pi", workspaceMode: "worktree", worktreePath: "/missing", checkpointExecutionHistory: "clean", ...extra })
afterEach(() => { vi.restoreAllMocks(); resetWorkspaceAdmissions() })
it("default OFF preserves parallel turns regardless of legacy history", async () => {
  const first = await acquireCheckpointedTurn(session({ checkpointExecutionHistory: undefined }), "/missing")
  const second = await acquireCheckpointedTurn(session(), "/missing")
  expect(workspaceActivityCount("test")).toBe(2); first.release(); second.release()
})
it("checks the actual requested inactive native chat before capture", async () => {
  await expect(acquireCheckpointedTurn(session({ checkpointSafeMode: true }), "/missing", "native")).rejects.toThrow("managed Pi")
})
it("legacy and unsupported history never enable a checkpoint turn", async () => {
  for (const history of [undefined, "unprovable"]) await expect(acquireCheckpointedTurn(session({ checkpointSafeMode: true, checkpointExecutionHistory: history }), "/missing")).rejects.toThrow("prior or unknown")
})
it("capture failure blocks execution, releases closure, and supports Retry", async () => {
  for (let attempt = 0; attempt < 2; attempt++) await expect(acquireCheckpointedTurn(session({ checkpointSafeMode: true }), "/missing")).rejects.toThrow("turn was blocked")
  expect(checkpointTurnOwner("test")).toBeUndefined(); expect(workspaceActivityCount("test")).toBe(0)
})
it("active work is refused without releasing or killing it", async () => {
  const active = acquireWorkspaceActivity("test", "terminal")
  await expect(acquireCheckpointedTurn(session({ checkpointSafeMode: true }), "/missing")).rejects.toThrow("Stop active work")
  expect(workspaceActivityCount("test")).toBe(1); active.release()
})
it("ownerless tools cannot bypass safe-mode admission", async () => {
  await expect(acquireCheckpointedTurn(session({ checkpointSafeMode: true }), "/missing")).rejects.toThrow()
  expect(() => acquireWorkspaceToolActivity("test")).toThrow("owner tool")
})


it.each(["resolve", "reject"])("interrupted deferred capture %s leaves no admission or lease", async outcome => {
  const { WorkspaceCheckpointStore } = await import("./workspace-checkpoint-store.js")
  const { workspaceAdmissionReason } = await import("./workspace-admission.js")
  type Capture = Awaited<ReturnType<InstanceType<typeof WorkspaceCheckpointStore>["capture"]>>
  let resolveCapture!: (value: Capture) => void
  let rejectCapture!: (cause: Error) => void
  const deferred = { promise: new Promise<Capture>((resolve, reject) => { resolveCapture = resolve; rejectCapture = reject }) }
  let signalStarted!: () => void
  const started = { promise: new Promise<void>((resolve) => { signalStarted = resolve }) }
  vi.spyOn(WorkspaceCheckpointStore.prototype, "capture").mockImplementation(() => { signalStarted(); return deferred.promise })
  const fiber = Effect.runFork(Effect.scoped(acquireCheckpointedTurnScoped(session({ checkpointSafeMode: true }), "/missing")))
  await started.promise
  const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
  // Interruption cannot abandon acquisition before its finalizer is registered.
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(workspaceAdmissionReason("test")).toContain("capturing")
  if (outcome === "resolve") resolveCapture({} as Capture)
  else rejectCapture(new Error("capture failed"))
  await interrupted
  expect(checkpointTurnOwner("test")).toBeUndefined()
  expect(workspaceActivityCount("test")).toBe(0)
  expect(workspaceAdmissionReason("test")).toBeUndefined()
  const retried = await acquireCheckpointedTurn(session(), "/missing"); retried.release()
})

it("disables tainted safe mode exclusively without clearing history; enabling still fails", async () => {
  const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  const { SessionStore } = await import("./sessions.js")
  const { withTempRoot } = await import("./test-support.js")
  const { workspaceCheckpointMode } = await import("./workspace-admission.js")
  const temp = withTempRoot()
  try {
    mkdirSync(temp.root, { recursive: true })
    writeFileSync(join(temp.root, "sessions.json"), JSON.stringify([session({ checkpointSafeMode: true, checkpointExecutionHistory: "unprovable", checkpointPtyHistory: true })]))
    await Effect.runPromise(Effect.gen(function* () {
      const service = yield* WorkspaceCheckpointService
      const active = acquireWorkspaceActivity("test", "agent-turn")
      const refusal = yield* service.setMode("test", false).pipe(Effect.either)
      expect(refusal._tag).toBe("Left"); active.release()
      const disabled = yield* service.setMode("test", false)
      expect(disabled.checkpointSafeMode).toBe(false)
      expect(disabled.checkpointExecutionHistory).toBe("unprovable")
      expect(disabled.checkpointPtyHistory).toBe(true)
      expect(workspaceCheckpointMode("test")).toBe(false)
      const enable = yield* service.setMode("test", true).pipe(Effect.either)
      expect(enable._tag).toBe("Left")
    }).pipe(Effect.provide(WorkspaceCheckpointService.Default.pipe(Layer.provideMerge(SessionStore.Default))), Effect.provide(temp.layer)))
    expect(JSON.parse(readFileSync(join(temp.root, "sessions.json"), "utf8"))[0].checkpointExecutionHistory).toBe("unprovable")
  } finally { temp.cleanup() }
})
