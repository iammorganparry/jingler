import { createActor, waitFor } from "xstate"
import { Schema } from "effect"
import { Session } from "@jingler/core"
import { expect, it, vi } from "vitest"
import { workspaceCheckpointsMachine } from "./workspace-checkpoints-machine.js"
const session = Schema.decodeUnknownSync(Session)({ id: "test", repo: "test", branch: "main", title: "test", status: "idle", diff: { added: 0, removed: 0 }, prNumber: null, costUsd: 0, tokens: 0, updatedAt: "now", chats: [], activeChatId: "chat" })
it("requires consent, exposes failure and retries without enabling automatically", async () => {
  const api = { setMode: vi.fn().mockRejectedValueOnce(new Error("Create a fresh workspace")).mockResolvedValue({ ...session, checkpointSafeMode: true }), list: vi.fn().mockResolvedValue([]), capture: vi.fn(), preview: vi.fn(), restore: vi.fn() }
  const onSession = vi.fn()
  const actor = createActor(workspaceCheckpointsMachine, { input: { session, api, onSession } }).start()
  actor.send({ type: "OPEN" }); await waitFor(actor, (s) => s.matches("ready"))
  actor.send({ type: "ENABLE" }); expect(actor.getSnapshot().matches("consent")).toBe(true); expect(api.setMode).not.toHaveBeenCalled()
  actor.send({ type: "CONFIRM" }); await waitFor(actor, (s) => s.matches("failed"))
  expect(onSession).not.toHaveBeenCalled(); expect(actor.getSnapshot().context.error).toContain("fresh workspace")
  actor.send({ type: "RETRY" }); await waitFor(actor, (s) => s.matches("ready"))
  expect(onSession).toHaveBeenCalledWith(expect.objectContaining({ checkpointSafeMode: true })); actor.stop()
})
it("requires preview confirmation and retains its exact token", async () => {
  const preview = { checkpointId: "cp", token: "exact", operations: [], indexOperations: [{ path: "staged", action: "overwrite" as const }], diff: "diff", indexDiff: "index diff" }
  const api = { setMode: vi.fn(), list: vi.fn().mockResolvedValue([]), capture: vi.fn(), preview: vi.fn().mockResolvedValue(preview), restore: vi.fn().mockResolvedValue({}) }
  const actor = createActor(workspaceCheckpointsMachine, { input: { session, api, onSession: vi.fn() } }).start()
  actor.send({ type: "OPEN" }); await waitFor(actor, (s) => s.matches("ready"))
  actor.send({ type: "PREVIEW", id: "cp" }); await waitFor(actor, (s) => s.matches("confirming")); expect(api.restore).not.toHaveBeenCalled()
  actor.send({ type: "CONFIRM" }); await waitFor(actor, (s) => s.matches("ready"))
  expect(api.restore).toHaveBeenCalledWith("test", "cp", "exact"); actor.stop()
})
it("cancelling the revert confirm never calls restore and drops the preview", async () => {
  const preview = { checkpointId: "cp", token: "t", operations: [{ path: "a.txt", action: "overwrite" as const }], indexOperations: [], diff: "", indexDiff: "" }
  const api = { setMode: vi.fn(), list: vi.fn().mockResolvedValue([]), capture: vi.fn(), preview: vi.fn().mockResolvedValue(preview), restore: vi.fn() }
  const actor = createActor(workspaceCheckpointsMachine, { input: { session, api, onSession: vi.fn() } }).start()
  actor.send({ type: "OPEN" }); await waitFor(actor, (s) => s.matches("ready"))
  actor.send({ type: "PREVIEW", id: "cp" }); await waitFor(actor, (s) => s.matches("confirming"))
  expect(actor.getSnapshot().context.preview?.operations).toEqual(preview.operations)
  actor.send({ type: "CANCEL" })
  expect(actor.getSnapshot().matches("ready")).toBe(true); expect(actor.getSnapshot().context.preview).toBeNull()
  expect(api.restore).not.toHaveBeenCalled(); actor.stop()
})
it("a failed restore keeps the previewed file list and Retry restores with the same token", async () => {
  const preview = { checkpointId: "cp", token: "exact", operations: [{ path: "a.txt", action: "overwrite" as const }], indexOperations: [], diff: "", indexDiff: "" }
  const api = { setMode: vi.fn(), list: vi.fn().mockResolvedValue([]), capture: vi.fn(), preview: vi.fn().mockResolvedValue(preview), restore: vi.fn().mockRejectedValueOnce(new Error("Workspace changed before restore. Preview again.")).mockResolvedValue({}) }
  const actor = createActor(workspaceCheckpointsMachine, { input: { session, api, onSession: vi.fn() } }).start()
  actor.send({ type: "OPEN" }); await waitFor(actor, (s) => s.matches("ready"))
  actor.send({ type: "PREVIEW", id: "cp" }); await waitFor(actor, (s) => s.matches("confirming"))
  actor.send({ type: "CONFIRM" }); await waitFor(actor, (s) => s.matches("restoreFailed"))
  expect(actor.getSnapshot().context.error).toContain("Workspace changed"); expect(actor.getSnapshot().context.preview).toEqual(preview)
  actor.send({ type: "RETRY" }); await waitFor(actor, (s) => s.matches("ready"))
  expect(api.restore).toHaveBeenCalledTimes(2); expect(api.restore).toHaveBeenLastCalledWith("test", "cp", "exact"); actor.stop()
})
