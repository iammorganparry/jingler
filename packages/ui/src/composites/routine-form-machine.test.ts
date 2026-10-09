// @vitest-environment node
import { ProviderConnectionId } from "@jingler/core"
import { createActor } from "xstate"
import { expect, it } from "vitest"
import { modelKey, routinePayload, templateDraft, routineDraft, routineFormMachine } from "./routine-form-machine.js"
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
it("maps an unambiguous portable preference locally and imports with no consent or schedule enablement", () => {
  const model = settingsModels[0]!
  const template = { id: "shared", name: "Shared inspect", prompt: "Read README", baseBranch: "main", reasoning: null, maxDurationMs: 60000, schedule: { kind: "once" as const, at: 1800000000123 }, providerId: model.providerId, modelId: model.id }
  const actor = createActor(routineFormMachine, { input: { template, models: settingsModels } }).start()
  expect(actor.getSnapshot().context.draft.model).toBe(modelKey(model))
  expect(actor.getSnapshot().context.draft.enabled).toBe(false)
  expect(actor.getSnapshot().context.approved).toBe(false)
  expect(() => routinePayload(actor.getSnapshot().context.draft, false, "widget", settingsModels)).toThrow(/Approve/)
  actor.send({ type: "APPROVE", approved: true })
  expect(routinePayload(actor.getSnapshot().context.draft, true, "widget", settingsModels, undefined, template)).toMatchObject({ connectionId: model.connection.id, enabled: false, approved: true, mode: "ask", schedule: template.schedule })
  actor.stop()
  for (const [preference, models] of [
    [{}, settingsModels],
    [{ providerId: model.providerId }, settingsModels],
    [{ providerId: model.providerId, modelId: model.id }, []],
    [{ providerId: model.providerId, modelId: model.id }, [model, { ...model, connection: { ...model.connection, id: ProviderConnectionId.make("another") } }]],
  ] as const) {
    const draft = templateDraft({ ...template, providerId: undefined, modelId: undefined, ...preference }, [...models])
    expect(draft.model).toBe("")
    expect(() => routinePayload(draft, true, "widget", [...models])).toThrow(/unavailable/)
  }
})
