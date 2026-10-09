// @vitest-environment node
import { createActor } from "xstate"
import { expect, it, vi } from "vitest"
import { projectWorkflowMachine, workflowDraft, workflowPayload } from "./project-workflow-machine.js"
import { settingsProjects } from "./project-settings-fixtures.js"
const project = settingsProjects[0]!
it("preserves retry IDs and couples async save state", async () => {
  const onSave = vi.fn().mockRejectedValueOnce(new Error("Disk failed")).mockResolvedValueOnce(undefined)
  const actor = createActor(projectWorkflowMachine, { input: { project, onSave } }).start()
  actor.send({ type: "EDIT", draft: { ...workflowDraft(project), setup: "changed" } })
  actor.send({ type: "APPROVE", approved: true })
  actor.send({ type: "SAVE" })
  expect(actor.getSnapshot().matches("saving")).toBe(true)
  actor.send({ type: "EDIT", draft: workflowDraft(project) })
  await vi.waitFor(() => expect(actor.getSnapshot().context.message).toBe("Disk failed"))
  expect(actor.getSnapshot().context.draft.setup).toBe("changed")
  actor.send({ type: "SAVE" })
  await vi.waitFor(() => expect(actor.getSnapshot().context.error).toBe(false))
  expect(onSave).toHaveBeenCalledTimes(2)
  expect(onSave.mock.calls[0]).toEqual(onSave.mock.calls[1])
  actor.stop()
})
it("persists edited drafts without granting execution approval", async () => {
  const onSave = vi.fn()
  const actor = createActor(projectWorkflowMachine, { input: { project, onSave } }).start()
  actor.send({ type: "EDIT", draft: { ...workflowDraft(project), setup: "changed setup" } })
  actor.send({ type: "SAVE" })
  await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
    projectId: project.id, setup: "changed setup", approve: false,
  })))
  await vi.waitFor(() => expect(actor.getSnapshot().context.message).toBe("Saved without approval. Commands will not run."))
  expect(actor.getSnapshot().context.approved).toBe(false)
  actor.stop()
})
it("preserves consent for no-op edits and revokes it for real edits", () => {
  const actor = createActor(projectWorkflowMachine, { input: { project, onSave: vi.fn() } }).start()
  const draft = actor.getSnapshot().context.draft
  actor.send({ type: "EDIT", draft: { ...draft } })
  expect(actor.getSnapshot().context.approved).toBe(true)
  actor.send({ type: "EDIT", draft: { ...draft, setup: "changed setup" } })
  expect(actor.getSnapshot().context.approved).toBe(false)
  actor.stop()
})
it("preserves unchanged command IDs and rejects unsafe payloads before invoking persistence", () => {
  const draft = workflowDraft(project)
  const payload = workflowPayload(project.id, { ...draft, runs: [...draft.runs].reverse() }, true)
  expect(payload.runs.map((run) => run.id)).toEqual(["test-id", "dev-id"])
  for (const path of ["../file", "/file", ".git/config", "C:/file", "dir\\file"])
    expect(() => workflowPayload(project.id, { ...draft, copyFiles: path }, true)).toThrow(/safe relative/)
})
it("loads shared review drafts, revokes consent and does not save until explicitly requested", async () => {
  const onSave = vi.fn()
  const onReadConfig = vi.fn(async () => ({ version: 1 as const, workflow: { setup: "shared command", runs: [], copyFiles: [] } }))
  const actor = createActor(projectWorkflowMachine, { input: { project, onSave, onReadConfig } }).start()
  const saved = JSON.stringify(project)
  actor.send({ type: "LOAD_CONFIG" })
  expect(actor.getSnapshot().matches("readingConfig")).toBe(true)
  await vi.waitFor(() => expect(actor.getSnapshot().context.draft.setup).toBe("shared command"))
  expect(actor.getSnapshot().context.approved).toBe(false)
  expect(onSave).not.toHaveBeenCalled()
  expect(JSON.stringify(project)).toBe(saved)
  actor.send({ type: "SAVE" })
  await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ setup: "shared command", approve: false })))
  actor.stop()
})
it("stops the old project's config actor so a late result cannot overwrite the selected project", async () => {
  let resolve!: (value: { version: 1; workflow: { setup: string; runs: []; copyFiles: [] } }) => void
  const onReadConfig = vi.fn(() => new Promise<{ version: 1; workflow: { setup: string; runs: []; copyFiles: [] } }>((done) => { resolve = done }))
  const onConfigLoaded = vi.fn()
  const old = createActor(projectWorkflowMachine, { input: { project, onSave: vi.fn(), onReadConfig, onConfigLoaded } }).start()
  old.send({ type: "LOAD_CONFIG" })
  old.stop() // Project editor is keyed by selected local project.
  const next = createActor(projectWorkflowMachine, { input: { project: settingsProjects[1]!, onSave: vi.fn(), onReadConfig } }).start()
  resolve({ version: 1, workflow: { setup: "old result", runs: [], copyFiles: [] } })
  await new Promise((done) => setTimeout(done, 0))
  expect(next.getSnapshot().context.draft.setup).toBe("")
  expect(onConfigLoaded).not.toHaveBeenCalled()
  next.stop()
})
