// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { ProviderCatalog } from "@jingler/core"
import {
  settingsDocument,
  settingsModels,
  settingsProjects,
} from "../../../../packages/ui/src/composites/project-settings-fixtures.js"
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
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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
