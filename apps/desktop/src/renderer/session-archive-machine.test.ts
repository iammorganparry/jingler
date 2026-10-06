import { createActor } from "xstate"
import { expect, it, vi } from "vitest"
import type { Session } from "@jingler/core"
import { sessionArchiveMachine } from "./session-archive-machine.js"
it("requires warning acknowledgement before metadata archive and forwards consent", async () => {
  const session = { id: "s_test", checkpointPtyHistory: true } as Session
  const archive = vi.fn(async () => session); const onSession = vi.fn()
  const actor = createActor(sessionArchiveMachine, { input: { load: async () => session, archive, onSession } }).start()
  actor.send({ type: "ARCHIVE", session: { ...session, checkpointPtyHistory: false } })
  await vi.waitFor(() => expect(actor.getSnapshot().matches("confirming")).toBe(true)); expect(archive).not.toHaveBeenCalled()
  actor.send({ type: "CANCEL" }); expect(archive).not.toHaveBeenCalled()
  actor.send({ type: "ARCHIVE", session }); await vi.waitFor(() => expect(actor.getSnapshot().matches("confirming")).toBe(true)); actor.send({ type: "CONFIRM" })
  await vi.waitFor(() => expect(onSession).toHaveBeenCalledWith(session))
  expect(archive).toHaveBeenCalledWith("s_test", true); actor.stop()
})
it("ordinary archive without PTY history does not request metadata-only consent", async () => {
  const session = { id: "s_test" } as Session; const archive = vi.fn(async () => session)
  const actor = createActor(sessionArchiveMachine, { input: { load: async () => session, archive, onSession: vi.fn() } }).start()
  actor.send({ type: "ARCHIVE", session }); await vi.waitFor(() => expect(archive).toHaveBeenCalledWith("s_test", false)); actor.stop()
})

it("reloads after failure and never treats Retry as consent", async () => {
  const session = { id: "s_test", checkpointPtyHistory: false } as Session
  const load = vi.fn().mockResolvedValueOnce(session).mockResolvedValue({ ...session, checkpointPtyHistory: true })
  const archive = vi.fn().mockRejectedValue(new Error("history changed"))
  const actor = createActor(sessionArchiveMachine, { input: { load, archive, onSession: vi.fn() } }).start()
  actor.send({ type: "ARCHIVE", session })
  await vi.waitFor(() => expect(actor.getSnapshot().matches("failed")).toBe(true))
  actor.send({ type: "CONFIRM" })
  await vi.waitFor(() => expect(actor.getSnapshot().matches("confirming")).toBe(true))
  expect(archive).toHaveBeenCalledTimes(1)
  expect(archive).toHaveBeenCalledWith("s_test", false)
  actor.send({ type: "CANCEL" }); expect(archive).toHaveBeenCalledTimes(1)
  actor.stop()
})
