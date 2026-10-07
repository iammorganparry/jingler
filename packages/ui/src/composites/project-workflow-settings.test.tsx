import { useState } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Project } from "@jingler/core"
import { ProjectWorkflowSettings } from "./project-workflow-settings.js"
const project: Project = {
  id: "p-1",
  imported: true,
  name: "widget",
  path: "/repos/widget",
  availability: "available",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}
afterEach(cleanup)
const approve = () => fireEvent.click(screen.getByRole("checkbox"))
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save workflow" }))
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
const addRun = (name: string, command: string, index = 1) => {
  fireEvent.click(screen.getByRole("button", { name: "Add run command" }))
  change(`Run name ${index}`, name)
  change(`Run command ${index}`, command)
}
describe("ProjectWorkflowSettings", () => {
  it("invalidates visible approval after content changes and submits exact commands", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<ProjectWorkflowSettings projects={[project]} onSave={onSave} />)
    change("Setup command", "pnpm install")
    addRun("Dev", "pnpm dev")
    change("Copied files", ".env.local")
    approve()
    save()
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        projectId: "p-1",
        setup: "pnpm install",
        runs: [{ id: expect.stringMatching(/^run-/), label: "Dev", command: "pnpm dev" }],
        copyFiles: [".env.local"],
        ports: { primary: 3100, extras: [], previewUrl: "http://localhost:{port}" },
        approve: true,
      }),
    )
    await screen.findByText("Saved and approved for this exact content.")
    change("Setup command", "pnpm install --frozen-lockfile")
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false")
  })
  it("keeps partial port text editable and parses only when saving", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<ProjectWorkflowSettings projects={[project]} onSave={onSave} />)
    fireEvent.click(screen.getByRole("button", { name: "Add service port" }))
    change("Service name 1", "API")
    change("Service port 1", "46000")
    expect(screen.getByLabelText("Service port 1")).toHaveProperty("value", "46000")
    approve()
    save()
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          ports: expect.objectContaining({ extras: [{ name: "API", start: 46000 }] }),
        }),
      ),
    )
    await screen.findByText("Saved and approved for this exact content.")
    onSave.mockClear()
    change("Service port 1", "")
    approve()
    save()
    await screen.findByText(/Ports must be whole numbers/)
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByLabelText("Service port 1")).toHaveProperty("value", "")
  })
  it("rejects incomplete rows without saving partial commands", async () => {
    const onSave = vi.fn()
    render(<ProjectWorkflowSettings projects={[project]} onSave={onSave} />)
    addRun("Dev", "pnpm dev")
    addRun("Broken", "", 2)
    approve()
    save()
    await screen.findByText(/Run command row 2 needs/)
    expect(onSave).not.toHaveBeenCalled()
  })
  it("preserves identities when commands reorder and never recycles removed IDs", async () => {
    const onSave = vi.fn()
    const configured = {
      ...project,
      workflow: {
        runs: [
          { id: "dev-id", label: "Dev", command: "pnpm dev" },
          { id: "test-id", label: "Test", command: "pnpm test" },
        ],
        copyFiles: [],
      },
    }
    render(<ProjectWorkflowSettings projects={[configured]} onSave={onSave} />)
    fireEvent.click(screen.getByRole("button", { name: "Move run command 2 up" }))
    approve()
    save()
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: [
            { id: "test-id", label: "Test", command: "pnpm test" },
            { id: "dev-id", label: "Dev", command: "pnpm dev" },
          ],
        }),
      ),
    )
    await screen.findByText("Saved and approved for this exact content.")
    onSave.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "Remove run command 2" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove run command 1" }))
    addRun("New", "pnpm new")
    approve()
    save()
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: [{ id: expect.stringMatching(/^run-/), label: "New", command: "pnpm new" }],
        }),
      ),
    )
  })
  it("saves unapproved drafts without execution consent and revokes on row additions and deletions", async () => {
    const onSave = vi.fn()
    render(<ProjectWorkflowSettings projects={[project]} onSave={onSave} />)
    save()
    await screen.findByText("Saved without approval. Commands will not run.")
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ projectId: project.id, approve: false }))
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false")
    approve()
    fireEvent.click(screen.getByRole("button", { name: "Add run command" }))
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false")
    approve()
    fireEvent.click(screen.getByRole("button", { name: "Remove run command 1" }))
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false")
    approve()
    fireEvent.click(screen.getByRole("button", { name: "Add service port" }))
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false")
    approve()
    fireEvent.click(screen.getByRole("button", { name: "Remove service port 1" }))
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false")
  })
  it("switches the shared project and isolates late save feedback", async () => {
    let finish: (() => void) | undefined
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const second = {
      ...project,
      id: "p-2",
      name: "other",
      workflow: { setup: "other setup", runs: [], copyFiles: [] },
    }
    const routines = vi.fn((id: string) => <p>Routines owner: {id}</p>)
    render(
      <ProjectWorkflowSettings
        projects={[project, second, { ...project, id: "remote", name: "Remote", environmentId: "host" }]}
        onSave={onSave}
        routines={routines}
      />,
    )
    change("Setup command", "first setup")
    approve()
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p-1" })))
    fireEvent.click(screen.getByRole("button", { name: "Local project" }))
    expect(screen.queryByRole("option", { name: "Remote" })).toBeNull()
    fireEvent.click(screen.getByRole("option", { name: "other" }))
    expect(screen.getByLabelText("Setup command")).toHaveProperty("value", "other setup")
    expect(screen.getByText("Routines owner: p-2")).toBeTruthy()
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false")
    finish?.()
    await waitFor(() => expect(screen.queryByText("Saved and approved for this exact content.")).toBeNull())
  })
  it("keeps the draft after failed save and retries safely", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error("Disk unavailable"))
      .mockResolvedValueOnce(undefined)
    render(<ProjectWorkflowSettings projects={[project]} onSave={onSave} />)
    change("Setup command", "pnpm install")
    approve()
    save()
    await screen.findByRole("alert")
    expect(screen.getByLabelText("Setup command")).toHaveProperty("value", "pnpm install")
    save()
    await screen.findByText("Saved and approved for this exact content.")
    expect(onSave).toHaveBeenCalledTimes(2)
  })
  it("rejects unsafe copies, duplicate names and invalid primary ports", async () => {
    const onSave = vi.fn()
    render(<ProjectWorkflowSettings projects={[project]} onSave={onSave} />)
    change("Copied files", "../secret")
    approve()
    save()
    await screen.findByText(/safe relative paths/)
    expect(onSave).not.toHaveBeenCalled()
    change("Copied files", "")
    change("Starting app port", "80")
    approve()
    save()
    await screen.findByText(/Ports must be whole numbers/)
    expect(onSave).not.toHaveBeenCalled()
    change("Starting app port", "3100")
    fireEvent.click(screen.getByRole("button", { name: "Add service port" }))
    change("Service name 1", "API")
    change("Service port 1", "4000")
    fireEvent.click(screen.getByRole("button", { name: "Add service port" }))
    change("Service name 2", "api")
    change("Service port 2", "4001")
    approve()
    save()
    await screen.findByText(/port names must be unique/)
    expect(onSave).not.toHaveBeenCalled()
  })
})

it("pins the first asynchronously loaded project and preserves both drafts across reorder", () => {
  function RoutineDraft({ id }: { id: string }) {
    const [value, setValue] = useState("")
    return <input aria-label="Routine draft" data-owner={id} value={value} onChange={(event) => setValue(event.currentTarget.value)} />
  }
  const other = { ...project, id: "p-2", name: "other" }
  const routines = (id: string) => <RoutineDraft key={id} id={id} />
  const onSave = vi.fn()
  const rendered = render(<ProjectWorkflowSettings projects={[]} onSave={onSave} routines={routines} />)
  rendered.rerender(<ProjectWorkflowSettings projects={[project, other]} onSave={onSave} routines={routines} />)
  change("Setup command", "unsaved setup")
  change("Routine draft", "unsaved routine")
  rendered.rerender(<ProjectWorkflowSettings projects={[other, project]} onSave={onSave} routines={routines} />)
  expect(screen.getByRole("button", { name: "Local project" }).textContent).toContain("widget")
  expect(screen.getByLabelText("Setup command")).toHaveProperty("value", "unsaved setup")
  expect(screen.getByLabelText("Routine draft")).toHaveProperty("value", "unsaved routine")
  rendered.rerender(<ProjectWorkflowSettings projects={[other]} onSave={onSave} routines={routines} />)
  expect(screen.getByRole("button", { name: "Local project" }).textContent).toContain("other")
  expect(screen.getByLabelText("Routine draft")).toHaveProperty("value", "")
})
