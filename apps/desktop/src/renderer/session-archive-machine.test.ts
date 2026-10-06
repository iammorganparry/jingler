import { createActor } from "xstate"
import { expect, it, vi } from "vitest"
import type { Session } from "@jingler/core"
import { sessionArchiveMachine } from "./session-archive-machine.js"
it("requires warning acknowledgement before metadata archive and forwards consent", async () => {
  const session = { id: "s_test", checkpointPtyHistory: true } as Session
  const archive = vi.fn(async () => session); const onSession = vi.fn()
  const actor = createActor(sessionArchiveMachine, { input: { archive, onSession } }).start()
  actor.send({ type: "ARCHIVE", session })
  expect(actor.getSnapshot().matches("confirming")).toBe(true); expect(archive).not.toHaveBeenCalled()
  actor.send({ type: "CANCEL" }); expect(archive).not.toHaveBeenCalled()
  actor.send({ type: "ARCHIVE", session }); actor.send({ type: "CONFIRM" })
  await vi.waitFor(() => expect(onSession).toHaveBeenCalledWith(session))
  expect(archive).toHaveBeenCalledWith("s_test", true); actor.stop()
})
it("ordinary archive without PTY history does not request metadata-only consent", async () => {
  const session = { id: "s_test" } as Session; const archive = vi.fn(async () => session)
  const actor = createActor(sessionArchiveMachine, { input: { archive, onSession: vi.fn() } }).start()
  actor.send({ type: "ARCHIVE", session }); await vi.waitFor(() => expect(archive).toHaveBeenCalledWith("s_test", false)); actor.stop()
})
