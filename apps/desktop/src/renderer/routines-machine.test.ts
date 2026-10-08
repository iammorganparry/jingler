import type { RoutineDocument } from "@jingler/core"
import { settingsRoutine, settingsDocument } from "../../../../packages/ui/src/composites/project-settings-fixtures.js"
import { createActor } from "xstate"
import { expect, it, vi } from "vitest"
import { routinesMachine, type RoutinesApi } from "./routines-machine.js"
const document: RoutineDocument = { version: 1 as const, routines: [], runs: [] }
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

it.each(["SAVE", "ENABLE", "DELETE", "RUN", "CANCEL", "OPEN"] as const)(
  "accepts %s during a pending refresh and ignores its stale result",
  async (type) => {
    const port = api()
    let finishRead!: (value: RoutineDocument) => void
    vi.mocked(port.list).mockResolvedValueOnce(document).mockImplementationOnce(
      () => new Promise((resolve) => { finishRead = resolve }),
    ).mockResolvedValue(document)
    const actor = createActor(routinesMachine, { input: { api: port } }).start()
    await vi.waitFor(() => expect(actor.getSnapshot().matches("ready")).toBe(true))
    actor.send({ type: "REFRESH" })
    expect(actor.getSnapshot().matches({ ready: "refreshing" })).toBe(true)
    actor.send({ type: "EDIT", id: "draft" })
    expect(actor.getSnapshot().context.editing).toBe("draft")
    const settingsInput = settingsRoutine
    actor.send(type === "SAVE" ? { type, id: "draft", input: settingsInput } :
      type === "ENABLE" ? { type, id: "draft", enabled: true } : { type, id: "draft" })
    expect(actor.getSnapshot().matches("working")).toBe(true)
    await vi.waitFor(() => expect(actor.getSnapshot().matches("ready")).toBe(true))
    const snapshot = actor.getSnapshot()
    finishRead(settingsDocument)
    await Promise.resolve()
    expect(actor.getSnapshot().context.document).toBe(snapshot.context.document)
    if (type === "SAVE") expect(port.save).toHaveBeenCalledWith("draft", settingsInput)
    if (type === "ENABLE") expect(port.enable).toHaveBeenCalledWith("draft", true)
    if (type === "DELETE") expect(port.delete).toHaveBeenCalledWith("draft")
    if (type === "RUN") expect(port.runNow).toHaveBeenCalledWith("draft")
    if (type === "CANCEL") expect(port.cancel).toHaveBeenCalledWith("draft")
    if (type === "OPEN") expect(port.open).toHaveBeenCalledWith("draft")
    actor.stop()
  },
)
it("loads templates into a new editor without mutating a saved routine or granting consent", async () => {
  const api = { list: vi.fn(async () => ({ version: 1 as const, routines: [], runs: [] })), open: vi.fn(), save: vi.fn(), enable: vi.fn(), delete: vi.fn(), runNow: vi.fn(), cancel: vi.fn() }
  const actor = createActor(routinesMachine, { input: { api } }).start()
  await vi.waitFor(() => expect(actor.getSnapshot().matches("ready")).toBe(true))
  actor.send({ type: "EDIT", id: "saved-id" })
  const template = { id: "template-id", name: "Inspect", prompt: "Read README", baseBranch: "main", reasoning: null, schedule: { kind: "once" as const, at: 0 }, maxDurationMs: 60000 }
  actor.send({ type: "TEMPLATE", projectId: "widget", template })
  expect(actor.getSnapshot().context.editing).toBeUndefined()
  expect(actor.getSnapshot().context.template).toEqual(template)
  expect(actor.getSnapshot().context.templateProjectId).toBe("widget")
  expect(actor.getSnapshot().context.document.routines).toEqual([])
  expect(api.save).not.toHaveBeenCalled()
  actor.send({ type: "EDIT", id: "saved-id" })
  expect(actor.getSnapshot().context.template).toBeUndefined()
  actor.stop()
})
