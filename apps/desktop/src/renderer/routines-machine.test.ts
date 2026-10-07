import { createActor } from "xstate"
import { expect, it, vi } from "vitest"
import { routinesMachine, type RoutinesApi } from "./routines-machine.js"
const document = { version: 1 as const, routines: [], runs: [] }
const api = (): RoutinesApi => ({ open: vi.fn(async () => {}), list: vi.fn(async () => document), save: vi.fn(async () => document), enable: vi.fn(async () => document), delete: vi.fn(async () => document), runNow: vi.fn(async () => {}), cancel: vi.fn(async () => document) })
it("keeps async operations coupled and refreshes history after Run now", async () => {
  const port = api(); const actor = createActor(routinesMachine, { input: { api: port } }).start()
  await vi.waitFor(() => expect(actor.getSnapshot().matches("ready")).toBe(true))
  actor.send({ type: "RUN", id: "routine" }); expect(actor.getSnapshot().matches("working")).toBe(true)
  actor.send({ type: "DELETE", id: "routine" }); expect(port.delete).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(actor.getSnapshot().matches("ready")).toBe(true))
  expect(port.runNow).toHaveBeenCalledWith("routine"); expect(port.list).toHaveBeenCalledTimes(2); actor.stop()
})
it("shows failures and retries a read without replaying a mutation", async () => {
  const port = api(); vi.mocked(port.runNow).mockRejectedValue(new Error("Unavailable"))
  const actor = createActor(routinesMachine, { input: { api: port } }).start()
  await vi.waitFor(() => expect(actor.getSnapshot().matches("ready")).toBe(true))
  actor.send({ type: "RUN", id: "routine" }); await vi.waitFor(() => expect(actor.getSnapshot().matches("failed")).toBe(true))
  expect(actor.getSnapshot().context.error).toBe("Unavailable")
  actor.send({ type: "REFRESH" }); await vi.waitFor(() => expect(actor.getSnapshot().matches("ready")).toBe(true))
  expect(port.runNow).toHaveBeenCalledTimes(1); actor.stop()
})
it("opens a linked session through the async actor and reports load errors", async () => {
  const port = api(); vi.mocked(port.open).mockRejectedValue(new Error("Workspace unavailable"))
  const actor = createActor(routinesMachine, { input: { api: port } }).start()
  await vi.waitFor(() => expect(actor.getSnapshot().matches("ready")).toBe(true))
  actor.send({ type: "OPEN", id: "reserved-session" })
  expect(actor.getSnapshot().matches("working")).toBe(true)
  await vi.waitFor(() => expect(actor.getSnapshot().matches("failed")).toBe(true))
  expect(port.open).toHaveBeenCalledWith("reserved-session")
  expect(actor.getSnapshot().context.error).toBe("Workspace unavailable"); actor.stop()
})
