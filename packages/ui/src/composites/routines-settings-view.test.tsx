import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RoutinesSettingsViewProps } from "./routines-settings-view.js"
import { RoutinesSettingsView } from "./routines-settings-view.js"
import {
  settingsDocument,
  settingsModels,
  settingsProjects,
  settingsRoutine,
} from "./project-settings-fixtures.js"
import { localDateTime, routineDraft, routinePayload } from "./routine-form-machine.js"
afterEach(cleanup)
const props = (): RoutinesSettingsViewProps => ({
  projects: settingsProjects,
  projectId: "widget",
  models: settingsModels,
  document: settingsDocument,
  busy: false,
  loading: false,
  error: null,
  onEdit: vi.fn(),
  onSave: vi.fn(),
  onEnable: vi.fn(),
  onDelete: vi.fn(),
  onRun: vi.fn(),
  onCancel: vi.fn(),
  onOpen: vi.fn(),
  onRefresh: vi.fn(),
})
const consent = () => screen.getByRole("checkbox", { name: /I approve these exact settings/ })
const approve = () => fireEvent.click(consent())
const choose = (label: string, option: string) => {
  fireEvent.click(screen.getByRole("button", { name: label }))
  fireEvent.click(screen.getByRole("option", { name: option }))
}
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } })
describe("RoutinesSettingsView", () => {
  it("uses the shared project for list/editor and preserves all-project orphan history actions", () => {
    const input = props()
    const { rerender } = render(<RoutinesSettingsView {...input} editing="routine-widget" />)
    expect(screen.getByLabelText("Name", { exact: true })).toHaveProperty("value", "Inspect Widget")
    expect(screen.queryByRole("button", { name: "Edit Inspect API" })).toBeNull()
    expect(screen.getByText("All-project run history")).toBeTruthy()
    expect(screen.getByText("Deleted routine")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Cancel Old inspection" }))
    expect(input.onCancel).toHaveBeenCalledWith("run-orphan")
    fireEvent.click(screen.getByRole("button", { name: "Open workspace Old inspection" }))
    expect(input.onOpen).toHaveBeenCalledWith("s_storyorphan")
    approve()
    rerender(<RoutinesSettingsView {...input} projectId="api" editing="routine-widget" />)
    expect(screen.getByLabelText("Name", { exact: true })).toHaveProperty("value", "")
    expect(consent().getAttribute("aria-checked")).toBe("false")
    expect(screen.getByRole("button", { name: "Edit Inspect API" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Edit Inspect Widget" })).toBeNull()
    expect(screen.getByRole("button", { name: "Cancel Old inspection" })).toBeTruthy()
    expect(screen.getByText("Widget")).toBeTruthy()
  })
  it("guards saves and revokes consent on every real custom-control edit", () => {
    const input = props()
    render(<RoutinesSettingsView {...input} editing="routine-widget" />)
    fireEvent.click(screen.getByRole("button", { name: "Save routine" }))
    expect(input.onSave).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toMatch(/Approve/)
    expect(screen.queryByLabelText("Interval minutes")).toBeNull()
    approve()
    choose("Schedule", "Fixed interval")
    expect(consent().getAttribute("aria-checked")).toBe("false")
    expect(screen.getByLabelText("Interval minutes")).toHaveProperty("value", "60")
    approve()
    choose("Reasoning", "high")
    expect(consent().getAttribute("aria-checked")).toBe("false")
    approve()
    choose("Managed Pi model", "openai · model-two")
    expect(consent().getAttribute("aria-checked")).toBe("false")
    approve()
    fireEvent.click(screen.getByRole("switch", { name: "Enable schedule" }))
    expect(consent().getAttribute("aria-checked")).toBe("false")
    approve()
    change("Name", "Edited routine")
    expect(consent().getAttribute("aria-checked")).toBe("false")
    approve()
    fireEvent.click(screen.getByRole("button", { name: "Save routine" }))
    expect(input.onSave).toHaveBeenCalledWith(
      "routine-widget",
      expect.objectContaining({
        projectId: "widget",
        name: "Edited routine",
        modelId: "model-two",
        enabled: true,
        mode: "ask",
        approved: true,
        reasoning: { enabled: true, effort: "high" },
        schedule: { kind: "interval", at: settingsRoutine.schedule.at, everyMs: 3600000 },
      }),
    )
  })
  it("retains unavailable saved-model identity and requires explicit replacement", () => {
    const input = { ...props(), models: [settingsModels[1]!] }
    render(<RoutinesSettingsView {...input} editing="routine-widget" />)
    expect(screen.getByRole("button", { name: "Managed Pi model" }).textContent).toContain(
      "Unavailable saved model: model-one",
    )
    approve()
    fireEvent.click(screen.getByRole("button", { name: "Save routine" }))
    expect(input.onSave).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toMatch(/saved model is unavailable/)
    choose("Managed Pi model", "openai · model-two")
    expect(consent().getAttribute("aria-checked")).toBe("false")
    approve()
    fireEvent.click(screen.getByRole("button", { name: "Save routine" }))
    expect(input.onSave).toHaveBeenCalledWith(
      "routine-widget",
      expect.objectContaining({ modelId: "model-two" }),
    )
  })
  it("preserves exact saved datetime precision and validates payload boundaries", () => {
    const draft = routineDraft({ selected: settingsRoutine, models: settingsModels })
    expect(draft.at).toBe(localDateTime(settingsRoutine.schedule.at))
    expect(routinePayload(draft, true, "widget", settingsModels, settingsRoutine).schedule.at).toBe(
      settingsRoutine.schedule.at,
    )
    expect(() => routinePayload(draft, false, "widget", settingsModels, settingsRoutine)).toThrow(/Approve/)
    expect(() => routinePayload(draft, true, "api", settingsModels, settingsRoutine)).toThrow(/local project/)
    for (const patch of [
      { name: "" },
      { prompt: " " },
      { at: "invalid" },
      { duration: "0" },
      { duration: "1441" },
      { schedule: "interval", interval: "0" },
      { reasoning: "unsafe" },
    ])
      expect(() =>
        routinePayload({ ...draft, ...patch }, true, "widget", settingsModels, settingsRoutine),
      ).toThrow()
    expect(
      routinePayload({ ...draft, interval: "" }, true, "widget", settingsModels, settingsRoutine).schedule
        .kind,
    ).toBe("once")
  })
  it("retains enable, run, delete, retry and health actions without changing IDs", () => {
    const input = {
      ...props(),
      error: "Failed to load",
      document: {
        ...settingsDocument,
        health: { error: "History damaged", recovery: "Retry after restoring the file" },
      },
    }
    render(<RoutinesSettingsView {...input} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Inspect Widget" }))
    expect(input.onEdit).toHaveBeenCalledWith("routine-widget")
    fireEvent.click(screen.getByRole("button", { name: "Enable Inspect Widget" }))
    expect(input.onEnable).toHaveBeenCalledWith("routine-widget", true)
    fireEvent.click(screen.getByRole("button", { name: "Run now Inspect Widget" }))
    expect(input.onRun).toHaveBeenCalledWith("routine-widget")
    fireEvent.click(screen.getByRole("button", { name: "Delete Inspect Widget" }))
    expect(input.onDelete).toHaveBeenCalledWith("routine-widget")
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    fireEvent.click(screen.getByRole("button", { name: "Refresh history and health" }))
    expect(input.onRefresh).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/History damaged/)).toBeTruthy()
  })
  it("retains the entered draft across an asynchronous failure and hides foreign feedback", () => {
    const input = props()
    const { rerender } = render(<RoutinesSettingsView {...input} editing="routine-widget" />)
    change("Name", "Unsaved retry")
    approve()
    fireEvent.click(screen.getByRole("button", { name: "Save routine" }))
    rerender(<RoutinesSettingsView {...input} editing="routine-widget" busy />)
    expect(screen.getByLabelText("Name", { exact: true })).toHaveProperty("value", "Unsaved retry")
    rerender(<RoutinesSettingsView {...input} editing="routine-widget" error="Save failed" />)
    expect(screen.getByLabelText("Name", { exact: true })).toHaveProperty("value", "Unsaved retry")
    expect(screen.getByRole("alert").textContent).toMatch(/Save failed/)
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(input.onRefresh).toHaveBeenCalledOnce()
  })
})
