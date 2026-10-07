// @vitest-environment node
import { createActor } from "xstate"
import { expect, it } from "vitest"
import { routineDraft, routineFormMachine } from "./routine-form-machine.js"
import { settingsModels, settingsRoutine } from "./project-settings-fixtures.js"
it("revokes approval on custom select and switch changes, preserves no-op consent, and resets new drafts", () => {
  const actor = createActor(routineFormMachine, {
    input: { selected: settingsRoutine, models: settingsModels },
  }).start()
  actor.send({ type: "APPROVE", approved: true })
  actor.send({ type: "EDIT", patch: { name: settingsRoutine.name } })
  expect(actor.getSnapshot().context.approved).toBe(true)
  actor.send({ type: "EDIT", patch: { schedule: "interval" } })
  expect(actor.getSnapshot().context.approved).toBe(false)
  actor.send({ type: "APPROVE", approved: true })
  actor.send({ type: "EDIT", patch: { enabled: true } })
  expect(actor.getSnapshot().context.approved).toBe(false)
  actor.send({ type: "ERROR", message: "Failed" })
  expect(actor.getSnapshot().context.draft.name).toBe(settingsRoutine.name)
  actor.send({ type: "RESET", draft: routineDraft({ models: settingsModels }) })
  expect(actor.getSnapshot().context.draft.name).toBe("")
  expect(actor.getSnapshot().context.error).toBeNull()
  expect(actor.getSnapshot().context.approved).toBe(false)
  actor.stop()
})
