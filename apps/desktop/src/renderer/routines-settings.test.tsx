// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { ProviderCatalog } from "@jingler/core"
import {
  settingsDocument,
  settingsModels,
  settingsProjects,
} from "../../../../packages/ui/src/composites/project-settings-fixtures.js"
import { ProjectWorkflowSettings } from "@jingler/ui"
import { RoutinesSettings } from "./routines-settings.js"
const mock = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  enable: vi.fn(),
  delete: vi.fn(),
  runNow: vi.fn(),
  cancel: vi.fn(),
}))
vi.mock("./rpc-client.js", () => ({
  rpc: {
    routinesList: mock.list,
    routinesSave: mock.save,
    routinesEnable: mock.enable,
    routinesDelete: mock.delete,
    routinesRunNow: mock.runNow,
    routinesCancel: mock.cancel,
  },
}))
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
  vi.resetAllMocks()
  vi.useRealTimers()
})
const catalog: ProviderCatalog = {
  refreshedAt: "2026-10-01T00:00:00.000Z",
  stale: false,
  connections: [{ connection: settingsModels[0]!.connection, models: settingsModels }],
}
it("keeps failed-save errors with their project while preserving the draft and history", async () => {
  mock.list.mockResolvedValue(settingsDocument)
  let fail: ((error: Error) => void) | undefined
  mock.save.mockImplementation(
    () =>
      new Promise((_, reject) => {
        fail = reject
      }),
  )
  const onSession = vi.fn(async () => {})
  const { rerender } = render(
    <RoutinesSettings
      projects={settingsProjects}
      projectId="widget"
      catalog={catalog}
      onSession={onSession}
    />,
  )
  fireEvent.click(await screen.findByRole("button", { name: "Edit Inspect Widget" }))
  fireEvent.change(screen.getByLabelText("Name", { exact: true }), { target: { value: "Retry draft" } })
  fireEvent.click(screen.getByRole("checkbox", { name: /I approve these exact settings/ }))
  fireEvent.click(screen.getByRole("button", { name: "Save routine" }))
  await waitFor(() =>
    expect(mock.save).toHaveBeenCalledWith(
      "routine-widget",
      expect.objectContaining({ projectId: "widget", name: "Retry draft" }),
    ),
  )
  rerender(
    <RoutinesSettings projects={settingsProjects} projectId="api" catalog={catalog} onSession={onSession} />,
  )
  await act(async () => {
    fail?.(new Error("Widget save failed"))
  })
  await waitFor(() => expect(screen.queryByText("Widget save failed")).toBeNull())
  expect(screen.getByLabelText("Name", { exact: true })).toHaveProperty("value", "")
  expect(screen.getByRole("heading", { name: "All-project run history" })).toBeTruthy()
  rerender(
    <RoutinesSettings
      projects={settingsProjects}
      projectId="widget"
      catalog={catalog}
      onSession={onSession}
    />,
  )
  await screen.findByText("Widget save failed")
})

it("keeps late routine save feedback and editor selection with the owning project", async () => {
  mock.list.mockResolvedValue(settingsDocument)
  let finish: (() => void) | undefined
  mock.save.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(settingsDocument)
      }),
  )
  const onSession = vi.fn(async () => {})
  const { rerender } = render(
    <RoutinesSettings
      projects={settingsProjects}
      projectId="widget"
      catalog={catalog}
      onSession={onSession}
    />,
  )
  fireEvent.click(await screen.findByRole("button", { name: "Edit Inspect Widget" }))
  fireEvent.click(screen.getByRole("checkbox", { name: /I approve these exact settings/ }))
  fireEvent.click(screen.getByRole("button", { name: "Save routine" }))
  await waitFor(() => expect(mock.save).toHaveBeenCalledOnce())
  rerender(
    <RoutinesSettings projects={settingsProjects} projectId="api" catalog={catalog} onSession={onSession} />,
  )
  await act(async () => {
    finish?.()
  })
  expect(screen.queryByText("Routine saved and approved for these exact settings.")).toBeNull()
  expect(screen.getByLabelText("Name", { exact: true })).toHaveProperty("value", "")
  expect(screen.getByRole("button", { name: "Edit Inspect API" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Edit Inspect Widget" })).toBeNull()
  rerender(
    <RoutinesSettings
      projects={settingsProjects}
      projectId="widget"
      catalog={catalog}
      onSession={onSession}
    />,
  )
  expect(screen.getByText("Routine saved and approved for these exact settings.")).toBeTruthy()
})

it.each([false, true])("keeps a %s existing-list editor stable through a delayed poll", async (existing) => {
  const document = existing ? settingsDocument : { version: 1 as const, routines: [], runs: [] }
  let finish!: (value: typeof document) => void
  mock.list.mockResolvedValueOnce(document).mockImplementationOnce(
    () => new Promise((resolve) => { finish = resolve }),
  )
  vi.useFakeTimers()
  await act(async () => {
    render(<RoutinesSettings projects={settingsProjects} projectId="widget" catalog={catalog} onSession={vi.fn()} />)
  })
  if (existing) fireEvent.click(screen.getByRole("button", { name: "Edit Inspect Widget" }))
  else expect(screen.getByText("No saved routines for this project.")).toBeTruthy()
  const name = screen.getByLabelText("Name", { exact: true })
  fireEvent.change(name, { target: { value: "Retained draft" } })
  const prompt = screen.getByLabelText("Prompt", { exact: true })
  fireEvent.change(prompt, { target: { value: "Inspect README" } })
  const approval = screen.getByRole("checkbox", { name: /I approve these exact settings/ })
  fireEvent.click(approval)
  name.focus()
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(mock.list).toHaveBeenCalledTimes(2)
    expect(name).toHaveProperty("disabled", false)
    expect(document === settingsDocument ? screen.getByRole("button", { name: "Edit Inspect Widget" }) : name).toHaveProperty("disabled", false)
    expect(screen.getByRole("button", { name: "Save routine" })).toHaveProperty("disabled", false)
    expect(screen.queryByText("Saving…")).toBeNull()
    expect(name).toHaveProperty("value", "Retained draft")
    expect(globalThis.document.activeElement).toBe(name)
    expect(approval.getAttribute("aria-checked")).toBe("true")
    await act(async () => { finish({ ...document, runs: settingsDocument.runs }) })
    expect(name).toHaveProperty("value", "Retained draft")
    expect(globalThis.document.activeElement).toBe(name)
    expect(approval.getAttribute("aria-checked")).toBe("true")
    expect(screen.getByText(/Inspection complete/)).toBeTruthy()
  } finally {
    vi.useRealTimers()
  }
})

const switchProject = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Local project" }))
  fireEvent.click(screen.getByRole("option", { name }))
}
it.each(["SAVE", "CANCEL"] as const)("preserves global history and pending %s through the real settings project switch", async (command) => {
  mock.list.mockResolvedValue(settingsDocument)
  let finish!: (value: typeof settingsDocument) => void
  const operation = command === "SAVE" ? mock.save : mock.cancel
  operation.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  render(<ProjectWorkflowSettings projects={settingsProjects} onSave={vi.fn()} routines={(id, templates) =>
    <RoutinesSettings projects={settingsProjects} projectId={id} templates={templates} catalog={catalog} onSession={vi.fn()} />
  } />)
  fireEvent.click(await screen.findByRole("button", { name: "Edit Inspect Widget" }))
  if (command === "SAVE") {
    fireEvent.click(screen.getByRole("checkbox", { name: /I approve these exact settings/ }))
    fireEvent.click(screen.getByRole("button", { name: "Save routine" }))
  } else fireEvent.click(screen.getByRole("button", { name: /Cancel/ }))
  await waitFor(() => expect(operation).toHaveBeenCalledOnce())
  const history = screen.getByRole("heading", { name: "All-project run history" })
  switchProject(settingsProjects[1]!.name)
  expect(screen.getByRole("heading", { name: "All-project run history" })).toBe(history)
  expect(screen.getByText((text) => text.includes("Inspection complete"))).toBeTruthy()
  expect(screen.getByRole("button", { name: "Open workspace Old inspection" })).toBeTruthy()
  expect(within(screen.getByRole("form", { name: "Save routine" })).getByLabelText("Name", { exact: true })).toHaveProperty("value", "")
  expect(within(screen.getByRole("form", { name: "Save routine" })).getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true)
  expect(mock.list).toHaveBeenCalledTimes(1)
  await act(async () => { finish({ ...settingsDocument, runs: settingsDocument.runs.map((run) => ({ ...run, message: "Operation completed" })) }) })
  expect(screen.getAllByText((text) => text.includes("Operation completed"))).toHaveLength(2)
  expect(screen.getByRole("button", { name: "Save routine" })).toHaveProperty("disabled", false)
  expect(mock.list).toHaveBeenCalledTimes(1)
})
it("binds imported template drafts to their owner across settings switches", async () => {
  mock.list.mockResolvedValue(settingsDocument)
  const template = { id: "shared", name: "Shared inspection", prompt: "Inspect", baseBranch: "main", reasoning: null, schedule: { kind: "once" as const, at: 0 }, maxDurationMs: 60000 }
  render(<ProjectWorkflowSettings projects={settingsProjects} onSave={vi.fn()} onReadConfig={async () => ({ version: 1, routines: [template] })} routines={(id, templates) =>
    <RoutinesSettings projects={settingsProjects} projectId={id} templates={templates} catalog={catalog} onSession={vi.fn()} />
  } />)
  await screen.findByRole("button", { name: "Edit Inspect Widget" })
  fireEvent.click(screen.getByRole("button", { name: "Load .jingler/project.json" }))
  fireEvent.click(await screen.findByRole("button", { name: /Shared inspection/ }))
  expect(within(screen.getByRole("form", { name: "Save routine" })).getByLabelText("Name", { exact: true })).toHaveProperty("value", "Shared inspection")
  switchProject(settingsProjects[1]!.name)
  expect(within(screen.getByRole("form", { name: "Save routine" })).getByLabelText("Name", { exact: true })).toHaveProperty("value", "")
  expect(screen.queryByRole("button", { name: /Shared inspection/ })).toBeNull()
  expect(mock.list).toHaveBeenCalledTimes(1)
})
