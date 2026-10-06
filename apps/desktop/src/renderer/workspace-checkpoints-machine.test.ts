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
  const preview = { checkpointId: "cp", token: "exact", operations: [], diff: "diff" }
  const api = { setMode: vi.fn(), list: vi.fn().mockResolvedValue([]), capture: vi.fn(), preview: vi.fn().mockResolvedValue(preview), restore: vi.fn().mockResolvedValue({}) }
  const actor = createActor(workspaceCheckpointsMachine, { input: { session, api, onSession: vi.fn() } }).start()
  actor.send({ type: "OPEN" }); await waitFor(actor, (s) => s.matches("ready"))
  actor.send({ type: "PREVIEW", id: "cp" }); await waitFor(actor, (s) => s.matches("confirming")); expect(api.restore).not.toHaveBeenCalled()
  actor.send({ type: "CONFIRM" }); await waitFor(actor, (s) => s.matches("ready"))
  expect(api.restore).toHaveBeenCalledWith("test", "cp", "exact"); actor.stop()
})
